// SPDX-License-Identifier: GPL-2.0-or-later
#include "input-health.hpp"
#include <cassert>
#include <iostream>

int main() {
  using attaclip::macos::InputHealth;
  InputHealth health;
  int permissionReads = 0, inventoryReads = 0;
  bool authorized = true;
  std::vector<std::string> devices = {"default", "usb-headset", "built-in"};
  auto permission = [&] { ++permissionReads; return authorized; };
  auto inventory = [&] { ++inventoryReads; return devices; };
  auto check = [&](const std::string &device, int milliseconds) {
    return health.error(device, InputHealth::Clock::time_point(std::chrono::milliseconds(milliseconds)), permission, inventory);
  };
  assert(check("usb-headset", 0).empty());
  // Different rows share the actual permission/inventory read, rather than
  // triggering expensive hardware queries for each encoder packet.
  for (int ms = 1; ms < 100; ms++) {
    assert(check("usb-headset", ms).empty());
    assert(check("built-in", ms).empty());
  }
  assert(permissionReads == 1 && inventoryReads == 1);
  assert(!check("old-device-id", 99).empty());
  authorized = false;
  auto revoked = check("usb-headset", 100);
  assert(revoked.find("access") != std::string::npos);
  assert(permissionReads == 2 && inventoryReads == 1);
  // Denial never tries to open or inspect another input as a substitute.
  assert(check("built-in", 199) == revoked);
  authorized = true;
  assert(check("usb-headset", 200).empty());
  devices = {"default", "built-in"};
  assert(check("usb-headset", 999).empty());
  assert(check("usb-headset", 1000).find("unavailable") != std::string::npos);
  assert(check("built-in", 1000).empty());
  assert(inventoryReads == 2);
  devices = {"default", "usb-headset", "built-in"};
  assert(check("usb-headset", 2000).empty());
  assert(inventoryReads == 3);
  devices.clear();
  assert(check("default", 3000).find("unavailable") != std::string::npos);
  auto at = [](int ms) { return InputHealth::Clock::time_point(std::chrono::milliseconds(ms)); };
  attaclip::macos::InputDelivery delivery(at(0));
  assert(delivery.error(at(0)).empty());
  assert(delivery.error(at(1999)).empty());
  assert(delivery.error(at(2000)).find("not started") != std::string::npos);
  // Empty callbacks cannot pretend a disconnected AudioUnit recovered.
  delivery.delivered(0, at(2100));
  assert(!delivery.error(at(2200)).empty());
  // Frames count regardless of amplitude, gain or mute. A quiet microphone is
  // healthy; waiting for a nonzero peak would reject ordinary silence.
  delivery.delivered(480, at(2300));
  assert(delivery.error(at(2300)).empty());
  assert(delivery.error(at(4299)).empty());
  assert(delivery.error(at(4300)).find("stopped") != std::string::npos);
  delivery.delivered(480, at(4400));
  assert(delivery.error(at(4400)).empty());
  assert(delivery.error(at(6399)).empty());
  assert(!delivery.error(at(6400)).empty());
  std::cout << "Mac microphone permission, device loss, recovery and bounded polling policy passed\n";
}
