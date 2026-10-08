// SPDX-License-Identifier: GPL-2.0-or-later
// Reads an application's own Composite pixmap. Never reads or crops the root
// window, so an overlapping application cannot leak into the recording.
#include "x11-compat.hpp"
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <mutex>
#include <obs.h>
#include <thread>
#include <unordered_map>
#include <util/platform.h>
#include <xcb/composite.h>
#include <xcb/xcb.h>

namespace {
struct Availability {
  std::atomic<uint64_t> lastFrame{0};
};
std::mutex availabilityMutex;
std::unordered_map<xcb_window_t, std::shared_ptr<Availability>> availability;
bool supportedVisual(xcb_connection_t *connection, xcb_visualid_t visual) {
  auto screens = xcb_setup_roots_iterator(xcb_get_setup(connection));
  for (; screens.rem; xcb_screen_next(&screens)) {
    auto depths = xcb_screen_allowed_depths_iterator(screens.data);
    for (; depths.rem; xcb_depth_next(&depths)) {
      auto visuals = xcb_depth_visuals_iterator(depths.data);
      for (; visuals.rem; xcb_visualtype_next(&visuals)) {
        auto *value = visuals.data;
        if (value->visual_id == visual) blog(LOG_WARNING, "X11 compatibility visual class=%u masks=%x/%x/%x", value->_class, value->red_mask, value->green_mask, value->blue_mask);
        if (value->visual_id == visual)
          return value->_class == XCB_VISUAL_CLASS_TRUE_COLOR &&
                 value->red_mask == 0xff0000 && value->green_mask == 0xff00 &&
                 value->blue_mask == 0xff;
      }
    }
  }
  return false;
}
struct Source {
  obs_source_t *source;
  xcb_window_t window;
  int fps;
  std::atomic<bool> quit{false};
  std::shared_ptr<Availability> state = std::make_shared<Availability>();
  std::thread thread;
  Source(obs_data_t *settings, obs_source_t *value)
      : source(value), window(uint32_t(obs_data_get_int(settings, "window"))),
        fps(int(obs_data_get_int(settings, "fps"))) {
    {
      std::lock_guard<std::mutex> lock(availabilityMutex);
      availability[window] = state;
    }
    thread = std::thread([this] { capture(); });
  }
  ~Source() {
    quit = true;
    thread.join();
    std::lock_guard<std::mutex> lock(availabilityMutex);
    auto found = availability.find(window);
    if (found != availability.end() && found->second == state)
      availability.erase(found);
  }
  void capture() {
    auto *connection = xcb_connect(nullptr, nullptr);
    if (xcb_connection_has_error(connection)) {
      xcb_disconnect(connection);
      return;
    }
    auto *error = xcb_request_check(
        connection, xcb_composite_redirect_window_checked(
                        connection, window, XCB_COMPOSITE_REDIRECT_AUTOMATIC));
    if (error) {
      free(error);
      xcb_disconnect(connection);
      return;
    }
    xcb_pixmap_t pixmap = 0;
    uint16_t width = 0, height = 0;
    int interval = 1000000 / std::clamp(fps, 1, 120);
    while (!quit) {
      auto start = std::chrono::steady_clock::now();
      auto *attributes = xcb_get_window_attributes_reply(
          connection, xcb_get_window_attributes(connection, window), nullptr);
      bool viewable =
          attributes && attributes->map_state == XCB_MAP_STATE_VIEWABLE;
      bool visual =
          attributes && supportedVisual(connection, attributes->visual);
      free(attributes);
      auto *geometry =
          viewable
              ? xcb_get_geometry_reply(
                    connection, xcb_get_geometry(connection, window), nullptr)
              : nullptr;
      if (geometry && geometry->width && geometry->height && visual &&
          uint64_t(geometry->width) * geometry->height <= 32ULL * 1024 * 1024 &&
          (geometry->depth == 24 || geometry->depth == 32)) {
        if (!pixmap || width != geometry->width || height != geometry->height) {
          if (pixmap)
            xcb_free_pixmap(connection, pixmap);
          pixmap = xcb_generate_id(connection);
          auto *error = xcb_request_check(
              connection, xcb_composite_name_window_pixmap_checked(
                              connection, window, pixmap));
          if (error) {
            free(error);
            pixmap = 0;
          }
          width = geometry->width;
          height = geometry->height;
        }
        auto *image =
            pixmap
                ? xcb_get_image_reply(
                      connection,
                      xcb_get_image(connection, XCB_IMAGE_FORMAT_Z_PIXMAP,
                                    pixmap, 0, 0, width, height, ~uint32_t(0)),
                      nullptr)
                : nullptr;
        if (image) {
          // X11 ZPixmap scanlines are padded to 32 bits on the supported
          // little-endian, TrueColor 24/32-bit X11 sessions.
          auto setup = xcb_get_setup(connection);
          int bytes = xcb_get_image_data_length(image);
          if (setup->image_byte_order == XCB_IMAGE_ORDER_LSB_FIRST &&
              bytes >= int(width) * height * 4) {
            obs_source_frame frame{};
            frame.format = VIDEO_FORMAT_BGRX;
            frame.width = width;
            frame.height = height;
            frame.data[0] = xcb_get_image_data(image);
            frame.linesize[0] = uint32_t(bytes / height);
            frame.timestamp = os_gettime_ns();
            obs_source_output_video(source, &frame);
            state->lastFrame = frame.timestamp;
          }
          free(image);
        }
      }
      free(geometry);
      std::this_thread::sleep_until(start +
                                    std::chrono::microseconds(interval));
    }
    if (pixmap)
      xcb_free_pixmap(connection, pixmap);
    xcb_disconnect(connection);
  }
};
} // namespace
bool x11CompatibilityAvailable(uintptr_t window) {
  std::lock_guard<std::mutex> lock(availabilityMutex);
  auto found = availability.find(uint32_t(window));
  return found != availability.end() &&
         os_gettime_ns() - found->second->lastFrame.load() < 1000000000ULL;
}
void registerX11CompatibilitySource() {
  obs_source_info info{};
  info.id = "attaclip_x11_window";
  info.type = OBS_SOURCE_TYPE_INPUT;
  info.output_flags = OBS_SOURCE_ASYNC_VIDEO;
  info.get_name = [](void *) {
    return "X11 application compatibility capture";
  };
  info.create = [](obs_data_t *settings, obs_source_t *source) -> void * {
    return new Source(settings, source);
  };
  info.destroy = [](void *data) { delete static_cast<Source *>(data); };
  obs_register_source(&info);
}
