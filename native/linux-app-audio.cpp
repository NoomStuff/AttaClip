// SPDX-License-Identifier: GPL-2.0-or-later
// PulseAudio supports monitoring a single sink input without moving or muting
// playback. Private OBS child sources mix verified process streams together.
#include "linux-app-audio.hpp"
#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <map>
#include <mutex>
#include <pulse/pulseaudio.h>
#include <set>
#include <sstream>
#include <stdexcept>
#include <thread>
#include <util/platform.h>
#include <vector>

namespace {
uint32_t processId(const pa_proplist *properties) {
  const char *text =
      pa_proplist_gets(properties, PA_PROP_APPLICATION_PROCESS_ID);
  if (!text || !*text)
    return 0;
  char *end = nullptr;
  auto value = strtoul(text, &end, 10);
  return end && !*end && value <= UINT32_MAX ? uint32_t(value) : 0;
}
struct Process {
  uint32_t parent = 0;
  uint64_t started = 0;
};
Process process(uint32_t pid) {
  std::ifstream file("/proc/" + std::to_string(pid) + "/stat");
  std::string text;
  std::getline(file, text);
  auto end = text.rfind(')');
  if (end == std::string::npos)
    return {};
  std::istringstream fields(text.substr(end + 2));
  Process result;
  for (int field = 3; field <= 22; field++) {
    std::string value;
    if (!(fields >> value))
      return {};
    try {
      if (field == 4)
        result.parent = uint32_t(std::stoul(value));
      if (field == 22)
        result.started = std::stoull(value);
    } catch (...) {
      return {};
    }
  }
  return result;
}
struct Connection {
  pa_mainloop *loop = nullptr;
  pa_context *context = nullptr;
  std::atomic<bool> &quit;
  Connection(std::atomic<bool> &stop) : quit(stop) {
    try {
      loop = pa_mainloop_new();
      context = loop ? pa_context_new(pa_mainloop_get_api(loop),
                                      "AttaClip application audio")
                     : nullptr;
      if (!context || pa_context_connect(context, nullptr,
                                         PA_CONTEXT_NOAUTOSPAWN, nullptr) < 0)
        throw std::runtime_error(
            "PulseAudio application audio could not connect");
      auto deadline =
          std::chrono::steady_clock::now() + std::chrono::seconds(2);
      while (!quit && pa_context_get_state(context) != PA_CONTEXT_READY) {
        if (!PA_CONTEXT_IS_GOOD(pa_context_get_state(context)) ||
            std::chrono::steady_clock::now() >= deadline)
          throw std::runtime_error(
              "PulseAudio application audio is unavailable");
        iterate();
      }
    } catch (...) {
      if (context) {
        pa_context_disconnect(context);
        pa_context_unref(context);
        context = nullptr;
      }
      if (loop) {
        pa_mainloop_free(loop);
        loop = nullptr;
      }
      throw;
    }
  }
  ~Connection() {
    if (context) {
      pa_context_disconnect(context);
      pa_context_unref(context);
    }
    if (loop)
      pa_mainloop_free(loop);
  }
  void iterate() {
    pa_mainloop_iterate(loop, 0, nullptr);
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  bool operation(pa_operation *value) {
    if (!value)
      return false;
    auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
    while (!quit && PA_CONTEXT_IS_GOOD(pa_context_get_state(context)) &&
           pa_operation_get_state(value) == PA_OPERATION_RUNNING &&
           std::chrono::steady_clock::now() < deadline)
      iterate();
    bool done = pa_operation_get_state(value) == PA_OPERATION_DONE;
    if (!done)
      pa_operation_cancel(value);
    pa_operation_unref(value);
    return done;
  }
};
struct Input {
  uint32_t index, pid, sink;
  uint64_t processStarted;
  std::string monitor;
};
struct MonitoredInput {
  obs_source_t *source;
  uint32_t index, pid, sink;
  uint64_t processStarted;
  std::string monitor;
  std::atomic<bool> quit{false};
  std::atomic<bool> ended{false};
  uint64_t nextTimestamp = 0;
  std::thread thread;
  MonitoredInput(obs_data_t *settings, obs_source_t *value)
      : source(value), index(uint32_t(obs_data_get_int(settings, "index"))),
        pid(uint32_t(obs_data_get_int(settings, "pid"))),
        sink(uint32_t(obs_data_get_int(settings, "sink"))),
        processStarted(uint64_t(obs_data_get_int(settings, "started"))),
        monitor(obs_data_get_string(settings, "monitor")) {
    thread = std::thread([this] { capture(); });
  }
  ~MonitoredInput() {
    quit = true;
    thread.join();
  }
  void capture() {
    try {
      Connection connection(quit);
      bool verified = false;
      struct Verification {
        MonitoredInput *self;
        bool *result;
      } request{this, &verified};
      connection.operation(pa_context_get_sink_input_info(
          connection.context, index,
          [](pa_context *, const pa_sink_input_info *info, int end,
             void *data) {
            auto *request = static_cast<Verification *>(data);
            if (!end && info)
              *request->result =
                  info->index == request->self->index &&
                  info->sink == request->self->sink &&
                  processId(info->proplist) == request->self->pid &&
                  process(request->self->pid).started ==
                      request->self->processStarted;
          },
          &request));
      if (!verified || quit) {
        ended = true;
        return;
      }
      pa_sample_spec spec{PA_SAMPLE_FLOAT32LE, 48000, 2};
      pa_stream *stream = pa_stream_new(
          connection.context, "Selected application input", &spec, nullptr);
      if (!stream) {
        ended = true;
        return;
      }
      pa_stream_set_read_callback(
          stream,
          [](pa_stream *stream, size_t, void *data) {
            auto *self = static_cast<MonitoredInput *>(data);
            const void *frames = nullptr;
            size_t bytes = 0;
            if (pa_stream_peek(stream, &frames, &bytes) < 0 || !bytes)
              return;
            if (frames && !self->quit &&
                process(self->pid).started == self->processStarted) {
              obs_source_audio audio{};
              audio.data[0] = reinterpret_cast<const uint8_t *>(frames);
              audio.frames = uint32_t(bytes / (sizeof(float) * 2));
              audio.speakers = SPEAKERS_STEREO;
              audio.format = AUDIO_FORMAT_FLOAT;
              audio.samples_per_sec = 48000;
              auto duration = uint64_t(audio.frames) * 1000000000ULL / 48000;
              auto arrival = os_gettime_ns() - duration;
              // Arrival callbacks can jitter by milliseconds. Recomputing each
              // packet's clock from arrival would cut samples when OBS mixes
              // several inputs. Keep a continuous sample clock, resynchronizing
              // only after an actual interruption.
              if (!self->nextTimestamp ||
                  std::abs(int64_t(arrival) - int64_t(self->nextTimestamp)) >
                      200000000)
                self->nextTimestamp = arrival;
              audio.timestamp = self->nextTimestamp;
              self->nextTimestamp += duration;
              obs_source_output_audio(self->source, &audio);
            }
            pa_stream_drop(stream);
          },
          this);
      pa_buffer_attr buffer{};
      buffer.maxlength = uint32_t(-1);
      buffer.tlength = uint32_t(-1);
      buffer.prebuf = uint32_t(-1);
      buffer.minreq = uint32_t(-1);
      buffer.fragsize = 480 * sizeof(float) * 2;
      // Set the input before connect_record. Never connect an unrestricted
      // monitor, including on errors or reconnection.
      if (pa_stream_set_monitor_stream(stream, index) < 0 ||
          pa_stream_connect_record(stream, monitor.c_str(), &buffer,
                                   pa_stream_flags_t(PA_STREAM_ADJUST_LATENCY |
                                                     PA_STREAM_DONT_MOVE)) <
              0) {
        pa_stream_unref(stream);
        ended = true;
        return;
      }
      while (!quit &&
             PA_CONTEXT_IS_GOOD(pa_context_get_state(connection.context)) &&
             PA_STREAM_IS_GOOD(pa_stream_get_state(stream)))
        connection.iterate();
      pa_stream_set_read_callback(stream, nullptr, nullptr);
      pa_stream_disconnect(stream);
      pa_stream_unref(stream);
    } catch (const std::exception &error) {
      blog(LOG_WARNING, "Application audio input failed: %s", error.what());
    }
    ended = true;
  }
};
std::mutex inputMutex;
std::map<obs_source_t *, MonitoredInput *> liveInputs;
bool inputEnded(obs_source_t *source) {
  std::lock_guard<std::mutex> lock(inputMutex);
  auto found = liveInputs.find(source);
  return found == liveInputs.end() || found->second->ended;
}
} // namespace
struct ApplicationAudio {
  uint32_t pid;
  uint32_t mixers;
  uint64_t processStarted;
  obs_scene_t *scene;
  std::atomic<bool> quit{false};
  std::atomic<int> initialized{0};
  std::mutex errorMutex;
  std::string error;
  struct Child {
    Input input;
    obs_source_t *source;
    obs_sceneitem_t *item;
  };
  std::map<uint32_t, Child> children;
  std::thread thread;
  ApplicationAudio(uint32_t selected, uint32_t mask)
      : pid(selected), mixers(mask), processStarted(process(selected).started),
        scene(obs_scene_create_private("Application audio")) {
    if (!processStarted || !scene) {
      if (scene)
        obs_scene_release(scene);
      throw std::runtime_error(
          "The selected application audio cannot be identified safely");
    }
    obs_source_set_audio_mixers(obs_scene_get_source(scene), mixers);
    thread = std::thread([this] { run(); });
  }
  ~ApplicationAudio() {
    quit = true;
    thread.join();
    for (auto &entry : children) {
      obs_sceneitem_remove(entry.second.item);
      obs_source_release(entry.second.source);
    }
    obs_scene_release(scene);
  }
  bool includes(uint32_t inputPid) {
    if (!inputPid || process(pid).started != processStarted)
      return false;
    for (int depth = 0; inputPid > 1 && depth < 32; depth++) {
      if (inputPid == pid)
        return true;
      auto parent = process(inputPid).parent;
      if (parent == inputPid)
        return false;
      inputPid = parent;
    }
    return false;
  }
  void run() {
    try {
      Connection connection(quit);
      initialized = 1;
      while (!quit &&
             PA_CONTEXT_IS_GOOD(pa_context_get_state(connection.context))) {
        std::vector<Input> inputs;
        struct Discovery {
          ApplicationAudio *self;
          std::vector<Input> *inputs;
        } request{this, &inputs};
        bool complete =
            connection.operation(pa_context_get_sink_input_info_list(
                connection.context,
                [](pa_context *, const pa_sink_input_info *info, int end,
                   void *data) {
                  auto *request = static_cast<Discovery *>(data);
                  if (end || !info)
                    return;
                  auto pid = processId(info->proplist);
                  if (request->self->includes(pid))
                    request->inputs->push_back({info->index,
                                                pid,
                                                info->sink,
                                                process(pid).started,
                                                {}});
                },
                &request));
        if (!complete)
          throw std::runtime_error(
              "Application audio streams could not be inspected");
        std::set<uint32_t> retained;
        for (auto &input : inputs) {
          if (retained.size() >= 16)
            throw std::runtime_error(
                "The application has too many audio streams to record safely");
          retained.insert(input.index);
          auto found = children.find(input.index);
          if (found != children.end() && found->second.input.pid == input.pid &&
              found->second.input.processStarted == input.processStarted &&
              found->second.input.sink == input.sink) {
            if (inputEnded(found->second.source))
              throw std::runtime_error(
                  "A selected application audio stream stopped. Restart "
                  "recording to reconnect");
            continue;
          }
          if (found != children.end()) {
            obs_sceneitem_remove(found->second.item);
            obs_source_release(found->second.source);
            children.erase(found);
          }
          connection.operation(pa_context_get_sink_info_by_index(
              connection.context, input.sink,
              [](pa_context *, const pa_sink_info *sink, int end, void *data) {
                if (!end && sink && sink->monitor_source_name)
                  static_cast<Input *>(data)->monitor =
                      sink->monitor_source_name;
              },
              &input));
          if (input.monitor.empty())
            continue;
          auto *settings = obs_data_create();
          obs_data_set_int(settings, "index", input.index);
          obs_data_set_int(settings, "pid", input.pid);
          obs_data_set_int(settings, "sink", input.sink);
          obs_data_set_int(settings, "started", int64_t(input.processStarted));
          obs_data_set_string(settings, "monitor", input.monitor.c_str());
          auto *source = obs_source_create_private(
              "attaclip_pulse_input", "Verified application audio input",
              settings);
          obs_data_release(settings);
          if (!source || inputEnded(source)) {
            if (source)
              obs_source_release(source);
            throw std::runtime_error(
                "Application audio input could not be opened");
          }
          obs_source_set_audio_mixers(source, mixers);
          auto *item = obs_scene_add(scene, source);
          children.emplace(input.index, Child{input, source, item});
        }
        for (auto it = children.begin(); it != children.end();) {
          if (!retained.count(it->first)) {
            obs_sceneitem_remove(it->second.item);
            obs_source_release(it->second.source);
            it = children.erase(it);
          } else
            ++it;
        }
        auto deadline =
            std::chrono::steady_clock::now() + std::chrono::milliseconds(250);
        while (!quit && std::chrono::steady_clock::now() < deadline)
          connection.iterate();
      }
      if (!quit)
        throw std::runtime_error(
            "PulseAudio disconnected. Application audio has stopped");
    } catch (const std::exception &failure) {
      for (auto &entry : children) {
        obs_sceneitem_remove(entry.second.item);
        obs_source_release(entry.second.source);
      }
      children.clear();
      {
        std::lock_guard<std::mutex> lock(errorMutex);
        error = failure.what();
      }
      initialized = -1;
    }
  }
};
void registerLinuxApplicationAudio() {
  obs_source_info info{};
  info.id = "attaclip_pulse_input";
  info.type = OBS_SOURCE_TYPE_INPUT;
  info.output_flags = OBS_SOURCE_AUDIO;
  info.get_name = [](void *) { return "Verified application audio input"; };
  info.create = [](obs_data_t *settings, obs_source_t *source) -> void * {
    try {
      auto *input = new MonitoredInput(settings, source);
      std::lock_guard<std::mutex> lock(inputMutex);
      liveInputs.emplace(source, input);
      return input;
    } catch (...) {
      return nullptr;
    }
  };
  info.destroy = [](void *data) {
    auto *input = static_cast<MonitoredInput *>(data);
    if (!input)
      return;
    {
      std::lock_guard<std::mutex> lock(inputMutex);
      liveInputs.erase(input->source);
    }
    delete input;
  };
  obs_register_source(&info);
}
ApplicationAudio *createApplicationAudio(uint32_t pid, uint32_t mixers) {
  auto *audio = new ApplicationAudio(pid, mixers);
  auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(3);
  while (!audio->initialized && std::chrono::steady_clock::now() < deadline)
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  if (audio->initialized != 1) {
    auto message = applicationAudioError(audio);
    delete audio;
    throw std::runtime_error(
        message.empty() ? "Application audio did not initialize" : message);
  }
  return audio;
}
obs_source_t *applicationAudioSource(ApplicationAudio *audio) {
  return audio ? obs_scene_get_source(audio->scene) : nullptr;
}
std::string applicationAudioError(ApplicationAudio *audio) {
  if (!audio)
    return {};
  std::lock_guard<std::mutex> lock(audio->errorMutex);
  return audio->error;
}
void destroyApplicationAudio(ApplicationAudio *audio) { delete audio; }
