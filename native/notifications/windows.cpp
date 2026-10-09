#include <windows.h>
#include <objidl.h>
#include <psapi.h>
#include <algorithm>
using std::min;
using std::max;
#include <gdiplus.h>
#include <cmath>
#include <iostream>
#include <string>
#include <thread>
#include <json.hpp>

using json = nlohmann::json;
using namespace Gdiplus;
namespace {
constexpr UINT noticeMessage = WM_APP + 1;
constexpr UINT closeMessage = WM_APP + 2;
constexpr UINT metricsMessage = WM_APP + 3;
HWND window = nullptr;
std::wstring text;
bool error = false, saving = false, animate = true;
ULONGLONG started = 0;
int lifetime = 2400;
float scale = 1;
RECT area{};
std::wstring proofPath;

std::wstring wide(const std::string &value) {
  int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                               int(value.size()), nullptr, 0);
  if (!size) return L"AttaClip needs attention";
  std::wstring result(size, L'\0');
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                      int(value.size()), result.data(), size);
  return result;
}

void paint() {
  const int width = int(368 * scale), height = int(100 * scale);
  BITMAPINFO info{};
  info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  info.bmiHeader.biWidth = width;
  info.bmiHeader.biHeight = -height;
  info.bmiHeader.biPlanes = 1;
  info.bmiHeader.biBitCount = 32;
  void *pixels = nullptr;
  HDC dc = CreateCompatibleDC(nullptr);
  HBITMAP dib = CreateDIBSection(dc, &info, DIB_RGB_COLORS, &pixels, nullptr, 0);
  if (!dib || !pixels) { if (dib) DeleteObject(dib); DeleteDC(dc); return; }
  auto previous = SelectObject(dc, dib);
  {
    Bitmap bitmap(width, height, width * 4, PixelFormat32bppPARGB,
                  static_cast<BYTE *>(pixels));
    Graphics g(&bitmap);
    g.Clear(Color(0, 0, 0, 0));
    g.ScaleTransform(scale, scale);
    g.SetSmoothingMode(SmoothingModeAntiAlias);
    g.SetTextRenderingHint(TextRenderingHintAntiAliasGridFit);
    GraphicsPath shape;
    const float x = 8, y = 8, w = 352, h = 84, r = 18;
    shape.AddArc(x, y, r * 2, r * 2, 180, 90);
    shape.AddArc(x + w - r * 2, y, r * 2, r * 2, 270, 90);
    shape.AddArc(x + w - r * 2, y + h - r * 2, r * 2, r * 2, 0, 90);
    shape.AddArc(x, y + h - r * 2, r * 2, r * 2, 90, 90);
    shape.CloseFigure();
    SolidBrush background(Color(250, 25, 23, 31));
    g.FillPath(&background, &shape);
    const Color accent = error ? Color(255, 250, 137, 137) : Color(255, 177, 151, 252);
    Pen pen(accent, 2.6f);
    pen.SetStartCap(LineCapRound); pen.SetEndCap(LineCapRound);
    if (saving) {
      float angle = animate ? float(GetTickCount64() - started) * .22f : -90.f;
      g.DrawArc(&pen, 29.f, 37.f, 23.f, 23.f, angle, 250.f);
    } else if (error) {
      g.DrawEllipse(&pen, 28.f, 36.f, 26.f, 26.f);
      g.DrawLine(&pen, 41.f, 41.f, 41.f, 50.f);
      g.DrawLine(&pen, 41.f, 55.f, 41.f, 55.4f);
    } else {
      g.DrawLine(&pen, 30.f, 48.f, 38.f, 56.f);
      g.DrawLine(&pen, 38.f, 56.f, 53.f, 41.f);
    }
    FontFamily family(L"Segoe UI");
    Font label(&family, 11, FontStyleRegular, UnitPixel);
    Font body(&family, 14, FontStyleRegular, UnitPixel);
    SolidBrush muted(Color(255, 169, 161, 184)), ink(Color(255, 243, 239, 250));
    g.DrawString(L"AttaClip", -1, &label, PointF(70, 25), &muted);
    StringFormat format;
    format.SetTrimming(StringTrimmingEllipsisWord);
    format.SetFormatFlags(StringFormatFlagsLineLimit);
    g.DrawString(text.c_str(), int(text.size()), &body, RectF(70, 43, 269, 39), &format, &ink);
    if (!proofPath.empty()) {
      const CLSID png{0x557cf406, 0x1a04, 0x11d3, {0x9a, 0x73, 0x00, 0x00, 0xf8, 0x1e, 0xf3, 0x2e}};
      bitmap.Save(proofPath.c_str(), &png);
      proofPath.clear();
    }
  }
  double age = double(GetTickCount64() - started);
  double progress = animate ? std::min(1., age / 180.) : 1.;
  double ease = 1 - std::pow(1 - progress, 3);
  double fade = animate ? std::min(1., std::max(0., (lifetime - age) / 150.)) : 1.;
  POINT destination{area.right - width - int(16 * scale),
                    area.top + int((16 - 12 * (1 - ease)) * scale)};
  SetWindowPos(window, HWND_TOPMOST, destination.x, destination.y, width, height, SWP_NOACTIVATE);
  SetLayeredWindowAttributes(window, 0, BYTE(255 * ease * fade), LWA_ALPHA);
  HDC target = GetDC(window);
  BitBlt(target, 0, 0, width, height, dc, 0, 0, SRCCOPY);
  ReleaseDC(window, target);
  SelectObject(dc, previous); DeleteObject(dib); DeleteDC(dc);
}

