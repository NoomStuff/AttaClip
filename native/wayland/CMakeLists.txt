cmake_minimum_required(VERSION 3.24)
project(attaclip_pipewire_module LANGUAGES C)
set(CMAKE_C_STANDARD 17)
set(OBS_PIPEWIRE_SOURCE_DIR "" CACHE PATH "Patched matching OBS source tree")
if(NOT OBS_PIPEWIRE_SOURCE_DIR)
  message(FATAL_ERROR "Provide matching OBS_PIPEWIRE_SOURCE_DIR with the checked health patch")
endif()
find_package(libobs REQUIRED)
find_package(PkgConfig REQUIRED)
pkg_check_modules(PIPEWIRE REQUIRED IMPORTED_TARGET libpipewire-0.3)
pkg_check_modules(GIO REQUIRED IMPORTED_TARGET gio-2.0 gio-unix-2.0)
pkg_check_modules(DRM REQUIRED IMPORTED_TARGET libdrm)
set(module "${OBS_PIPEWIRE_SOURCE_DIR}/plugins/linux-pipewire")
add_library(linux-pipewire MODULE
  "${module}/camera-portal.c" "${module}/formats.c"
  "${module}/linux-pipewire.c" "${module}/pipewire.c"
  "${module}/portal.c" "${module}/screencast-portal.c"
  "${OBS_PIPEWIRE_SOURCE_DIR}/deps/glad/src/glad.c")
target_include_directories(linux-pipewire PRIVATE
  "${module}" "${OBS_PIPEWIRE_SOURCE_DIR}/deps/glad/include")
target_link_libraries(linux-pipewire PRIVATE
  OBS::libobs PkgConfig::PIPEWIRE PkgConfig::GIO PkgConfig::DRM ${CMAKE_DL_LIBS})
set_target_properties(linux-pipewire PROPERTIES PREFIX "" BUILD_RPATH "$ORIGIN/../lib" INSTALL_RPATH "$ORIGIN/../lib")
