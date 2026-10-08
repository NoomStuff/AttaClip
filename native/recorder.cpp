// SPDX-License-Identifier: GPL-2.0-or-later
// Mux protocol follows OBS Studio's ffmpeg-mux/ffmpeg-mux.h, Copyright Lain
// Bailey.
#include <algorithm>
#include <atomic>
#include <cmath>
#include <condition_variable>
#include <deque>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <json.hpp>
#include <mutex>
#include <obs.h>
#include <thread>
#include <util/pipe.h>
#include <util/platform.h>
#include <vector>
#ifdef _WIN32
#include <objbase.h>
#include <psapi.h>
#include <util/dstr.h>
#include <util/windows/window-helpers.h>
#include <windows.h>
#endif
using json = nlohmann::json;
std::mutex stdoutMutex;
void idleVideo() {
  obs_video_info info{};
  info.graphics_module = "libobs-d3d11.dll";
  info.fps_num = 1;
  info.fps_den = 1;
  info.base_width = 16;
  info.base_height = 16;
  info.output_width = 16;
  info.output_height = 16;
  info.output_format = VIDEO_FORMAT_NV12;
  info.gpu_conversion = true;
  info.colorspace = VIDEO_CS_709;
  info.range = VIDEO_RANGE_PARTIAL;
  obs_reset_video(&info);
}
void emit(json value) {
  std::lock_guard<std::mutex> lock(stdoutMutex);
  std::cout << value.dump() << std::endl;
}
void logger(int level, const char *format, va_list args, void *) {
  if (level <= LOG_INFO) {
    vfprintf(stderr, format, args);
    fputs("\n", stderr);
  }
}
struct Packet {
  encoder_packet p{};
  Packet(const encoder_packet &v) {
    auto copy = v;
    obs_encoder_packet_ref(&p, &copy);
  }
  Packet(Packet &&v) noexcept : p(v.p) { v.p = {}; }
  Packet(const Packet &v) {
    auto copy = v.p;
    obs_encoder_packet_ref(&p, &copy);
  }
  ~Packet() {
    if (p.data)
      obs_encoder_packet_release(&p);
  }
};
struct Request {
  std::string id, path, source;
  int64_t end;
};
struct Job {
  Request request;
  std::string source;
  std::vector<Packet> packets;
  std::vector<std::vector<uint8_t>> headers;
};
struct PacketInfo {
  int64_t pts, dts;
  uint32_t size, index;
  int type;
  bool keyframe;
};
class Recorder {
public:
  obs_output_t *output = nullptr;
  obs_encoder_t *video = nullptr;
  std::vector<obs_encoder_t *> audio;
  obs_scene_t *scene = nullptr;
  obs_source_t *capture = nullptr;
  obs_source_t *desktop = nullptr;
  obs_source_t *mic = nullptr;
  obs_sceneitem_t *item = nullptr;
  std::mutex mutex;
  std::condition_variable wake;
  std::deque<Packet> ring;
  std::deque<Request> requests;
  std::deque<Job> jobs;
  std::thread writer;
  bool quitting = false;
  std::atomic<bool> active{false};
  std::atomic<int> pending{0};
  std::atomic<uintptr_t> targetWindow{0};
  obs_volmeter_t *captureMeter = nullptr, *microphoneMeter = nullptr;
  struct MeterContext {
    Recorder *owner;
    bool microphone;
  } captureContext{this, false}, microphoneContext{this, true};
  std::atomic<float> captureLevel{0}, microphoneLevel{0};
  std::atomic<uint64_t> lastMeterEvent{0};
  float captureVolume = 1, microphoneVolume = 1;
  bool captureMuted = false, microphoneMuted = false, screenCapture = true,
       captureAudioEnabled = true;
  size_t bytes = 0;
  int seconds = 60, width = 1920, height = 1080, fps = 60;
  int64_t previousEnd = 0;
  bool avoidOverlap = false;
  std::string encoder, sourceName;
  Recorder() {
    captureMeter = obs_volmeter_create(OBS_FADER_LOG);
    microphoneMeter = obs_volmeter_create(OBS_FADER_LOG);
    auto callback = [](void *data, const float *, const float *peak,
                       const float *) {
      auto *context = static_cast<MeterContext *>(data);
      auto *r = context->owner;
      float value = 0;
      for (size_t i = 0; i < 2; i++)
        if (std::isfinite(peak[i]))
          value =
              std::max(value, std::clamp((peak[i] + 60.f) / 60.f, 0.f, 1.f));
      (context->microphone ? r->microphoneLevel : r->captureLevel) = value;
      uint64_t now = os_gettime_ns(), last = r->lastMeterEvent.load();
      if (r->active && now - last >= 200000000 &&
          r->lastMeterEvent.compare_exchange_strong(last, now)) {
        emit({{"event", "audio-levels"},
              {"capture", r->captureLevel.load()},
              {"microphone", r->microphoneLevel.load()}});
      }
    };
    obs_volmeter_add_callback(captureMeter, callback, &captureContext);
    obs_volmeter_add_callback(microphoneMeter, callback, &microphoneContext);
    writer = std::thread([this] { writeLoop(); });
  }
  ~Recorder() {
    stop();
    {
      std::lock_guard<std::mutex> lock(mutex);
      quitting = true;
    }
    wake.notify_all();
    writer.join();
    release();
    obs_volmeter_destroy(captureMeter);
    obs_volmeter_destroy(microphoneMeter);
  }
  void release() {
    obs_volmeter_detach_source(captureMeter);
    obs_volmeter_detach_source(microphoneMeter);
    captureLevel = 0;
    microphoneLevel = 0;
    if (output) {
      obs_output_release(output);
      output = nullptr;
    }
    if (video) {
      obs_encoder_release(video);
      video = nullptr;
    }
    for (auto *a : audio)
      obs_encoder_release(a);
    audio.clear();
    obs_set_output_source(0, nullptr);
    obs_set_output_source(1, nullptr);
    obs_set_output_source(2, nullptr);
    if (scene) {
      obs_scene_release(scene);
      scene = nullptr;
    }
    if (capture) {
      obs_source_release(capture);
      capture = nullptr;
    }
    if (desktop) {
      obs_source_release(desktop);
      desktop = nullptr;
    }
    if (mic) {
      obs_source_release(mic);
      mic = nullptr;
    }
    item = nullptr;
    obs_wait_for_destroy_queue();
  }
  void stop() {
    // Drain accepted requests to their original timestamps before stopping.
    for (int i = 0; i < 100 && active; i++) {
      {
        std::lock_guard<std::mutex> lock(mutex);
        if (requests.empty())
          break;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    active = false;
    {
      std::lock_guard<std::mutex> lock(mutex);
      for (auto &r : requests)
        snapshot(r);
      requests.clear();
    }
    if (output && obs_output_active(output))
      obs_output_force_stop(output);
    {
      std::lock_guard<std::mutex> lock(mutex);
      ring.clear();
      bytes = 0;
    }
    release();
    idleVideo();
  }
  bool targetAvailable() {
#ifdef _WIN32
    HWND window = reinterpret_cast<HWND>(targetWindow.load());
    if (window &&
        (!IsWindow(window) || IsIconic(window) || !IsWindowVisible(window)))
      return false;
#endif
    return true;
  }
  void setAudio(const json &c) {
    std::string source = c.at("source");
    float volume = c.at("volume");
    bool muted = c.at("muted");
    if (!std::isfinite(volume) || volume < 0 || volume > 2)
      throw std::runtime_error(
          "Audio volume must be between 0 and 200 percent");
    if (source == "capture") {
      captureVolume = volume;
      captureMuted = muted;
      obs_source_t *source = screenCapture ? desktop : capture;
      if (source) {
        obs_source_set_volume(source, volume);
        obs_source_set_muted(source, muted || !captureAudioEnabled);
      }
    } else if (source == "microphone") {
      microphoneVolume = volume;
      microphoneMuted = muted;
      if (mic) {
        obs_source_set_volume(mic, volume);
        obs_source_set_muted(mic, muted);
      }
    } else
      throw std::runtime_error("Unknown audio source");
  }
  void packets(encoder_packet *p) {
    if (!p) {
      active = false;
      {
        std::lock_guard<std::mutex> lock(mutex);
        for (auto &r : requests) {
          emit({{"event", "error"},
                {"requestId", r.id},
                {"message", "The encoder failed before this clip was ready"}});
          pending--;
        }
        requests.clear();
      }
      emit({{"event", "fatal"},
            {"message", "The recording encoder stopped producing footage"}});
      return;
    }
    if (!active)
      return;
    if (!targetAvailable()) {
      std::lock_guard<std::mutex> lock(mutex);
      for (auto &r : requests)
        snapshot(r);
      requests.clear();
      return;
    }
    std::lock_guard<std::mutex> lock(mutex);
    ring.emplace_back(*p);
    bytes += p->size;
    // Purge only at keyframes, keeping the retained GOP independently
    // decodable.
    int64_t cutoff = p->sys_dts_usec - int64_t(seconds) * 1000000;
    size_t boundary = 0;
    for (size_t i = 0; i < ring.size(); i++)
      if (ring[i].p.type == OBS_ENCODER_VIDEO && ring[i].p.keyframe &&
          ring[i].p.sys_dts_usec <= cutoff)
        boundary = i;
    while (boundary--) {
      bytes -= ring.front().p.size;
      ring.pop_front();
    }
    while (bytes > 512ULL * 1024 * 1024 && ring.size() > 1) {
      size_t next = 1;
      while (next < ring.size() &&
             !(ring[next].p.type == OBS_ENCODER_VIDEO && ring[next].p.keyframe))
        next++;
      if (next == ring.size())
        break;
      while (next--) {
        bytes -= ring.front().p.size;
        ring.pop_front();
      }
    }
    while (!requests.empty() && p->type == OBS_ENCODER_VIDEO &&
           p->sys_dts_usec >= requests.front().end) {
      snapshot(requests.front());
      requests.pop_front();
    }
  }
  void snapshot(const Request &r) {
    int64_t begin = r.end - int64_t(seconds) * 1000000;
    if (avoidOverlap)
      begin = std::max(begin, previousEnd);
    size_t start = ring.size();
    // Stream-copy boundaries must start on a keyframe. Keep at most one
    // preceding GOP.
    for (size_t i = 0; i < ring.size(); i++)
      if (ring[i].p.type == OBS_ENCODER_VIDEO && ring[i].p.keyframe &&
          ring[i].p.sys_dts_usec <= begin)
        start = i;
    if (start == ring.size())
      for (size_t i = 0; i < ring.size(); i++)
        if (ring[i].p.type == OBS_ENCODER_VIDEO && ring[i].p.keyframe) {
          start = i;
          break;
        }
    Job j;
    j.request = r;
    j.source = r.source;
    for (size_t i = start; i < ring.size(); i++)
      if (ring[i].p.sys_dts_usec <= r.end)
        j.packets.emplace_back(ring[i]);
    if (j.packets.empty()) {
      pending--;
      emit({{"event", "error"},
            {"requestId", r.id},
            {"message", "No recorded footage is available yet"}});
      return;
    }
    uint8_t *data;
    size_t size;
    obs_encoder_get_extra_data(video, &data, &size);
    j.headers.emplace_back(data, data + size);
    for (auto *a : audio) {
      obs_encoder_get_extra_data(a, &data, &size);
      j.headers.emplace_back(data, data + size);
    }
    jobs.emplace_back(std::move(j));
    wake.notify_all();
  }
  void save(const json &c) {
    std::lock_guard<std::mutex> lock(mutex);
    if (!active)
      throw std::runtime_error("Start recording before saving a clip");
    if (pending >= 3)
      throw std::runtime_error(
          "Three clips are already saving. Wait for a save to finish");
    if (bytes * size_t(pending + 2) > 768ULL * 1024 * 1024)
      throw std::runtime_error("The clip save queue has reached its memory "
                               "limit. Wait for a save to finish");
    auto wallMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                      std::chrono::system_clock::now().time_since_epoch())
                      .count();
    int64_t age =
        c.contains("requestedAt")
            ? std::max(int64_t(0),
                       int64_t(wallMs) - c.at("requestedAt").get<int64_t>())
            : c.value("requestAgeMs", int64_t(0));
    Request r{c.at("requestId"), c.at("path"), sourceName,
              int64_t(os_gettime_ns() / 1000) - age * 1000};
    pending++;
    requests.push_back(r);
    emit({{"event", "saving"}, {"requestId", r.id}});
    if (!targetAvailable()) {
      snapshot(requests.back());
      requests.pop_back();
    }
  }
  bool writePacket(os_process_pipe_t *pipe, encoder_packet &p, int64_t origin) {
    PacketInfo i{};
    i.pts = p.pts;
    i.dts = p.dts;
    i.size = uint32_t(p.size);
    i.index = uint32_t(p.track_idx);
    i.type = p.type == OBS_ENCODER_VIDEO ? 0 : 1;
    i.keyframe = p.keyframe;
    if (p.timebase_den > 1) {
      int64_t offset = origin * p.timebase_den / 1000000;
      i.pts -= offset;
      i.dts -= offset;
    }
    return os_process_pipe_write(pipe, reinterpret_cast<uint8_t *>(&i),
                                 sizeof(i)) == sizeof(i) &&
           os_process_pipe_write(pipe, p.data, p.size) == p.size;
  }
  void writeLoop() {
    for (;;) {
      Job j;
      {
        std::unique_lock<std::mutex> lock(mutex);
        wake.wait(lock, [this] { return quitting || !jobs.empty(); });
        if (jobs.empty() && quitting)
          return;
        j = std::move(jobs.front());
        jobs.pop_front();
      }
      bool okay = false;
      std::string temp = j.request.path + ".saving.mkv";
      auto *args = os_process_args_create("obs-ffmpeg-mux.exe");
      auto add = [&](std::string v) {
        os_process_args_add_arg(args, v.c_str());
      };
      add(temp);
      add("1");
      add(std::to_string(j.headers.size() - 1));
      add("h264");
      add("10000");
      add(std::to_string(width));
      add(std::to_string(height));
      for (auto v : {1, 1, 1, 1, 1, 0})
        add(std::to_string(v));
      add(std::to_string(fps));
      add("1");
      add("0");
      if (j.headers.size() > 1) {
        add("aac");
        for (size_t i = 1; i < j.headers.size(); i++) {
          add(i == 1 ? "Master" : i == 2 ? "Capture audio" : "Microphone");
          add("160");
          add("48000");
          add("1024");
          add("0");
          add("2");
        }
      }
      add("");
      add("");
      auto *pipe = os_process_pipe_create2(args, "w");
      os_process_args_destroy(args);
      if (pipe) {
        okay = true;
        for (size_t i = 0; i < j.headers.size(); i++) {
          encoder_packet p{};
          p.data = j.headers[i].data();
          p.size = j.headers[i].size();
          p.type = i ? OBS_ENCODER_AUDIO : OBS_ENCODER_VIDEO;
          p.track_idx = i ? i - 1 : 0;
          p.timebase_den = 1;
          if (!writePacket(pipe, p, 0))
            okay = false;
        }
        int64_t origin = j.packets.front().p.dts_usec;
        for (auto &p : j.packets)
          if (!writePacket(pipe, p.p, origin)) {
            okay = false;
            break;
          }
        int code = os_process_pipe_destroy(pipe);
        okay = okay && code == 0;
      }
      try {
        if (okay && std::filesystem::file_size(temp) > 1000) {
          if (std::filesystem::exists(j.request.path))
            throw std::runtime_error(
                "A file already exists at the clip destination. The existing "
                "file was preserved");
          std::filesystem::rename(temp, j.request.path);
          std::lock_guard<std::mutex> lock(mutex);
          previousEnd = j.request.end;
          emit({{"event", "saved"},
                {"requestId", j.request.id},
                {"path", j.request.path},
                {"source", j.source}});
        } else {
          emit({{"event", "error"},
                {"requestId", j.request.id},
                {"message", "The clip could not be finalized. Check free "
                            "storage and folder permissions"}});
        }
      } catch (const std::exception &e) {
        emit({{"event", "error"},
              {"requestId", j.request.id},
              {"message", e.what()}});
      }
      pending--;
    }
  }
  void source(const json &c) {
    std::string kind = c.value("sourceKind", "screen");
    auto *s = obs_data_create();
    obs_source_t *next = nullptr;
#ifdef _WIN32
    if (kind == "screen") {
      auto *props = obs_get_source_properties("monitor_capture");
      auto *p = obs_properties_get(props, "monitor_id");
      int index = c.value("screenIndex", 0);
      std::string monitor;
      if (c.contains("bounds") && c["bounds"].is_object()) {
        struct Match {
          RECT wanted;
          std::string identity;
        } match;
        auto b = c["bounds"];
        match.wanted = {b.at("x"), b.at("y"),
                        b.at("x").get<long>() + b.at("width").get<long>(),
                        b.at("y").get<long>() + b.at("height").get<long>()};
        EnumDisplayMonitors(
            nullptr, nullptr,
            [](HMONITOR h, HDC, LPRECT, LPARAM data) -> BOOL {
              auto *m = reinterpret_cast<Match *>(data);
              MONITORINFOEXA info{};
              info.cbSize = sizeof(info);
              if (GetMonitorInfoA(h, &info) &&
                  EqualRect(&m->wanted, &info.rcMonitor)) {
                DISPLAY_DEVICEA device{};
                device.cb = sizeof(device);
                if (EnumDisplayDevicesA(info.szDevice, 0, &device,
                                        EDD_GET_DEVICE_INTERFACE_NAME))
                  m->identity = device.DeviceID;
                else
                  m->identity = info.szDevice;
                return FALSE;
              }
              return TRUE;
            },
            reinterpret_cast<LPARAM>(&match));
        monitor = match.identity;
        if (monitor.empty()) {
          obs_properties_destroy(props);
          throw std::runtime_error("The selected screen changed or was "
                                   "disconnected. Select it again");
        }
      }
      for (size_t i = 0; monitor.empty() && i < obs_property_list_item_count(p);
           i++)
        if (!obs_property_list_item_disabled(p, i)) {
          if (index-- == 0) {
            monitor = obs_property_list_item_string(p, i);
            break;
          }
        }
      obs_properties_destroy(props);
      if (monitor.empty())
        throw std::runtime_error("The selected screen is unavailable");
      obs_data_set_string(s, "monitor_id", monitor.c_str());
      obs_data_set_bool(s, "capture_cursor", true);
      obs_data_set_bool(s, "force_sdr", true);
      next = obs_source_create_private("monitor_capture", "Capture", s);
    } else if (kind == "app") {
      std::string window = c.value("window", "");
      std::string sourceId = c.value("sourceId", "");
      if (sourceId.rfind("window:", 0) == 0) {
        HWND hwnd = reinterpret_cast<HWND>(std::stoull(sourceId.substr(7)));
        if (!IsWindow(hwnd) || IsIconic(hwnd) || !IsWindowVisible(hwnd))
          throw std::runtime_error("The selected application is unavailable");
        dstr title{}, klass{}, exe{};
        ms_get_window_title(&title, hwnd);
        ms_get_window_class(&klass, hwnd);
        if (!ms_get_window_exe(&exe, hwnd)) {
          dstr_free(&title);
          dstr_free(&klass);
          throw std::runtime_error(
              "The selected application cannot be identified safely");
        }
        for (auto *value : {&title, &klass, &exe}) {
          dstr_replace(value, "#", "#22");
          dstr_replace(value, ":", "#3A");
        }
        window = std::string(title.array ? title.array : "") + ":" +
                 (klass.array ? klass.array : "") + ":" +
                 (exe.array ? exe.array : "");
        dstr_free(&title);
        dstr_free(&klass);
        dstr_free(&exe);
        auto *props = obs_get_source_properties("window_capture");
        auto *p = obs_properties_get(props, "window");
        int matches = 0;
        for (size_t i = 0; i < obs_property_list_item_count(p); i++)
          if (window == obs_property_list_item_string(p, i))
            matches++;
        obs_properties_destroy(props);
        if (matches != 1)
          throw std::runtime_error(
              "The selected application cannot be distinguished safely. Rename "
              "its window or choose another source");
      }
      if (window.empty())
        throw std::runtime_error("The selected application is unavailable");
      obs_data_set_string(s, "window", window.c_str());
      obs_data_set_int(s, "method", 2);
      obs_data_set_int(s, "priority", 0);
      obs_data_set_bool(s, "cursor", true);
      obs_data_set_bool(s, "capture_audio", c.value("captureAudio", true));
      obs_data_set_bool(s, "force_sdr", true);
      next = obs_source_create_private("window_capture", "Capture", s);
    } else
      throw std::runtime_error(
          "Automatic game detection is not available in this recording backend "
          "yet. Choose Screen or App");
#else
    throw std::runtime_error(
        "Native capture on this platform is not yet implemented");
#endif
    obs_data_release(s);
    if (!next)
      throw std::runtime_error("The capture source could not be created");
    uintptr_t target = 0;
    if (kind == "app") {
      std::string id = c.value("sourceId", "");
      if (id.rfind("window:", 0) == 0)
        target = std::stoull(id.substr(7));
    }
    targetWindow = target;
    screenCapture = kind == "screen";
    captureAudioEnabled = c.value("captureAudio", true);
    obs_source_set_audio_mixers(next, 3);
    if (item)
      obs_sceneitem_remove(item);
    if (capture)
      obs_source_release(capture);
    capture = next;
    item = obs_scene_add(scene, capture);
    obs_sceneitem_set_bounds_type(item, OBS_BOUNDS_SCALE_INNER);
    vec2 bounds{float(width), float(height)};
    obs_sceneitem_set_bounds(item, &bounds);
    obs_sceneitem_set_bounds_alignment(item, OBS_ALIGN_CENTER);
    obs_sceneitem_set_alignment(item, OBS_ALIGN_CENTER);
    vec2 pos{width / 2.f, height / 2.f};
    obs_sceneitem_set_pos(item, &pos);
    {
      std::lock_guard<std::mutex> lock(mutex);
      sourceName = c.value("sourceName", "Screen");
    }
    if (desktop)
      obs_source_set_muted(desktop, kind != "screen" ||
                                        !c.value("captureAudio", true) ||
                                        captureMuted);
    obs_source_t *audioSource = screenCapture ? desktop : capture;
    if (audioSource) {
      obs_source_set_volume(audioSource, captureVolume);
      obs_source_set_muted(audioSource, captureMuted || !captureAudioEnabled);
      obs_volmeter_attach_source(captureMeter, audioSource);
    }
  }
  void start(const json &c) {
    if (active)
      throw std::runtime_error("Recording is already running");
    if (pending > 0)
      throw std::runtime_error(
          "Wait for clip saves to finish before restarting");
    if (c.value("avoidOverlap", false))
      throw std::runtime_error("Avoiding overlap is not available in this "
                               "recording backend yet. Turn it off to record");
    release();
    seconds = c.value("clipSeconds", 60);
    avoidOverlap = false;
    previousEnd = 0;
    std::string quality = c.value("quality", "standard");
    width = quality == "low" ? 1280 : quality == "high" ? 2560 : 1920;
    height = quality == "low" ? 720 : quality == "high" ? 1440 : 1080;
    fps = quality == "low" ? 30 : 60;
    int cq = quality == "high" ? 18 : 23;
    if (quality == "custom") {
      width = c.value("customWidth", 1920);
      height = c.value("customHeight", 1080);
      fps = c.value("customFPS", 60);
      cq = c.value("customCQ", 23);
      if (width < 64 || width > 7680 || height < 64 || height > 4320 ||
          width % 2 || height % 2 || fps < 1 || fps > 120 || cq < 12 || cq > 35)
        throw std::runtime_error("The custom recording profile is invalid");
    }
    obs_video_info vi{};
    vi.graphics_module = "libobs-d3d11.dll";
    vi.fps_num = fps;
    vi.fps_den = 1;
    vi.base_width = width;
    vi.base_height = height;
    vi.output_width = width;
    vi.output_height = height;
    vi.output_format = VIDEO_FORMAT_NV12;
    vi.gpu_conversion = true;
    vi.colorspace = VIDEO_CS_709;
    vi.range = VIDEO_RANGE_PARTIAL;
    vi.scale_type = OBS_SCALE_BICUBIC;
    if (obs_reset_video(&vi) != OBS_VIDEO_SUCCESS)
      throw std::runtime_error(
          "The graphics driver could not initialize recording");
    scene = obs_scene_create_private("Recording");
    obs_set_output_source(0, obs_scene_get_source(scene));
    auto *d = obs_data_create();
    obs_data_set_string(d, "device_id", "default");
    desktop =
        obs_source_create_private("wasapi_output_capture", "Capture audio", d);
    obs_data_release(d);
    if (desktop) {
      obs_source_set_audio_mixers(desktop, 3);
      obs_set_output_source(1, desktop);
    }
    if (c.value("microphone", false)) {
      d = obs_data_create();
      auto *props = obs_get_source_properties("wasapi_input_capture");
      auto *devices = obs_properties_get(props, "device_id");
      bool found = false;
      std::string requested =
          c.value("microphoneDevice", std::string("default"));
      for (size_t i = 0; i < obs_property_list_item_count(devices); i++)
        if (requested == obs_property_list_item_string(devices, i))
          found = true;
      obs_properties_destroy(props);
      if (!found) {
        obs_data_release(d);
        throw std::runtime_error("The selected microphone is unavailable. "
                                 "Choose an available microphone in Settings");
      }
      obs_data_set_string(
          d, "device_id",
          c.value("microphoneDevice", std::string("default")).c_str());
      mic = obs_source_create_private("wasapi_input_capture", "Microphone", d);
      obs_data_release(d);
      if (!mic)
        throw std::runtime_error("The microphone could not be opened");
      obs_source_set_audio_mixers(mic, 5);
      obs_set_output_source(2, mic);
      obs_source_set_volume(mic, microphoneVolume);
      obs_source_set_muted(mic, microphoneMuted);
      obs_volmeter_attach_source(microphoneMeter, mic);
    }
    source(c);
    captureVolume = c.value("captureVolume", 1.f);
    microphoneVolume = c.value("microphoneVolume", 1.f);
    captureMuted = c.value("captureMuted", false);
    microphoneMuted = c.value("microphoneMuted", false);
    setAudio({{"source", "capture"},
              {"volume", captureVolume},
              {"muted", captureMuted}});
    setAudio({{"source", "microphone"},
              {"volume", microphoneVolume},
              {"muted", microphoneMuted}});
    d = obs_data_create();
    obs_data_set_string(d, "rate_control", "CQP");
    obs_data_set_int(d, "cqp", cq);
    obs_data_set_string(d, "preset", "p4");
    obs_data_set_int(d, "keyint_sec", 1);
    obs_data_set_int(d, "bf", 0);
    const char *id = nullptr;
    encoder.clear();
    for (size_t i = 0; obs_enum_encoder_types(i, &id); i++)
      if (std::string(id) == "obs_nvenc_h264_tex" ||
          std::string(id) == "obs_nvenc_h264")
        encoder = id;
    if (encoder.empty() && c.value("allowSoftwareEncoder", false)) {
      for (size_t i = 0; obs_enum_encoder_types(i, &id); i++)
        if (std::string(id) == "obs_x264")
          encoder = id;
      if (!encoder.empty()) {
        obs_data_set_string(d, "rate_control", "CRF");
        obs_data_set_int(d, "crf", cq);
        obs_data_set_string(d, "preset", "veryfast");
        obs_data_set_string(d, "x264opts", "bframes=0");
      }
    }
    if (encoder.empty())
      throw std::runtime_error(
          "No supported hardware H.264 encoder is available. Software "
          "recording is not silently enabled");
    video = obs_video_encoder_create(encoder.c_str(), "Video", d, nullptr);
    obs_data_release(d);
    if (!video)
      throw std::runtime_error("The hardware encoder could not be created");
    obs_encoder_set_video(video, obs_get_video());
    output = obs_output_create("attaclip_replay", "Replay", nullptr, nullptr);
    obs_output_set_video_encoder(output, video);
    for (size_t i = 0; i < (mic ? 3 : 2); i++) {
      d = obs_data_create();
      obs_data_set_int(d, "bitrate", 160);
      auto *a = obs_audio_encoder_create("ffmpeg_aac",
                                         i == 0   ? "Master"
                                         : i == 1 ? "Capture audio"
                                                  : "Microphone",
                                         d, i, nullptr);
      obs_data_release(d);
      if (!a)
        throw std::runtime_error("The audio encoder could not be created");
      obs_encoder_set_audio(a, obs_get_audio());
      audio.push_back(a);
      obs_output_set_audio_encoder(output, a, i);
    }
    if (!obs_output_start(output))
      throw std::runtime_error(obs_output_get_last_error(output));
    active = true;
    emit({{"event", "recording"}, {"encoder", encoder}});
  }
};
Recorder *recorder = nullptr;
int main(int argc, char **argv) {
  try {
    base_set_log_handler(logger, nullptr);
#ifdef _WIN32
    SetProcessDPIAware();
#endif
    // win-capture starts an upstream network updater when its cache directory
    // is writable. Reserve that path as a file. The upstream updater returns
    // before creating its HTTP thread, while bundled locale data still works.
    auto config = std::filesystem::temp_directory_path() / "AttaClip" /
                  "offline-module-config";
    std::filesystem::create_directories(config);
    auto disabledUpdater = config / "win-capture";
    if (std::filesystem::is_directory(disabledUpdater))
      throw std::runtime_error("The offline recorder configuration is invalid");
    std::ofstream(disabledUpdater, std::ios::app).close();
    if (!std::filesystem::is_regular_file(disabledUpdater))
      throw std::runtime_error(
          "Could not disable capture compatibility updates");
    if (!obs_startup("en-US", config.u8string().c_str(), nullptr))
      throw std::runtime_error("libOBS initialization failed");
    std::filesystem::path root = argc > 1 ? argv[1] : ".";
    obs_add_data_path(((root / "data/libobs").u8string() + "/").c_str());
    obs_video_info initial{};
    initial.graphics_module = "libobs-d3d11.dll";
    initial.fps_num = 30;
    initial.fps_den = 1;
    initial.base_width = 1920;
    initial.base_height = 1080;
    initial.output_width = 1920;
    initial.output_height = 1080;
    initial.output_format = VIDEO_FORMAT_NV12;
    initial.gpu_conversion = true;
    initial.colorspace = VIDEO_CS_709;
    initial.range = VIDEO_RANGE_PARTIAL;
    if (obs_reset_video(&initial) != OBS_VIDEO_SUCCESS)
      throw std::runtime_error("Graphics initialization failed");
    for (auto name :
         {"win-capture", "win-wasapi", "obs-ffmpeg", "obs-nvenc", "obs-x264"}) {
      obs_module_t *module = nullptr;
      auto dll = root / "obs-plugins/64bit" / (std::string(name) + ".dll");
      auto data = root / "data/obs-plugins" / name;
      if (obs_open_module(&module, dll.u8string().c_str(),
                          data.u8string().c_str()) == MODULE_SUCCESS)
        obs_init_module(module);
    }
    obs_post_load_modules();
    obs_audio_info ai{};
    ai.samples_per_sec = 48000;
    ai.speakers = SPEAKERS_STEREO;
    if (!obs_reset_audio(&ai))
      throw std::runtime_error("Audio initialization failed");
    idleVideo();
    obs_output_info info{};
    info.id = "attaclip_replay";
    info.flags = OBS_OUTPUT_AV | OBS_OUTPUT_ENCODED | OBS_OUTPUT_MULTI_TRACK;
    info.get_name = [](void *) { return "AttaClip replay"; };
    info.create = [](obs_data_t *, obs_output_t *) -> void * {
      return recorder;
    };
    info.destroy = [](void *) {};
    info.start = [](void *data) {
      auto *r = static_cast<Recorder *>(data);
      if (!obs_output_can_begin_data_capture(r->output, 0) ||
          !obs_output_initialize_encoders(r->output, 0))
        return false;
      obs_output_begin_data_capture(r->output, 0);
      return true;
    };
    info.stop = [](void *data, uint64_t) {
      obs_output_end_data_capture(static_cast<Recorder *>(data)->output);
    };
    info.encoded_packet = [](void *data, encoder_packet *p) {
      static_cast<Recorder *>(data)->packets(p);
    };
    obs_register_output(&info);
    {
      Recorder r;
      recorder = &r;
      emit({{"event", "ready"}, {"version", obs_get_version_string()}});
      std::string line;
      while (std::getline(std::cin, line)) {
        json c;
        try {
          c = json::parse(line);
          std::string action = c.value("action", "");
          if (action == "start")
            r.start(c);
          else if (action == "stop") {
            r.stop();
            emit({{"event", "stopped"}});
          } else if (action == "save")
            r.save(c);
          else if (action == "source")
            r.source(c);
          else if (action == "audio")
            r.setAudio(c);
          else if (action == "exit")
            break;
          else if (action == "windows") {
#ifdef _WIN32
            auto *props = obs_get_source_properties("window_capture");
            auto *p = obs_properties_get(props, "window");
            json windows = json::array();
            for (size_t i = 0; i < obs_property_list_item_count(p); i++)
              windows.push_back(
                  {{"name", obs_property_list_item_name(p, i)},
                   {"value", obs_property_list_item_string(p, i)}});
            obs_properties_destroy(props);
            emit({{"event", "windows"}, {"windows", windows}});
#endif
          } else if (action == "audio-devices") {
            auto *props = obs_get_source_properties("wasapi_input_capture");
            auto *property = obs_properties_get(props, "device_id");
            json devices = json::array();
            for (size_t i = 0; i < obs_property_list_item_count(property); i++)
              devices.push_back(
                  {{"name", obs_property_list_item_name(property, i)},
                   {"id", obs_property_list_item_string(property, i)}});
            obs_properties_destroy(props);
            emit({{"event", "audio-devices"}, {"devices", devices}});
          } else if (action == "status") {
            std::lock_guard<std::mutex> lock(r.mutex);
            double available = r.ring.empty()
                                   ? 0
                                   : (r.ring.back().p.sys_dts_usec -
                                      r.ring.front().p.sys_dts_usec) /
                                         1000000.;
            bool fullscreen = false;
#ifdef _WIN32
            HWND foreground = GetForegroundWindow();
            RECT rect{};
            MONITORINFO monitor{};
            monitor.cbSize = sizeof(monitor);
            if (foreground && GetWindowRect(foreground, &rect) &&
                GetMonitorInfo(
                    MonitorFromWindow(foreground, MONITOR_DEFAULTTONEAREST),
                    &monitor))
              fullscreen = rect.left <= monitor.rcMonitor.left &&
                           rect.top <= monitor.rcMonitor.top &&
                           rect.right >= monitor.rcMonitor.right &&
                           rect.bottom >= monitor.rcMonitor.bottom &&
                           foreground != GetDesktopWindow() &&
                           foreground != GetShellWindow();
#endif
            emit({{"event", "status"},
                  {"fullscreen", fullscreen},
                  {"active", r.active.load()},
                  {"waiting", r.active && !r.targetAvailable()},
                  {"availableSeconds", std::min(double(r.seconds), available)},
                  {"pendingSaves", r.pending.load()}});
          }
          emit({{"event", "response"}, {"id", c.value("id", "")}});
        } catch (const std::exception &e) {
          emit({{"event", "error"},
                {"id", c.value("id", std::string(""))},
                {"action", c.value("action", std::string(""))},
                {"requestId", c.value("requestId", std::string(""))},
                {"message", e.what()}});
        }
      }
    }
    obs_shutdown();
    return 0;
  } catch (const std::exception &e) {
    emit({{"event", "error"}, {"message", e.what()}});
    return 1;
  }
}
