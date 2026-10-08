#import <Cocoa/Cocoa.h>
#import <CoreGraphics/CoreGraphics.h>
#import <AVFoundation/AVFoundation.h>
#include <obs.h>
#include <obs-module.h>
#include <util/base.h>
#include <cstdio>
#include <json.hpp>
#include <filesystem>
#include <iostream>
#include <stdexcept>

// This does not create capture sources, open devices, request permissions or
// enable the production Mac recorder. CI proves linking and module loading.
int main(int argc, char **argv) {
  @autoreleasepool {
    bool started = false;
    try {
      if (argc != 3) throw std::runtime_error("Expected OBS.app and isolated config directory");
      const std::filesystem::path app(argv[1]);
      base_set_log_handler([](int, const char *format, va_list args, void *) {
        vfprintf(stderr, format, args);
        fputc('\n', stderr);
      }, nullptr);
      [NSApplication sharedApplication];
      if (!obs_startup("en-US", argv[2], nullptr)) throw std::runtime_error("libOBS startup failed");
      started = true;
      nlohmann::json result = {{"schema", 1}, {"obsVersion", obs_get_version_string()},
        {"captureTested", false}, {"permissionsRequested", false}, {"productionCaptureEnabled", false}};
      result["modules"] = nlohmann::json::array();
      for (const char *name : {"mac-capture", "mac-videotoolbox", "obs-ffmpeg", "obs-x264"}) {
        const auto bundle = app / "Contents/PlugIns" / (std::string(name) + ".plugin") / "Contents";
        const auto binary = bundle / "MacOS" / name;
        const auto data = bundle / "Resources";
        obs_module_t *module = nullptr;
        const int status = obs_open_module(&module, binary.c_str(), data.c_str());
        if (status != MODULE_SUCCESS || !obs_init_module(module))
          throw std::runtime_error(std::string("Module loading failed: ") + name);
        result["modules"].push_back({{"name", name}, {"loaded", true}});
      }
      obs_post_load_modules();
      result["sources"] = nlohmann::json::array();
      const char *id = nullptr;
      for (size_t i = 0; obs_enum_source_types(i, &id); ++i) result["sources"].push_back(id);
      result["encoders"] = nlohmann::json::array();
      for (size_t i = 0; obs_enum_encoder_types(i, &id); ++i)
        result["encoders"].push_back({{"id", id}, {"codec", obs_get_encoder_codec(id)}});
      const auto hasSource = [&result](const char *source) {
        for (const auto &entry : result["sources"]) if (entry == source) return true;
        return false;
      };
      if (!hasSource("screen_capture") || !hasSource("coreaudio_input_capture"))
        throw std::runtime_error("Required ScreenCaptureKit/CoreAudio source registration is absent");
      bool h264 = false;
      for (const auto &encoder : result["encoders"]) if (encoder["codec"] == "h264") h264 = true;
      if (!h264) throw std::runtime_error("No H264 encoder was registered");
      result["screenPermissionGranted"] = bool(CGPreflightScreenCaptureAccess());
      result["microphoneAuthorization"] = int([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio]);
      CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.1, false);
      obs_shutdown();
      started = false;
      std::cout << result.dump(2) << std::endl;
      return 0;
    } catch (const std::exception &error) {
      if (started) obs_shutdown();
      std::cerr << error.what() << std::endl;
      return 1;
    }
  }
}
