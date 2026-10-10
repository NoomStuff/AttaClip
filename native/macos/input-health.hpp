// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
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

class InputDelivery {
public:
  using Clock = std::chrono::steady_clock;
  explicit InputDelivery(Clock::time_point now) : created(milliseconds(now)) {}
  void delivered(uint32_t frames, Clock::time_point now) {
    if (frames) last.store(milliseconds(now), std::memory_order_release);
  }
  std::string error(Clock::time_point now) const {
    const auto sampled = last.load(std::memory_order_acquire);
    const auto elapsed = milliseconds(now) - (sampled < 0 ? created : sampled);
    if (elapsed < 2000) return {};
    return sampled < 0
      ? "The microphone has not started sending audio. Reconnect it or select another input"
      : "The microphone stopped sending audio. Reconnect it or select another input";
  }
private:
  static int64_t milliseconds(Clock::time_point time) {
    return std::chrono::duration_cast<std::chrono::milliseconds>(time.time_since_epoch()).count();
  }
  const int64_t created;
  std::atomic<int64_t> last{-1};
};
}
