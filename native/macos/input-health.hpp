// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
#include <algorithm>
#include <chrono>
#include <functional>
#include <string>
#include <vector>

namespace attaclip::macos {
// Device presence and permission are not proof that an AudioUnit is producing
// samples. They do let us report revocation and unplugging without treating a
// quiet microphone as a failed input or polling the hardware for every packet.
class InputHealth {
public:
  using Clock = std::chrono::steady_clock;
  std::string error(const std::string &device, Clock::time_point now,
                    const std::function<bool()> &permission,
                    const std::function<std::vector<std::string>()> &inventory) {
    if (now >= nextPermission) {
      authorized = permission();
      nextPermission = now + std::chrono::milliseconds(100);
    }
    if (!authorized)
      return "Microphone access was revoked. Allow AttaClip in System Settings";
    if (now >= nextInventory) {
      devices = inventory();
      nextInventory = now + std::chrono::seconds(1);
    }
    if (std::find(devices.begin(), devices.end(), device) == devices.end())
      return "The selected microphone is unavailable. Reconnect it or select another input";
    return {};
  }
private:
  Clock::time_point nextPermission{}, nextInventory{};
  bool authorized = false;
  std::vector<std::string> devices;
};
}
