// SPDX-License-Identifier: GPL-2.0-or-later
#include "linux-process.hpp"
#include <algorithm>
#include <array>
#include <cctype>
#include <fstream>
#include <set>
#include <sstream>
#include <string>

namespace {
std::string lower(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(),
                 [](unsigned char c) { return char(std::tolower(c)); });
  return value;
}
std::string bounded(const std::filesystem::path &file, size_t maximum) {
  std::ifstream input(file, std::ios::binary);
  std::string data(maximum + 1, '\0');
  input.read(data.data(), std::streamsize(data.size()));
  data.resize(size_t(input.gcount()));
  return data.size() > maximum ? std::string{} : data;
}
bool portableExecutable(const std::filesystem::path &file) {
  std::ifstream input(file, std::ios::binary);
  std::array<unsigned char, 64> dos{};
  if (!input.read(reinterpret_cast<char *>(dos.data()), dos.size()) ||
      dos[0] != 'M' || dos[1] != 'Z')
    return false;
  uint32_t offset = uint32_t(dos[60]) | uint32_t(dos[61]) << 8 |
                    uint32_t(dos[62]) << 16 | uint32_t(dos[63]) << 24;
  if (offset < 64 || offset > 1024 * 1024)
    return false;
  input.seekg(offset);
  std::array<unsigned char, 24> header{};
  if (!input.read(reinterpret_cast<char *>(header.data()), header.size()) ||
      header[0] != 'P' || header[1] != 'E' || header[2] || header[3])
    return false;
  uint16_t flags = uint16_t(header[22]) | uint16_t(header[23]) << 8;
  return (flags & 2) && !(flags & 0x2000);
}
} // namespace
std::optional<WindowsProcessImage>
wineProcessImage(uint32_t pid, const std::filesystem::path &runtime) {
  auto loader = lower(runtime.filename().string());
  if (loader != "wine" && loader != "wine64" && loader != "wine-preloader" &&
      loader != "wine64-preloader")
    return {};
  auto arguments =
      bounded("/proc/" + std::to_string(pid) + "/cmdline", 16 * 1024);
  auto end = arguments.find('\0');
  if (end == std::string::npos)
    return {};
  std::string image = arguments.substr(0, end);
  if (lower(std::filesystem::path(image).filename().string()) == loader) {
    auto next = arguments.find('\0', end + 1);
    if (next == std::string::npos)
      return {};
    image = arguments.substr(end + 1, next - end - 1);
  }
  std::replace(image.begin(), image.end(), '\\', '/');
  auto basename = lower(std::filesystem::path(image).filename().string());
  if (basename.size() < 5 || basename.substr(basename.size() - 4) != ".exe")
    return {};
  auto maps = bounded("/proc/" + std::to_string(pid) + "/maps", 1024 * 1024);
  std::istringstream lines(maps);
  std::string line;
  std::set<std::filesystem::path> matches;
  while (std::getline(lines, line)) {
    std::istringstream fields(line);
    std::string field;
    for (int index = 0; index < 5; index++)
      if (!(fields >> field))
        break;
    std::string path;
    std::getline(fields >> std::ws, path);
    if (path.empty() || path[0] != '/' ||
        path.find_first_of("\r\n") != std::string::npos)
      continue;
    std::filesystem::path candidate(path);
    if (lower(candidate.filename().string()) == basename &&
        portableExecutable(candidate))
      matches.insert(candidate);
  }
  if (matches.size() != 1)
    return {};
  return WindowsProcessImage{*matches.begin(), runtime};
}
