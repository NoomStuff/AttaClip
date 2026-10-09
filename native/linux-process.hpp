// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once
#include <cstdint>
#include <filesystem>
#include <optional>
struct WindowsProcessImage {
  std::filesystem::path executable;
  std::filesystem::path runtimeExecutable;
};
// Only a Wine loader's leading, mapped PE executable qualifies. Later .exe
// arguments and unverified names must not classify unrelated applications.
std::optional<WindowsProcessImage>
wineProcessImage(uint32_t pid, const std::filesystem::path &runtime);
