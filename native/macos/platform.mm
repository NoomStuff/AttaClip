// SPDX-License-Identifier: GPL-2.0-or-later
#import <AVFoundation/AVFoundation.h>
#import <Cocoa/Cocoa.h>
#import <CoreGraphics/CoreGraphics.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <VideoToolbox/VideoToolbox.h>
#include "platform.hpp"
#include <algorithm>
#include <atomic>
#include <chrono>
#include <csignal>
#include <mutex>
#include <memory>
#include <stdexcept>
#include <thread>
#include <unistd.h>
#include <utility>
#include <unordered_map>
#include <vector>

namespace attaclip::macos {
namespace {
std::filesystem::path runtime;
std::string graphics, mux;
std::atomic<uint32_t> selectedDisplay{0};
std::mutex availabilityMutex;
std::unordered_map<CGWindowID, pid_t> selectedOwners;
std::chrono::steady_clock::time_point checkedAt{};
uintptr_t checkedWindow = 0;
bool checkedAvailable = false;
struct CaptureHealth { std::atomic<bool> failed{false}; };
std::vector<std::unique_ptr<CaptureHealth>> sourceHealth;
std::atomic<CaptureHealth *> currentHealth{nullptr};
struct AudioTarget {
  CGWindowID window; pid_t pid; std::string bundle;
  std::chrono::steady_clock::time_point checkedAt{};
  std::string cachedError;
};
std::unordered_map<obs_source_t *, CaptureHealth *> audioHealth;
std::unordered_map<obs_source_t *, AudioTarget> audioTargets;

std::string text(CFStringRef value) {
  if (!value) return {};
  CFIndex capacity = CFStringGetMaximumSizeForEncoding(CFStringGetLength(value), kCFStringEncodingUTF8) + 1;
  std::string result(size_t(capacity), '\0');
  if (!CFStringGetCString(value, result.data(), capacity, kCFStringEncodingUTF8)) return {};
  result.resize(std::char_traits<char>::length(result.c_str()));
  return result;
}

uint32_t sourceNumber(const std::string &id, const std::string &prefix) {
  if (id.rfind(prefix, 0) != 0) return 0;
  const auto end = id.find(':', prefix.size());
  const auto number = id.substr(prefix.size(), end == std::string::npos ? end : end - prefix.size());
  if (number.empty() || number.find_first_not_of("0123456789") != std::string::npos) return 0;
  const auto value = std::stoull(number);
  if (value > UINT32_MAX) return 0;
  return uint32_t(value);
}

bool availableWindow(CGWindowID id, pid_t expectedOwner = 0, pid_t *owner = nullptr, bool requireOnscreen = true) {
  if (!id) return false;
  CFArrayRef list = CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, id);
  bool available = false;
  for (CFIndex i = 0; list && i < CFArrayGetCount(list); ++i) {
    auto entry = static_cast<CFDictionaryRef>(CFArrayGetValueAtIndex(list, i));
    auto onscreen = static_cast<CFBooleanRef>(CFDictionaryGetValue(entry, kCGWindowIsOnscreen));
    auto number = static_cast<CFNumberRef>(CFDictionaryGetValue(entry, kCGWindowNumber));
    uint32_t candidate = 0;
    int32_t pid = 0;
    if (number) CFNumberGetValue(number, kCFNumberSInt32Type, &candidate);
    auto process = static_cast<CFNumberRef>(CFDictionaryGetValue(entry, kCGWindowOwnerPID));
    if (process) CFNumberGetValue(process, kCFNumberSInt32Type, &pid);
    if (candidate == id && (!requireOnscreen || onscreen == kCFBooleanTrue) && (!expectedOwner || expectedOwner == pid)) {
      available = true;
      if (owner) *owner = pid;
    }
  }
  if (list) CFRelease(list);
  return available;
}

CGDirectDisplayID displayFor(const nlohmann::json &configuration) {
  uint32_t count = 0;
  if (CGGetActiveDisplayList(0, nullptr, &count) != kCGErrorSuccess || !count)
    throw std::runtime_error("No active screen is available");
  std::vector<CGDirectDisplayID> displays(count);
  if (CGGetActiveDisplayList(count, displays.data(), &count) != kCGErrorSuccess)
    throw std::runtime_error("The selected screen could not be identified");
  uint32_t requested = sourceNumber(configuration.value("sourceId", ""), "screen:");
  if (configuration.contains("displayId") && configuration["displayId"].is_string()) {
    const auto value = configuration["displayId"].get<std::string>();
    if (!value.empty() && value.find_first_not_of("0123456789") == std::string::npos)
      requested = uint32_t(std::stoul(value));
  }
  for (auto display : displays) if (requested && display == requested) return display;
  if (configuration.contains("bounds") && configuration["bounds"].is_object()) {
    const auto &wanted = configuration["bounds"];
    CGDirectDisplayID matched = 0;
    for (auto display : displays) {
      const auto bounds = CGDisplayBounds(display);
      if (bounds.origin.x == wanted.value("x", 0) && bounds.origin.y == wanted.value("y", 0) &&
          bounds.size.width == wanted.value("width", 0) && bounds.size.height == wanted.value("height", 0)) {
        if (matched) throw std::runtime_error("The selected screens cannot be distinguished safely");
        matched = display;
      }
    }
    if (matched) return matched;
  }
  throw std::runtime_error("The selected screen changed or was disconnected. Select it again");
}
}

