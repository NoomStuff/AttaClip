// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
#include <cstdint>
#include <obs.h>
#include <string>
struct ApplicationAudio;
void registerLinuxApplicationAudio();
ApplicationAudio *createApplicationAudio(uint32_t pid, uint32_t mixers = 3);
obs_source_t *applicationAudioSource(ApplicationAudio *audio);
std::string applicationAudioError(ApplicationAudio *audio);
void destroyApplicationAudio(ApplicationAudio *audio);
