// SPDX-License-Identifier: GPL-2.0-or-later
#include "platform.hpp"
#include <cstdlib>
#include <functional>
#include <future>
#include <gio/gio.h>
#include <obs-nix-platform.h>
#include <stdexcept>
#include <thread>
#include <wayland-client.h>

namespace attaclip::wayland {
namespace {
wl_display *display = nullptr;
GMainLoop *loop = nullptr;
std::thread dispatcher;
void invoke(std::function<void()> callback) {
  if (!loop)
    throw std::runtime_error("The screen picker dispatcher is unavailable");
  if (g_main_context_is_owner(g_main_loop_get_context(loop))) {
    callback();
    return;
  }
  auto task = std::make_unique<std::packaged_task<void()>>(std::move(callback));
  auto result = task->get_future();
  auto *idle = g_idle_source_new();
  g_source_set_callback(
      idle,
      [](gpointer data) -> gboolean {
        (*static_cast<std::packaged_task<void()> *>(data))();
        return G_SOURCE_REMOVE;
      },
      task.release(),
      [](gpointer data) {
        delete static_cast<std::packaged_task<void()> *>(data);
      });
  g_source_attach(idle, g_main_loop_get_context(loop));
  g_source_unref(idle);
  result.get();
}
} // namespace
bool requested() {
  const char *socket = std::getenv("WAYLAND_DISPLAY");
  const char *session = std::getenv("XDG_SESSION_TYPE");
  return (socket && *socket) || (session && std::string(session) == "wayland");
}
bool enabled() { return display != nullptr; }
Platform::Platform() {
  if (!requested())
    return;
  display = wl_display_connect(nullptr);
  if (!display)
    throw std::runtime_error("The Wayland display could not be opened");
  obs_set_nix_platform(OBS_NIX_PLATFORM_WAYLAND);
  obs_set_nix_platform_display(display);
  loop = g_main_loop_new(nullptr, false);
  dispatcher = std::thread([] { g_main_loop_run(loop); });
  // Wait until dispatch is running, so invoke cannot acquire the context on
  // the command thread before the dispatcher enters its loop.
  while (!g_main_loop_is_running(loop))
    std::this_thread::yield();
}
Platform::~Platform() {
  if (!display)
    return;
  invoke([] {});
  g_main_loop_quit(loop);
  dispatcher.join();
  g_main_loop_unref(loop);
  loop = nullptr;
  wl_display_disconnect(display);
  display = nullptr;
}
void loadModule(const std::string &file, const std::string &data) {
  invoke([&] {
    obs_module_t *module = nullptr;
    if (obs_open_module(&module, file.c_str(), data.c_str()) !=
            MODULE_SUCCESS ||
        !obs_init_module(module))
      throw std::runtime_error(
          "The Wayland screen capture module could not be loaded");
  });
}
bool screenAvailable() {
  bool available = false;
  invoke([&] {
    GError *error = nullptr;
    auto *proxy = g_dbus_proxy_new_for_bus_sync(
        G_BUS_TYPE_SESSION, G_DBUS_PROXY_FLAGS_NONE, nullptr,
        "org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop",
        "org.freedesktop.portal.ScreenCast", nullptr, &error);
    if (proxy) {
      auto *types =
          g_dbus_proxy_get_cached_property(proxy, "AvailableSourceTypes");
      available = types && g_variant_is_of_type(types, G_VARIANT_TYPE_UINT32) &&
                  (g_variant_get_uint32(types) & 1);
      if (types)
        g_variant_unref(types);
      g_object_unref(proxy);
    }
    if (error)
      g_error_free(error);
  });
  return available;
}
bool Health::working() const {
  return authorized && valid && state == 3 && !closed && !failed;
}
std::string Health::message() const {
  if (failed && !authorized)
    return "Screen capture permission was declined";
  if (closed)
    return "Screen capture stopped";
  if (failed)
    return "Screen capture stopped";
  if (!authorized)
    return "Choose a screen in the system picker";
  if (!working())
    return "Waiting for screen capture";
  return {};
}
Capture::Capture(obs_source_t *source) : value(source) {}
Capture::~Capture() {
  invoke([source = value] { obs_source_release(source); });
}
obs_source_t *Capture::source() const { return value; }
Health Capture::health() const {
  calldata_t data{};
  calldata_init(&data);
  bool called = proc_handler_call(obs_source_get_proc_handler(value),
                                  "attaclip_status", &data);
  Health result;
  result.authorized = calldata_bool(&data, "authorized");
  result.closed = calldata_bool(&data, "closed");
  result.failed = !called || calldata_bool(&data, "failed");
  result.valid = calldata_bool(&data, "valid_frame");
  result.state = int(calldata_int(&data, "stream_state"));
  if (calldata_int(&data, "source_type") != 1)
    result.failed = true;
  calldata_free(&data);
  return result;
}
void Capture::closeSession() {
  invoke([this] {
    calldata_t data{};
    calldata_init(&data);
    bool called = proc_handler_call(obs_source_get_proc_handler(value),
                                    "attaclip_close", &data);
    calldata_free(&data);
    if (!called)
      throw std::runtime_error("The portal session could not be closed");
  });
}
std::shared_ptr<Capture> createScreen() {
  obs_source_t *source = nullptr;
  invoke([&] {
    auto *settings = obs_data_create();
    obs_data_set_bool(settings, "ShowCursor", true);
    source = obs_source_create_private("pipewire-desktop-capture-source",
                                       "Portal-selected screen", settings);
    obs_data_release(settings);
  });
  if (!source)
    throw std::runtime_error("The system screen picker could not be opened");
  auto capture = std::make_shared<Capture>(source);
  // The module's health bridge is required. Stale dimensions cannot establish
  // that permission was granted or that its stream remains usable.
  calldata_t data{};
  calldata_init(&data);
  bool called = proc_handler_call(obs_source_get_proc_handler(source),
                                  "attaclip_status", &data);
  calldata_free(&data);
  if (!called)
    throw std::runtime_error(
        "The screen capture module has no verified health bridge");
  return capture;
}
} // namespace attaclip::wayland