void prepareProcess(const std::filesystem::path &root) {
  if (@available(macOS 13.0, *)) {} else
    throw std::runtime_error("Recording with application audio requires macOS 13 or later");
  signal(SIGPIPE, SIG_IGN);
  runtime = root;
  for (const char *name : {"libobs-opengl.dylib", "libobs-metal.dylib"}) {
    const auto path = root / "Frameworks" / name;
    if (std::filesystem::exists(path)) { graphics = path.string(); break; }
  }
  if (graphics.empty()) throw std::runtime_error("The macOS graphics module is missing from this build");
  mux = (root / "obs-ffmpeg-mux").string();
  if (!std::filesystem::exists(mux)) throw std::runtime_error("The clip-saving helper is missing from this build");
}

const char *graphicsModule() { return graphics.c_str(); }
const char *muxPath() { return mux.c_str(); }

bool startup(const char *locale, const char *configuration) {
  // OBS initializes Carbon keyboard layout APIs. macOS requires those calls on
  // the main thread, while capture commands must leave that thread's loop free.
  __block bool initialized = false;
  auto initialize = ^{ initialized = obs_startup(locale, configuration, nullptr); };
  if (NSThread.isMainThread) initialize();
  else dispatch_sync(dispatch_get_main_queue(), initialize);
  return initialized;
}

void loadModules() {
  for (const char *name : {"mac-capture", "mac-videotoolbox", "obs-ffmpeg", "obs-x264"}) {
    const auto contents = runtime / "PlugIns" / (std::string(name) + ".plugin") / "Contents";
    const auto binary = contents / "MacOS" / name;
    const auto data = contents / "Resources";
    obs_module_t *module = nullptr;
    if (obs_open_module(&module, binary.c_str(), data.c_str()) != MODULE_SUCCESS || !obs_init_module(module))
      throw std::runtime_error(std::string("The macOS recording module could not load: ") + name);
  }
}

