// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
#include <memory>
#include <obs.h>
#include <string>

namespace attaclip::wayland {
bool requested();
bool enabled();
// Must precede obs_startup. Keep this object alive through obs_shutdown.
class Platform {
public:
  Platform();
  ~Platform();
  Platform(const Platform &) = delete;
  Platform &operator=(const Platform &) = delete;
};
void loadModule(const std::string &file, const std::string &data);
bool screenAvailable();
struct Health {
  bool authorized = false, closed = false, failed = false, valid = false;
  int state = 0;
  bool working() const;
  std::string message() const;
};
class Capture {
public:
  explicit Capture(obs_source_t *source);
  ~Capture();
  obs_source_t *source() const;
  Health health() const;
  void closeSession();

private:
  obs_source_t *value;
};
std::shared_ptr<Capture> createScreen();
} // namespace attaclip::wayland
