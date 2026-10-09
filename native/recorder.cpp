// SPDX-License-Identifier: GPL-2.0-or-later
// Mux protocol follows OBS Studio's ffmpeg-mux/ffmpeg-mux.h, Copyright Lain
// Bailey.
#include <algorithm>
#include <atomic>
#include <cmath>
#include <condition_variable>
#include <cstring>
#include <deque>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <json.hpp>
#include <memory>
#include <mutex>
#include <obs.h>
#include <thread>
#include <util/pipe.h>
#include <util/platform.h>
#include <vector>
#ifdef __APPLE__
#include "macos/platform.hpp"
#endif
#ifdef __linux__
#include "linux-app-audio.hpp"
#include "x11-compat.hpp"
#include <X11/Xlib.h>
#include <obs-nix-platform.h>
#include <pthread.h>
#include <signal.h>
#include <xcb/xcb.h>
#endif
// Separate XCB connections avoid process-wide Xlib error handler changes when a
// captured window disappears. Reply errors simply make that target unavailable.
#ifdef __linux__
xcb_connection_t *candidateConnection = nullptr;
std::mutex xcbMutex;
xcb_atom_t atom(const char *name) {
  auto *reply = xcb_intern_atom_reply(
      candidateConnection,
      xcb_intern_atom(candidateConnection, 0, uint16_t(strlen(name)), name),
      nullptr);
  xcb_atom_t value = reply ? reply->atom : XCB_ATOM_NONE;
  free(reply);
  return value;
}
std::vector<uint8_t> property(xcb_window_t window, const char *name) {
  auto *reply = xcb_get_property_reply(
      candidateConnection,
      xcb_get_property(candidateConnection, 0, window, atom(name),
                       XCB_GET_PROPERTY_TYPE_ANY, 0, 4096),
      nullptr);
  std::vector<uint8_t> result;
  if (reply) {
    auto *data = static_cast<uint8_t *>(xcb_get_property_value(reply));
    result.assign(data, data + xcb_get_property_value_length(reply));
  }
  free(reply);
  return result;
}
uint32_t cardinal(xcb_window_t window, const char *name) {
  auto bytes = property(window, name);
  uint32_t value = 0;
  if (bytes.size() >= 4)
    memcpy(&value, bytes.data(), 4);
  return value;
}
std::string windowText(xcb_window_t window, const char *name) {
  auto bytes = property(window, name);
  if (bytes.empty())
    return {};
  auto end = std::find(bytes.begin(), bytes.end(), uint8_t(0));
  return std::string(bytes.begin(), end);
}
bool x11Available(uintptr_t window, uint32_t pid) {
  if (!window)
    return true;
  std::lock_guard<std::mutex> lock(xcbMutex);
  if (!candidateConnection)
    return false;
  auto *reply = xcb_get_window_attributes_reply(
      candidateConnection,
      xcb_get_window_attributes(candidateConnection, uint32_t(window)),
      nullptr);
  bool available = reply && reply->map_state == XCB_MAP_STATE_VIEWABLE &&
                   (!pid || cardinal(uint32_t(window), "_NET_WM_PID") == pid);
  free(reply);
  return available;
}
nlohmann::json captureCandidates() {
  std::lock_guard<std::mutex> lock(xcbMutex);
  nlohmann::json result = nlohmann::json::array();
  if (!candidateConnection)
    return result;
  auto roots = xcb_setup_roots_iterator(xcb_get_setup(candidateConnection));
  for (; roots.rem; xcb_screen_next(&roots)) {
    auto *screen = roots.data;
    auto bytes = property(screen->root, "_NET_CLIENT_LIST");
    std::vector<xcb_window_t> windows(bytes.size() / 4);
    if (!windows.empty())
      memcpy(windows.data(), bytes.data(), windows.size() * 4);
    if (windows.empty()) {
      auto *tree = xcb_query_tree_reply(
          candidateConnection,
          xcb_query_tree(candidateConnection, screen->root), nullptr);
      if (tree)
        windows.assign(xcb_query_tree_children(tree),
                       xcb_query_tree_children(tree) +
                           xcb_query_tree_children_length(tree));
      free(tree);
    }
    auto foreground = cardinal(screen->root, "_NET_ACTIVE_WINDOW");
    for (auto window : windows) {
      auto *attrs = xcb_get_window_attributes_reply(
          candidateConnection,
          xcb_get_window_attributes(candidateConnection, window), nullptr);
      bool visible = attrs && attrs->map_state == XCB_MAP_STATE_VIEWABLE &&
                     !attrs->override_redirect;
      free(attrs);
      if (!visible)
        continue;
      auto name = windowText(window, "_NET_WM_NAME");
      if (name.empty())
        name = windowText(window, "WM_NAME");
      auto pid = cardinal(window, "_NET_WM_PID");
      if (!pid || name.empty())
        continue;
      std::error_code error;
      auto executable = std::filesystem::read_symlink(
          "/proc/" + std::to_string(pid) + "/exe", error);
      if (error)
        continue;
      auto *geometry = xcb_get_geometry_reply(
          candidateConnection, xcb_get_geometry(candidateConnection, window),
          nullptr);
      auto *position = xcb_translate_coordinates_reply(
          candidateConnection,
          xcb_translate_coordinates(candidateConnection, window, screen->root,
                                    0, 0),
          nullptr);
      bool fullscreen = geometry && position && position->dst_x <= 0 &&
                        position->dst_y <= 0 &&
                        geometry->width >= screen->width_in_pixels &&
                        geometry->height >= screen->height_in_pixels;
      free(geometry);
      free(position);
      result.push_back({{"id", "window:" + std::to_string(window) + ":0"},
                        {"name", name},
                        {"executable", executable.string()},
                        {"pid", pid},
                        {"foreground", foreground == window},
                        {"fullscreen", fullscreen}});
    }
  }
  return result;
}
#endif
#ifdef _WIN32
#include <objbase.h>
#include <psapi.h>
#include <util/dstr.h>
#include <util/windows/window-helpers.h>
#include <windows.h>
#endif
using json = nlohmann::json;
#ifdef _WIN32
std::string utf8(const std::wstring &value) {
  if (value.empty())
    return {};
  int size = WideCharToMultiByte(CP_UTF8, 0, value.data(), int(value.size()),
                                 nullptr, 0, nullptr, nullptr);
  std::string result(size, '\0');
  WideCharToMultiByte(CP_UTF8, 0, value.data(), int(value.size()),
                      result.data(), size, nullptr, nullptr);
  return result;
}
json captureCandidates() {
  json windows = json::array();
  EnumWindows(
      [](HWND window, LPARAM data) -> BOOL {
        if (!IsWindowVisible(window) || window == GetShellWindow() ||
            window == GetDesktopWindow() || GetWindow(window, GW_OWNER))
          return TRUE;
        int length = GetWindowTextLengthW(window);
        if (!length)
          return TRUE;
        std::wstring title(size_t(length) + 1, L'\0');
        title.resize(GetWindowTextW(window, title.data(), int(title.size())));
        DWORD pid = 0;
        GetWindowThreadProcessId(window, &pid);
        HANDLE process =
            OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if (!process)
          return TRUE;
        std::wstring executable(32768, L'\0');
        DWORD size = DWORD(executable.size());
        bool identified =
            QueryFullProcessImageNameW(process, 0, executable.data(), &size);
        CloseHandle(process);
        if (!identified)
          return TRUE;
        executable.resize(size);
        RECT rect{};
        MONITORINFO monitor{};
        monitor.cbSize = sizeof(monitor);
        bool fullscreen =
            !IsIconic(window) && GetWindowRect(window, &rect) &&
            GetMonitorInfo(MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST),
                           &monitor) &&
            rect.left <= monitor.rcMonitor.left &&
            rect.top <= monitor.rcMonitor.top &&
            rect.right >= monitor.rcMonitor.right &&
            rect.bottom >= monitor.rcMonitor.bottom;
        auto &result = *reinterpret_cast<json *>(data);
        result.push_back(
            {{"id",
              "window:" + std::to_string(reinterpret_cast<uintptr_t>(window)) +
                  ":0"},
             {"name", utf8(title)},
             {"executable", utf8(executable)},
             {"pid", pid},
             {"foreground", window == GetForegroundWindow()},
             {"fullscreen", fullscreen}});
        return TRUE;
      },
      reinterpret_cast<LPARAM>(&windows));
  return windows;
}
#endif
std::mutex stdoutMutex;
std::atomic<bool> captureTextureFailure{false};
std::string muxExecutable = "obs-ffmpeg-mux.exe";
obs_source_t *createCaptureSource(const char *id, obs_data_t *settings) {
  const char *registered = nullptr;
  bool found = false;
  for (size_t i = 0; obs_enum_input_types(i, &registered); i++)
    if (std::string(registered) == id)
      found = true;
  if (!found)
    throw std::runtime_error("The selected capture method is unavailable. Its "
                             "OBS module did not initialize on this session");
  return obs_source_create_private(id, "Capture", settings);
}
std::vector<std::string> hardwareEncoders() {
#ifdef __APPLE__
  return attaclip::macos::hardwareEncoders();
#else
  std::vector<std::string> result;
  // These are hardware encoders, including the upload path on a secondary
  // GPU. OBS modules register them only after their device availability probe.
  for (const char *preferred :
       {"obs_nvenc_h264_tex", "obs_nvenc_h264", "h264_texture_amf",
        "h264_fallback_amf", "obs_qsv11_v2", "obs_qsv11_soft_v2"}) {
    const char *id = nullptr;
    for (size_t i = 0; obs_enum_encoder_types(i, &id); i++)
      if (std::string(id) == preferred)
        result.emplace_back(preferred);
  }
  return result;
#endif
}
const char *graphicsModule() {
#ifdef _WIN32
  return "libobs-d3d11.dll";
#elif defined(__APPLE__)
  return attaclip::macos::graphicsModule();
#else
  return "libobs-opengl.so";
#endif
}
const char *microphoneType() {
#ifdef _WIN32
  return "wasapi_input_capture";
#elif defined(__APPLE__)
  return "coreaudio_input_capture";
#else
  return "pulse_input_capture";
#endif
}
const char *desktopType() {
#ifdef _WIN32
  return "wasapi_output_capture";
#else
  return "pulse_output_capture";
#endif
}
void idleVideo() {
  obs_video_info info{};
  info.graphics_module = graphicsModule();
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
  if (strstr(format, "Cannot create EGLImage"))
    captureTextureFailure = true;
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
  int64_t end = 0;
  bool reduceOverlap = false;
  int width = 0, height = 0, fps = 0;
  double secondsSinceCapture = 0;
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
#ifdef __linux__
  ApplicationAudio *applicationAudio = nullptr;
#endif
  obs_source_t *mic = nullptr;
  obs_sceneitem_t *item = nullptr;
  std::mutex mutex;
  std::condition_variable wake;
  std::deque<Packet> ring;
  std::deque<Request> requests;
  std::deque<Job> jobs;
  std::thread writer;
  bool quitting = false;
  bool captureInterrupted = false;
  std::atomic<bool> active{false};
  std::atomic<int> pending{0};
  std::atomic<uintptr_t> targetWindow{0};
  std::atomic<uint32_t> targetProcess{0};
  std::atomic<bool> captureEnabled{false};
  std::atomic<bool> gameCapture{false}, gameReady{false};
  std::atomic<bool> windowCompatibility{false};
  uint64_t gameStarted = 0;
  json gameConfig;
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
  std::string encoder, sourceName, selectedSourceId;
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
    captureEnabled = false;
    gameCapture = false;
    gameReady = false;
    windowCompatibility = false;
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
#ifdef __linux__
    destroyApplicationAudio(applicationAudio);
    applicationAudio = nullptr;
#endif
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
      captureInterrupted = false;
    }
    release();
    idleVideo();
  }
  bool targetAvailable() {
    if (!captureEnabled)
      return false;
    if (gameCapture && !gameReady)
      return false;
#ifdef _WIN32
    HWND window = reinterpret_cast<HWND>(targetWindow.load());
    if (window &&
        (!IsWindow(window) || IsIconic(window) || !IsWindowVisible(window)))
      return false;
    if (window) {
      DWORD pid = 0;
      GetWindowThreadProcessId(window, &pid);
      if (pid != targetProcess.load())
        return false;
    }
#endif
#ifdef __APPLE__
    return attaclip::macos::targetAvailable(targetWindow.load());
#endif
#ifdef __linux__
    if (!screenCapture && !windowCompatibility && captureTextureFailure)
      return false;
    if (!applicationAudioError(applicationAudio).empty())
      return false;
    if (windowCompatibility && !x11CompatibilityAvailable(targetWindow.load()))
      return false;
    return x11Available(targetWindow.load(), targetProcess.load());
#endif
    return true;
  }
  void refreshCapture() {
#ifdef _WIN32
    if (!gameCapture || !capture)
      return;
    calldata_t data{};
    calldata_init(&data);
    bool called = proc_handler_call(obs_source_get_proc_handler(capture),
                                    "get_hooked", &data);
    gameReady = called && calldata_bool(&data, "hooked");
    calldata_free(&data);
    if (!gameReady && os_gettime_ns() - gameStarted > 3000000000ULL) {
      json fallback = gameConfig;
      fallback["captureMethod"] = "window";
      source(fallback);
      emit({{"event", "capture-method"},
            {"method", "window"},
            {"reason", "Game capture could not hook this application. "
                       "Capturing the same application window"}});
    }
#endif
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
      obs_source_t *source =
#ifdef __APPLE__
          capture;
#elif defined(__linux__)
          screenCapture ? desktop : applicationAudioSource(applicationAudio);
#else
          screenCapture ? desktop : capture;
#endif
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
      captureInterrupted = true;
      for (auto &r : requests)
        snapshot(r);
      requests.clear();
      return;
    }
    std::lock_guard<std::mutex> lock(mutex);
    if (captureInterrupted) {
      // Keep earlier footage available until recovery produces a decodable
      // keyframe. Never join the absent interval into a seemingly continuous
      // clip.
      if (p->type != OBS_ENCODER_VIDEO || !p->keyframe)
        return;
      ring.clear();
      bytes = 0;
      captureInterrupted = false;
    }
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
    int64_t end = r.end;
    for (auto i = ring.rbegin(); i != ring.rend(); ++i)
      if (i->p.type == OBS_ENCODER_VIDEO) {
        end = std::min(end, i->p.sys_dts_usec);
        break;
      }
    int64_t begin = end - int64_t(seconds) * 1000000;
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
    j.end = end;
    j.reduceOverlap = avoidOverlap;
    j.width = width;
    j.height = height;
    j.fps = fps;
    j.secondsSinceCapture = std::max(0., double(r.end - end) / 1000000.);
    j.source = r.source;
    for (size_t i = start; i < ring.size(); i++)
      if (ring[i].p.sys_dts_usec <= end)
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
    if (!targetAvailable() || captureInterrupted) {
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
      if (auto *gate = std::getenv("ATTACLIP_NATIVE_TEST_WRITER_GATE")) {
        // A bounded test gate reproduces profile changes while an accepted
        // original is still queued. Normal recording never waits here.
        for (int i = 0; i < 1000 && !std::filesystem::exists(gate); i++)
          std::this_thread::sleep_for(std::chrono::milliseconds(10));
      }
      bool okay = false;
      size_t start = 0;
      int64_t cutoff = 0;
      if (j.reduceOverlap) {
        std::lock_guard<std::mutex> lock(mutex);
        cutoff = previousEnd;
        // The writer is serial. Only a successfully published predecessor can
        // shorten this job, including jobs snapshotted before it finished.
        for (size_t i = 0; i < j.packets.size(); i++)
          if (j.packets[i].p.type == OBS_ENCODER_VIDEO &&
              j.packets[i].p.keyframe && j.packets[i].p.sys_dts_usec <= cutoff)
            start = i;
      }
      const double overlapSeconds =
          cutoff > 0 ? std::max(0., double(std::min(cutoff, j.end) -
                                           j.packets[start].p.sys_dts_usec) /
                                        1000000.)
                     : 0.;
      std::string temp = j.request.path + ".saving.mkv";
      auto *args = os_process_args_create(muxExecutable.c_str());
      auto add = [&](std::string v) {
        os_process_args_add_arg(args, v.c_str());
      };
      add(temp);
      add("1");
      add(std::to_string(j.headers.size() - 1));
      add("h264");
      add("10000");
      add(std::to_string(j.width));
      add(std::to_string(j.height));
      for (auto v : {1, 1, 1, 1, 1, 0})
        add(std::to_string(v));
      add(std::to_string(j.fps));
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
        int64_t origin = j.packets[start].p.dts_usec;
        for (size_t i = start; i < j.packets.size(); i++) {
          auto &p = j.packets[i];
          if (!writePacket(pipe, p.p, origin)) {
            okay = false;
            break;
          }
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
#ifdef _WIN32
          std::filesystem::rename(temp, j.request.path);
#else
          // POSIX rename replaces an existing destination. Publishing a hard
          // link fails atomically if another writer won the filename race.
          std::filesystem::create_hard_link(temp, j.request.path);
          std::filesystem::remove(temp);
#endif
          std::lock_guard<std::mutex> lock(mutex);
          previousEnd = std::max(previousEnd, j.end);
          emit({{"event", "saved"},
                {"requestId", j.request.id},
                {"path", j.request.path},
                {"previousFootage", j.secondsSinceCapture > 0.25},
                {"secondsSinceCapture", j.secondsSinceCapture},
                {"source", j.source},
                {"overlapSeconds", overlapSeconds}});
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
    if (kind == "auto")
      kind = c.value("resolvedKind", "waiting");
    if (kind == "waiting") {
      captureEnabled = false;
      gameCapture = false;
      gameReady = false;
      targetWindow = 0;
      targetProcess = 0;
      obs_volmeter_detach_source(captureMeter);
      captureLevel = 0;
      if (item)
        obs_sceneitem_remove(item);
      item = nullptr;
      if (capture)
        obs_source_release(capture);
      capture = nullptr;
#ifdef __linux__
      obs_set_output_source(1, nullptr);
      destroyApplicationAudio(applicationAudio);
      applicationAudio = nullptr;
#endif
      if (desktop)
        obs_source_set_muted(desktop, true);
#ifdef __linux__
      if (desktop)
        obs_source_release(desktop);
      desktop = nullptr;
#endif
      screenCapture = false;
      std::lock_guard<std::mutex> lock(mutex);
      sourceName = c.value("sourceName", "Waiting for game");
      selectedSourceId.clear();
      return;
    }
    std::unique_ptr<obs_data_t, decltype(&obs_data_release)> sourceSettings(
        obs_data_create(), &obs_data_release);
    auto *s = sourceSettings.get();
    obs_source_t *next = nullptr;
    bool compatibility = false;
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
      next = createCaptureSource("monitor_capture", s);
    } else if (kind == "app") {
      std::string window = c.value("window", "");
      std::string sourceId = c.value("sourceId", "");
      if (sourceId.rfind("window:", 0) == 0) {
        HWND hwnd = reinterpret_cast<HWND>(std::stoull(sourceId.substr(7)));
        if (!IsWindow(hwnd) || IsIconic(hwnd) || !IsWindowVisible(hwnd))
          throw std::runtime_error("The selected application is unavailable");
        DWORD pid = 0;
        GetWindowThreadProcessId(hwnd, &pid);
        if (c.contains("pid") && c.at("pid").get<uint32_t>() != pid)
          throw std::runtime_error(
              "The selected application changed. Select it again");
        dstr title{}, klass{}, exe{};
        ms_get_window_title(&title, hwnd);
        ms_get_window_class(&klass, hwnd);
        if (!ms_get_window_exe(&exe, hwnd)) {
          dstr_free(&title);
          dstr_free(&klass);
          throw std::runtime_error(
              "The selected application cannot be identified safely");
        }
        if (ms_find_window(INCLUDE_MINIMIZED, WINDOW_PRIORITY_TITLE,
                           klass.array, title.array, exe.array) != hwnd) {
          dstr_free(&title);
          dstr_free(&klass);
          dstr_free(&exe);
          throw std::runtime_error(
              "Another application has the same window title. Rename the "
              "selected window or choose another source");
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
      bool preferGame =
          c.value("captureMethod",
                  c.value("sourceKind", "") == "auto" ? "game" : "window") ==
          "game";
      if (preferGame) {
        obs_data_set_string(s, "capture_mode", "window");
        obs_data_set_bool(s, "capture_cursor", true);
        obs_data_set_bool(s, "anti_cheat_hook", true);
        next = createCaptureSource("game_capture", s);
      } else
        next = createCaptureSource("window_capture", s);
    } else
      throw std::runtime_error(
          "Automatic game detection is not available in this recording backend "
          "yet. Choose Screen or App");
#elif defined(__APPLE__)
    next = attaclip::macos::createCapture(c);
#elif defined(__linux__)
    if (!std::getenv("DISPLAY") ||
        (std::getenv("WAYLAND_DISPLAY") && *std::getenv("WAYLAND_DISPLAY")) ||
        (std::getenv("XDG_SESSION_TYPE") &&
         std::string(std::getenv("XDG_SESSION_TYPE")) == "wayland"))
      throw std::runtime_error("Native Linux capture currently requires an X11 "
                               "session. Wayland capture is unavailable");
    if (kind == "app") {
      std::string id = c.value("sourceId", "");
      if (id.rfind("window:", 0) != 0)
        throw std::runtime_error(
            "The selected X11 window has no capture identity");
      uint32_t window = uint32_t(std::stoull(id.substr(7)));
      if (!x11Available(window, c.value("pid", uint32_t(0))))
        throw std::runtime_error(
            "The selected X11 application is unavailable or changed");
      std::string name, klass;
      {
        std::lock_guard<std::mutex> lock(xcbMutex);
        name = windowText(window, "_NET_WM_NAME");
        if (name.empty())
          name = windowText(window, "WM_NAME");
        klass = windowText(window, "WM_CLASS");
      }
      std::string identity =
          std::to_string(window) + "\r\n" + name + "\r\n" + klass;
      obs_data_set_string(s, "capture_window", identity.c_str());
      obs_data_set_bool(s, "show_cursor", true);
      captureTextureFailure = false;
      next = createCaptureSource("xcomposite_input", s);
      if (captureTextureFailure) {
        obs_source_release(next);
        obs_wait_for_destroy_queue();
        obs_data_set_int(s, "window", window);
        obs_data_set_int(s, "fps", fps);
        next = createCaptureSource("attaclip_x11_window", s);
        auto deadline =
            std::chrono::steady_clock::now() + std::chrono::seconds(2);
        while ((!obs_source_get_width(next) || !obs_source_get_height(next)) &&
               std::chrono::steady_clock::now() < deadline)
          std::this_thread::sleep_for(std::chrono::milliseconds(10));
        if (!obs_source_get_width(next) || !obs_source_get_height(next)) {
          obs_source_release(next);
          throw std::runtime_error(
              "This X11 session could not capture the application's pixels. No "
              "desktop capture was substituted");
        }
        compatibility = true;
        emit({{"event", "capture-method"},
              {"method", "compatibility"},
              {"reason",
               "Application capture uses CPU compatibility mode because this "
               "graphics driver cannot import its window texture"}});
      }
    } else if (kind == "screen") {
      int screen = c.value("screenIndex", 0);
      obs_data_set_int(s, "screen", screen);
      obs_data_set_bool(s, "show_cursor", true);
      next = createCaptureSource("xshm_input_v2", s);
      if (!next)
        throw std::runtime_error(
            "The X11 capture module could not create a source");
      auto *props = obs_source_properties(next);
      auto *screens = props ? obs_properties_get(props, "screen") : nullptr;
      bool found = false;
      if (screens)
        for (size_t i = 0; i < obs_property_list_item_count(screens); i++) {
          if (obs_property_list_item_disabled(screens, i))
            continue;
          int candidate = int(obs_property_list_item_int(screens, i));
          if (c.contains("bounds") && c["bounds"].is_object()) {
            std::string label = obs_property_list_item_name(screens, i);
            auto bracket = label.find('(');
            int w = 0, h = 0, x = 0, y = 0;
            if (bracket == std::string::npos ||
                sscanf(label.c_str() + bracket, "(%dx%d @ %d,%d)", &w, &h, &x,
                       &y) != 4)
              continue;
            auto b = c["bounds"];
            if (w != b.value("width", 0) || h != b.value("height", 0) ||
                x != b.value("x", 0) || y != b.value("y", 0))
              continue;
          } else if (candidate != screen)
            continue;
          obs_data_set_int(s, "screen", candidate);
          found = true;
          break;
        }
      obs_properties_destroy(props);
      if (!found) {
        obs_source_release(next);
        throw std::runtime_error(
            "The selected X11 display could not be matched safely");
      }
      obs_source_update(next, s);
    } else
      throw std::runtime_error("The resolved X11 capture source is invalid");
#else
    throw std::runtime_error(
        "Native capture on this platform is not yet implemented");
#endif
    if (!next)
      throw std::runtime_error("The capture source could not be created");
    uintptr_t target = 0;
    if (kind == "app") {
      std::string id = c.value("sourceId", "");
      if (id.rfind("window:", 0) == 0)
        target = std::stoull(id.substr(7));
    }
    uint32_t targetPid = 0;
#ifdef _WIN32
    if (target) {
      DWORD pid = 0;
      GetWindowThreadProcessId(reinterpret_cast<HWND>(target), &pid);
      targetPid = pid;
    }
#endif
#ifdef __linux__
    if (target) {
      std::lock_guard<std::mutex> lock(xcbMutex);
      targetPid = cardinal(uint32_t(target), "_NET_WM_PID");
    }
#endif
#ifdef __linux__
    ApplicationAudio *nextAudio = nullptr;
    try {
      if (target && c.value("captureAudio", true))
        nextAudio = createApplicationAudio(targetPid);
      if (kind == "screen" && !desktop) {
        auto *settings = obs_data_create();
        obs_data_set_string(settings, "device_id", "default");
        desktop =
            obs_source_create_private(desktopType(), "Capture audio", settings);
        obs_data_release(settings);
        if (!desktop)
          throw std::runtime_error("Desktop audio could not be opened");
        obs_source_set_audio_mixers(desktop, 3);
      }
    } catch (...) {
      obs_source_release(next);
      throw;
    }
    obs_volmeter_detach_source(captureMeter);
    obs_set_output_source(1, nullptr);
    destroyApplicationAudio(applicationAudio);
    applicationAudio = nextAudio;
    obs_set_output_source(1, kind == "screen"
                                 ? desktop
                                 : applicationAudioSource(applicationAudio));
    if (kind != "screen" && desktop) {
      obs_source_release(desktop);
      desktop = nullptr;
    }
#endif
    targetWindow = target;
    targetProcess = targetPid;
    windowCompatibility = compatibility;
#ifdef _WIN32
    gameCapture = std::string(obs_source_get_id(next)) == "game_capture";
#else
    gameCapture = false;
#endif
    gameReady = false;
    gameStarted = os_gettime_ns();
    gameConfig = c;
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
      selectedSourceId = c.value("sourceId", "");
    }
    captureEnabled = true;
    if (desktop)
      obs_source_set_muted(desktop, kind != "screen" ||
                                        !c.value("captureAudio", true) ||
                                        captureMuted);
    obs_source_t *audioSource =
#ifdef __APPLE__
        capture;
#elif defined(__linux__)
        screenCapture ? desktop : applicationAudioSource(applicationAudio);
#else
        screenCapture ? desktop : capture;
#endif
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
    release();
    seconds = c.value("clipSeconds", 60);
    avoidOverlap = c.value("avoidOverlap", false);
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
    vi.graphics_module = graphicsModule();
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
#ifndef __APPLE__
#ifdef __linux__
    obs_data_release(d);
#else
    obs_data_set_string(d, "device_id", "default");
    desktop = obs_source_create_private(desktopType(), "Capture audio", d);
    obs_data_release(d);
    if (desktop) {
      obs_source_set_audio_mixers(desktop, 3);
      obs_set_output_source(1, desktop);
    }
#endif
#else
    obs_data_release(d);
#endif
    if (c.value("microphone", false)) {
#ifdef __APPLE__
      attaclip::macos::requireMicrophonePermission();
#endif
      d = obs_data_create();
      auto *props = obs_get_source_properties(microphoneType());
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
      mic = obs_source_create_private(microphoneType(), "Microphone", d);
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
#ifdef __APPLE__
    encoder = attaclip::macos::hardwareEncoder(d, cq, width, height, fps);
#else
    auto hardware = hardwareEncoders();
    if (!hardware.empty())
      encoder = hardware.front();
    if (encoder.find("amf") != std::string::npos)
      obs_data_set_string(d, "preset", "balanced");
    if (encoder.find("qsv") != std::string::npos) {
      obs_data_set_string(d, "target_usage", "TU4");
      obs_data_set_int(d, "qpi", cq);
      obs_data_set_int(d, "qpp", cq);
      obs_data_set_int(d, "qpb", cq);
      obs_data_set_int(d, "bframes", 0);
    }
#endif
    if (std::getenv("ATTACLIP_NATIVE_TEST_SOFTWARE"))
      encoder.clear();
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
    std::filesystem::path root = argc > 1 ? argv[1] : ".";
#ifdef __APPLE__
    attaclip::macos::prepareProcess(root);
    muxExecutable = attaclip::macos::muxPath();
#endif
#ifdef __linux__
    // Match OBS's frontend: a failed mux pipe is a save failure, never a
    // SIGPIPE termination of the capture process and its retained footage.
    sigset_t brokenPipe{};
    sigemptyset(&brokenPipe);
    sigaddset(&brokenPipe, SIGPIPE);
    if (pthread_sigmask(SIG_BLOCK, &brokenPipe, nullptr) != 0)
      throw std::runtime_error("Could not configure recorder pipe handling");
    if (!XInitThreads())
      throw std::runtime_error("X11 thread initialization failed");
#endif
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
    if (!
#ifdef __APPLE__
        attaclip::macos::startup("en-US", config.u8string().c_str())
#else
        obs_startup("en-US", config.u8string().c_str(), nullptr)
#endif
    )
      throw std::runtime_error("libOBS initialization failed");
#ifdef __linux__
    if (!std::getenv("DISPLAY"))
      throw std::runtime_error(
          "An X11 display is required for native recording");
    auto *display = XOpenDisplay(nullptr);
    if (!display)
      throw std::runtime_error("The X11 display could not be opened");
    obs_set_nix_platform(OBS_NIX_PLATFORM_X11_EGL);
    obs_set_nix_platform_display(display);
    candidateConnection = xcb_connect(nullptr, nullptr);
    if (xcb_connection_has_error(candidateConnection))
      throw std::runtime_error("X11 application identity connection failed");
    muxExecutable = (root / "obs-ffmpeg-mux").string();
#endif
    obs_add_data_path(((root / "data/libobs").u8string() + "/").c_str());
    obs_video_info initial{};
    initial.graphics_module = graphicsModule();
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
#ifdef _WIN32
    for (auto name : {"win-capture", "win-wasapi", "obs-ffmpeg", "obs-nvenc",
                      "obs-qsv11", "obs-x264"}) {
      obs_module_t *module = nullptr;
      auto dll = root / "obs-plugins/64bit" / (std::string(name) + ".dll");
      auto data = root / "data/obs-plugins" / name;
      if (obs_open_module(&module, dll.u8string().c_str(),
                          data.u8string().c_str()) == MODULE_SUCCESS)
        obs_init_module(module);
    }
#elif defined(__APPLE__)
    attaclip::macos::loadModules();
#elif defined(__linux__)
    for (auto name : {"linux-capture", "linux-pulseaudio", "obs-ffmpeg",
                      "obs-nvenc", "obs-x264"}) {
      if (std::string(name) == "obs-nvenc" &&
          std::getenv("ATTACLIP_NATIVE_TEST_SOFTWARE"))
        continue;
      obs_module_t *module = nullptr;
      auto file = root / "obs-plugins" / (std::string(name) + ".so");
      auto data = root / "data/obs-plugins" / name;
      if (obs_open_module(&module, file.string().c_str(),
                          data.string().c_str()) == MODULE_SUCCESS)
        obs_init_module(module);
    }
#endif
    obs_post_load_modules();
#ifdef __linux__
    registerX11CompatibilitySource();
    registerLinuxApplicationAudio();
#endif
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
      emit({{"event", "ready"},
            {"version", obs_get_version_string()},
            {"encoders", hardwareEncoders()}});
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
          else if (action == "candidates") {
#if defined(_WIN32) || defined(__linux__)
            emit({{"event", "candidates"}, {"windows", captureCandidates()}});
#elif defined(__APPLE__)
            emit({{"event", "candidates"},
                  {"windows", attaclip::macos::candidates()}});
#else
            emit({{"event", "candidates"}, {"windows", json::array()}});
#endif
          } else if (action == "windows") {
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
            auto *props = obs_get_source_properties(microphoneType());
            auto *property = obs_properties_get(props, "device_id");
            json devices = json::array();
            for (size_t i = 0; i < obs_property_list_item_count(property); i++)
              devices.push_back(
                  {{"name", obs_property_list_item_name(property, i)},
                   {"id", obs_property_list_item_string(property, i)}});
            obs_properties_destroy(props);
            emit({{"event", "audio-devices"}, {"devices", devices}});
          } else if (action == "status") {
            r.refreshCapture();
            std::lock_guard<std::mutex> lock(r.mutex);
            double available = r.ring.empty()
                                   ? 0
                                   : (r.ring.back().p.sys_dts_usec -
                                      r.ring.front().p.sys_dts_usec) /
                                         1000000.;
            bool fullscreen = false;
            std::string captureError;
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
#ifdef __APPLE__
            fullscreen = attaclip::macos::foregroundFullscreen();
            captureError = attaclip::macos::captureError();
#endif
#ifdef __linux__
            captureError = applicationAudioError(r.applicationAudio);
#endif
            emit({{"event", "status"},
                  {"fullscreen", fullscreen},
                  {"active", r.active.load()},
                  {"source", r.sourceName},
                  {"message", captureError},
                  {"sourceId", r.selectedSourceId},
                  {"sourceKind", r.captureEnabled
                                     ? (r.screenCapture ? "screen" : "app")
                                     : "waiting"},
                  {"captureMethod", r.windowCompatibility ? "compatibility"
                                    : r.gameCapture       ? "game"
                                                          : "window"},
                  {"waiting",
                   r.active && (!r.targetAvailable() || r.captureInterrupted)},
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