obs_source_t *createCapture(const nlohmann::json &configuration) {
  if (!CGPreflightScreenCaptureAccess())
    throw std::runtime_error("Allow AttaClip in System Settings, Privacy & Security, Screen Recording, then reopen the app");
  const std::string kind = configuration.value("resolvedKind", configuration.value("sourceKind", "screen"));
  CGDirectDisplayID display = 0;
  CGWindowID window = 0;
  pid_t owner = 0;
  if (kind == "screen") display = displayFor(configuration);
  else if (kind == "app") {
    window = sourceNumber(configuration.value("sourceId", ""), "window:");
    if (!availableWindow(window, 0, &owner)) throw std::runtime_error("The selected application is unavailable");
  } else throw std::runtime_error("Choose a screen or application to record on macOS");
  auto *settings = obs_data_create();
  obs_data_set_int(settings, "type", kind == "screen" ? 0 : 1);
  obs_data_set_int(settings, "window", window);
  obs_data_set_bool(settings, "show_cursor", true);
  obs_data_set_bool(settings, "hide_obs", false);
  obs_data_set_bool(settings, "show_hidden_windows", false);
  if (display) {
    CFUUIDRef uuid = CGDisplayCreateUUIDFromDisplayID(display);
    CFStringRef value = uuid ? CFUUIDCreateString(kCFAllocatorDefault, uuid) : nullptr;
    const auto identity = text(value);
    if (value) CFRelease(value);
    if (uuid) CFRelease(uuid);
    if (identity.empty()) { obs_data_release(settings); throw std::runtime_error("The selected screen could not be identified"); }
    obs_data_set_string(settings, "display_uuid", identity.c_str());
  }
  auto *source = obs_source_create_private("screen_capture", "Capture", settings);
  obs_data_release(settings);
  if (!source) throw std::runtime_error("ScreenCaptureKit could not open the selected source");
  // SCK can return a source object with a failed or missing stream. Require an
  // actual frame before calling this a successful acquisition.
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
  while ((!obs_source_get_width(source) || !obs_source_get_height(source)) && std::chrono::steady_clock::now() < deadline)
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
  if (!obs_source_get_width(source) || !obs_source_get_height(source)) {
    obs_source_release(source);
    throw std::runtime_error("No frames arrived from the selected source. Check Screen Recording permission and select it again");
  }
  auto health = std::make_unique<CaptureHealth>();
  auto *healthState = health.get();
  // In the pinned SCK module, this signal follows didStopWithError. The source
  // can retain its last IOSurface after failure, which must not count as capture.
  signal_handler_connect(obs_source_get_signal_handler(source), "update_properties",
      [](void *state, calldata_t *) { static_cast<CaptureHealth *>(state)->failed = true; }, healthState);
  currentHealth = healthState;
  sourceHealth.push_back(std::move(health));
  if (display) selectedDisplay = display;
  {
    std::lock_guard<std::mutex> lock(availabilityMutex);
    if (window) selectedOwners[window] = owner;
    checkedAt = {};
  }
  return source;
}

bool targetAvailable(uintptr_t window) {
  auto *health = currentHealth.load();
  if (health && health->failed.load()) return false;
  std::lock_guard<std::mutex> lock(availabilityMutex);
  const auto now = std::chrono::steady_clock::now();
  if (checkedWindow == window && now - checkedAt < std::chrono::milliseconds(100)) return checkedAvailable;
  checkedWindow = window;
  checkedAt = now;
  const auto owner = selectedOwners.find(CGWindowID(window));
  checkedAvailable = CGPreflightScreenCaptureAccess() && (window
      ? owner != selectedOwners.end() && availableWindow(CGWindowID(window), owner->second)
      : selectedDisplay.load() && CGDisplayIsActive(selectedDisplay.load()));
  return checkedAvailable;
}

std::string captureError() {
  auto *health = currentHealth.load();
  return health && health->failed.load()
      ? "Screen capture stopped. Stop recording and select the source again."
      : "";
}

nlohmann::json candidates() {
  nlohmann::json result = nlohmann::json::array();
  if (!CGPreflightScreenCaptureAccess()) return result;
  const pid_t foreground = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
  CFArrayRef list = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
  for (CFIndex i = 0; list && i < CFArrayGetCount(list); ++i) {
    auto entry = static_cast<CFDictionaryRef>(CFArrayGetValueAtIndex(list, i));
    int64_t window = 0, pid = 0, layer = 0;
    for (const auto &field : {std::pair<CFStringRef, int64_t *>{kCGWindowNumber, &window}, {kCGWindowOwnerPID, &pid}, {kCGWindowLayer, &layer}}) {
      auto value = static_cast<CFNumberRef>(CFDictionaryGetValue(entry, field.first));
      if (value) CFNumberGetValue(value, kCFNumberSInt64Type, field.second);
    }
    if (!window || !pid || layer != 0 || pid == getpid()) continue;
    const auto name = text(static_cast<CFStringRef>(CFDictionaryGetValue(entry, kCGWindowName)));
    NSRunningApplication *application = [NSRunningApplication runningApplicationWithProcessIdentifier:pid_t(pid)];
    const char *path = application.executableURL.path.UTF8String;
    if (name.empty() || !path || !*path) continue;
    CGRect bounds{};
    auto value = static_cast<CFDictionaryRef>(CFDictionaryGetValue(entry, kCGWindowBounds));
    bool fullscreen = false;
    if (value && CGRectMakeWithDictionaryRepresentation(value, &bounds)) {
      CGDirectDisplayID displays[32]{};
      uint32_t count = 0;
      if (CGGetDisplaysWithRect(bounds, 32, displays, &count) == kCGErrorSuccess) {
        for (uint32_t display = 0; display < count; ++display)
          if (CGRectContainsRect(bounds, CGDisplayBounds(displays[display]))) fullscreen = true;
      }
    }
    result.push_back({{"id", "window:" + std::to_string(window) + ":0"}, {"name", name}, {"executable", path},
                      {"pid", pid}, {"foreground", pid == foreground}, {"fullscreen", fullscreen}});
  }
  if (list) CFRelease(list);
  return result;
}