LRESULT CALLBACK events(HWND hwnd, UINT message, WPARAM w, LPARAM l) {
  if (message == metricsMessage) {
    PROCESS_MEMORY_COUNTERS memory{sizeof(PROCESS_MEMORY_COUNTERS)};
    GetProcessMemoryInfo(GetCurrentProcess(), &memory, sizeof(memory));
    FILETIME creation{}, exit{}, kernel{}, user{};
    GetProcessTimes(GetCurrentProcess(), &creation, &exit, &kernel, &user);
    auto ticks = [](FILETIME time) { return (uint64_t(time.dwHighDateTime) << 32) | time.dwLowDateTime; };
    std::cout << json({{"event", "metrics"}, {"memory", memory.WorkingSetSize},
                       {"cpuSeconds", double(ticks(kernel) + ticks(user)) / 10000000.}}).dump() << std::endl;
    return 0;
  }
  if (message == WM_PAINT) {
    PAINTSTRUCT update{}; BeginPaint(hwnd, &update); EndPaint(hwnd, &update);
    if (IsWindowVisible(hwnd)) paint();
    return 0;
  }
  if (message == noticeMessage) {
    auto *input = reinterpret_cast<json *>(l);
    text = wide(input->value("message", ""));
    error = input->value("error", false);
    saving = input->value("saving", false);
    if (input->contains("proofPath") && (*input)["proofPath"].is_string())
      proofPath = wide(input->value("proofPath", ""));
    lifetime = error ? 6500 : saving ? 10000 : 2400;
    delete input;
    HWND foreground = GetForegroundWindow();
    MONITORINFO monitor{sizeof(MONITORINFO)};
    GetMonitorInfo(MonitorFromWindow(foreground, MONITOR_DEFAULTTOPRIMARY), &monitor);
    area = monitor.rcWork;
    scale = float(foreground ? GetDpiForWindow(foreground) : GetDpiForSystem()) / 96.f;
    SetWindowRgn(hwnd, CreateRoundRectRgn(int(8*scale), int(8*scale), int(360*scale), int(92*scale), int(36*scale), int(36*scale)), TRUE);
    BOOL animations = TRUE;
    SystemParametersInfo(SPI_GETCLIENTAREAANIMATION, 0, &animations, 0);
    animate = animations != FALSE;
    started = GetTickCount64();
    paint();
    SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0,
                 SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
    SetWindowDisplayAffinity(hwnd, 0x11);
    SetTimer(hwnd, 1, animate ? 16 : 100, nullptr);
    DWORD protection = 0;
    BOOL protectedWindow = GetWindowDisplayAffinity(hwnd, &protection);
    std::cout << json({{"event", "shown"}, {"window", uint64_t(reinterpret_cast<uintptr_t>(hwnd))},
                       {"visible", bool(IsWindowVisible(hwnd))}, {"protected", protection == 0x11}, {"affinity", protection}, {"affinityRead", bool(protectedWindow)},
                       {"focusPreserved", foreground == GetForegroundWindow()}}).dump() << std::endl;
    return 0;
  }
  if (message == WM_TIMER) {
    if (GetTickCount64() - started >= ULONGLONG(lifetime)) {
      KillTimer(hwnd, 1); ShowWindow(hwnd, SW_HIDE);
      std::cout << json({{"event", "hidden"}}).dump() << std::endl;
    } else paint();
    return 0;
  }
  if (message == WM_NCHITTEST) return HTTRANSPARENT;
  if (message == WM_MOUSEACTIVATE) return MA_NOACTIVATE;
  if (message == closeMessage || message == WM_CLOSE) {
    DestroyWindow(hwnd); return 0;
  }
  if (message == WM_DESTROY) { PostQuitMessage(0); return 0; }
  return DefWindowProc(hwnd, message, w, l);
}
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int) {
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  ULONG_PTR token; GdiplusStartupInput graphics;
  if (GdiplusStartup(&token, &graphics, nullptr) != Ok) return 1;
  WNDCLASS cls{}; cls.lpfnWndProc = events; cls.hInstance = instance;
  cls.lpszClassName = L"AttaClipNativeFeedback";
  RegisterClass(&cls);
  window = CreateWindowEx(WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE |
                         WS_EX_TOPMOST | WS_EX_TRANSPARENT,
                         cls.lpszClassName, L"AttaClip feedback", WS_POPUP,
                         0, 0, 368, 100, nullptr, nullptr, instance, nullptr);
  if (!window) { GdiplusShutdown(token); return 1; }
  // Prevent the popup appearing in screen/window clips. Never acquire focus.
  std::thread input([] {
    std::string line;
    while (std::getline(std::cin, line)) {
      try {
        if (line.size() > 16384) continue;
        auto value = json::parse(line);
        if (value.value("action", "") == "exit") break;
        if (value.value("action", "") == "metrics") { PostMessage(window, metricsMessage, 0, 0); continue; }
        if (!value.contains("message") || !value["message"].is_string()) continue;
        if (value["message"].get_ref<const std::string &>().size() > 4000) continue;
        auto *notice = new json(std::move(value));
        if (!PostMessage(window, noticeMessage, 0, reinterpret_cast<LPARAM>(notice))) delete notice;
      } catch (...) { /* Invalid feedback must never stop recording. */ }
    }
    PostMessage(window, closeMessage, 0, 0);
  });
  MSG event{};
  while (GetMessage(&event, nullptr, 0, 0) > 0) {
    TranslateMessage(&event); DispatchMessage(&event);
  }
  // Normal shutdown closes stdin. Forced process termination also releases it.
  CancelSynchronousIo(input.native_handle());
  input.join(); GdiplusShutdown(token);
  return 0;
}
