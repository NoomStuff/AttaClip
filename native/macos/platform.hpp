// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
#include <cstdint>
#include <filesystem>
#include <json.hpp>
#include <obs.h>
#include <string>
#include <vector>

namespace attaclip::macos {
void prepareProcess(const std::filesystem::path &root);
bool startup(const char *locale, const char *configuration);
const char *graphicsModule();
const char *muxPath();
void loadModules();
obs_source_t *createCapture(const nlohmann::json &configuration);
bool targetAvailable(uintptr_t window);
std::string captureError();
nlohmann::json candidates();
bool foregroundFullscreen();
void requireMicrophonePermission();
void watchInput(obs_source_t *source);
void forgetInput(obs_source_t *source);
obs_source_t *createApplicationAudio(uintptr_t window, int64_t pid, const std::string &name);
obs_source_t *createSystemAudio(const std::string &name);
std::string audioError(obs_source_t *source, uintptr_t window, int64_t pid);
nlohmann::json outputDevices();
std::vector<std::string> hardwareEncoders();
std::string hardwareEncoder(obs_data_t *settings, int cq, int width, int height,
                            int fps);
}