bool foregroundFullscreen() {
  for (const auto &candidate : candidates())
    if (candidate.value("foreground", false) && candidate.value("fullscreen", false)) return true;
  return false;
}

void requireMicrophonePermission() {
  if ([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio] != AVAuthorizationStatusAuthorized)
    throw std::runtime_error("Allow AttaClip microphone access in System Settings before recording your microphone");
}

namespace {
obs_source_t *audioSource(obs_data_t *settings, const std::string &name) {
  if (!CGPreflightScreenCaptureAccess()) {
    obs_data_release(settings);
    throw std::runtime_error("Allow AttaClip in System Settings, Privacy & Security, Screen Recording, then reopen the app");
  }
  auto *source = obs_source_create_private("sck_audio_capture", name.c_str(), settings);
  obs_data_release(settings);
  if (!source) throw std::runtime_error("ScreenCaptureKit could not open the selected audio source");
  auto health = std::make_unique<CaptureHealth>();
  auto *state = health.get();
  signal_handler_connect(obs_source_get_signal_handler(source), "update_properties",
      [](void *value, calldata_t *) { static_cast<CaptureHealth *>(value)->failed = true; }, state);
  sourceHealth.push_back(std::move(health));
  std::lock_guard<std::mutex> lock(availabilityMutex);
  audioHealth[source] = state;
  return source;
}

std::string applicationBundle(CGWindowID window, pid_t pid) {
  @autoreleasepool {
  if (!pid || !availableWindow(window, pid, nullptr, false))
    throw std::runtime_error("The application audio target changed");
  NSRunningApplication *application = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
  NSString *bundle = application.bundleIdentifier;
  if (!bundle.length || application.terminated)
    throw std::runtime_error("This application cannot be identified for separate audio capture");
  unsigned matching = 0;
  for (NSRunningApplication *candidate in NSWorkspace.sharedWorkspace.runningApplications)
    if (!candidate.terminated && [candidate.bundleIdentifier isEqualToString:bundle]) ++matching;
  // The official audio source selects a bundle, not a PID. Never widen an
  // exact process choice to another independently running instance.
  if (matching != 1)
    throw std::runtime_error("Multiple instances of this application are running. Close the other instances before capturing its audio");
  return bundle.UTF8String;
  }
}
}

obs_source_t *createApplicationAudio(uintptr_t window, int64_t pid, const std::string &name) {
  if (window > UINT32_MAX || pid <= 0 || pid > INT32_MAX)
    throw std::runtime_error("The application audio target is invalid");
  const auto bundle = applicationBundle(CGWindowID(window), pid_t(pid));
  auto *settings = obs_data_create();
  obs_data_set_int(settings, "type", 1);
  obs_data_set_string(settings, "application", bundle.c_str());
  auto *source = audioSource(settings, name);
  {
    std::lock_guard<std::mutex> lock(availabilityMutex);
    audioTargets[source] = {CGWindowID(window), pid_t(pid), bundle};
  }
  return source;
}

obs_source_t *createSystemAudio(const std::string &name) {
  if (!CGDisplayIsActive(CGMainDisplayID()))
    throw std::runtime_error("System audio capture needs an active screen");
  auto *settings = obs_data_create();
  obs_data_set_int(settings, "type", 0);
  auto *source = audioSource(settings, name);
  std::lock_guard<std::mutex> lock(availabilityMutex);
  audioTargets[source] = {0, 0, {}};
  return source;
}

