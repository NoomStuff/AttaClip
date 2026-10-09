// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
#include <cstdint>
#include <filesystem>
#include <json.hpp>
#include <obs.h>
#include <string>

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
std::string hardwareEncoder(obs_data_t *settings, int cq, int width, int height,
                            int fps);
}