std::string audioError(obs_source_t *source, uintptr_t window, int64_t pid) {
  if (!source) return {};
  const char *type = obs_source_get_id(source);
  if (!type || std::string(type) != "sck_audio_capture") return {};
  std::lock_guard<std::mutex> lock(availabilityMutex);
  auto health = audioHealth.find(source);
  if (health != audioHealth.end() && health->second->failed.load()) return "Audio capture stopped. Stop recording and select the source again";
  auto target = audioTargets.find(source);
  if (target == audioTargets.end()) return "The audio source could not be identified";
  if (window != target->second.window || pid != target->second.pid) return "The application audio target changed";
  auto &state = target->second;
  const auto now = std::chrono::steady_clock::now();
  if (now - state.checkedAt < std::chrono::milliseconds(100)) return state.cachedError;
  state.checkedAt = now;
  state.cachedError.clear();
  if (!CGPreflightScreenCaptureAccess()) state.cachedError = "Screen Recording permission is required for system and application audio";
  else if (state.window) {
    try {
      if (applicationBundle(state.window, state.pid) != state.bundle) state.cachedError = "The application audio target changed";
    } catch (const std::exception &error) { state.cachedError = error.what(); }
  }
  return state.cachedError;
}

nlohmann::json outputDevices() {
  // SCK captures the system mix. It does not isolate a physical output device.
  return nlohmann::json::array({{{"id", "system"}, {"name", "System audio"}}});
}

std::vector<std::string> hardwareEncoders() {
  CFArrayRef encoders = nullptr;
  if (VTCopyVideoEncoderList(nullptr, &encoders) != noErr || !encoders) return {};
  std::vector<std::string> result;
  for (CFIndex i = 0; i < CFArrayGetCount(encoders); ++i) {
    auto entry = static_cast<CFDictionaryRef>(CFArrayGetValueAtIndex(encoders, i));
    auto hardware = static_cast<CFBooleanRef>(CFDictionaryGetValue(entry, kVTVideoEncoderList_IsHardwareAccelerated));
    auto codec = static_cast<CFNumberRef>(CFDictionaryGetValue(entry, kVTVideoEncoderList_CodecType));
    CMVideoCodecType type = 0;
    if (codec) CFNumberGetValue(codec, kCFNumberSInt32Type, &type);
    if (hardware != kCFBooleanTrue || type != kCMVideoCodecType_H264) continue;
    const auto id = text(static_cast<CFStringRef>(CFDictionaryGetValue(entry, kVTVideoEncoderList_EncoderID)));
    const char *registered = nullptr;
    for (size_t j = 0; obs_enum_encoder_types(j, &registered); ++j)
      if (id == registered) { result.push_back(id); break; }
  }
  CFRelease(encoders);
  return result;
}

std::string hardwareEncoder(obs_data_t *settings, int cq, int width, int height, int fps) {
  const auto encoders = hardwareEncoders();
  if (encoders.empty()) return {};
  const auto &chosen = encoders.front();
  auto *properties = obs_get_encoder_properties(chosen.c_str());
  auto *rates = properties ? obs_properties_get(properties, "rate_control") : nullptr;
  bool qualityRate = false;
  if (rates) for (size_t i = 0; i < obs_property_list_item_count(rates); ++i)
    if (std::string(obs_property_list_item_string(rates, i)) == "CRF") qualityRate = true;
  obs_properties_destroy(properties);
  obs_data_set_string(settings, "rate_control", qualityRate ? "CRF" : "ABR");
  obs_data_set_int(settings, "quality", std::clamp(100 - (cq - 12) * 2, 35, 95));
  obs_data_set_int(settings, "bitrate", std::clamp(int(double(width) * height * fps * 0.1 * (35 - cq) / 12000.), 2000, 64000));
  obs_data_set_int(settings, "keyint_sec", 1);
  obs_data_set_bool(settings, "bframes", false);
  obs_data_set_string(settings, "profile", "high");
  return chosen;
}
}
