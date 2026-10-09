// SPDX-License-Identifier: MIT
// Private Win32 pixels for actual Wine executable and capture verification.
#include <stdio.h>
#include <windows.h>
LRESULT CALLBACK procedure(HWND window, UINT message, WPARAM w, LPARAM l) {
  static int frame;
  if (message == WM_DESTROY) {
    PostQuitMessage(0);
    return 0;
  }
  if (message == WM_TIMER) {
    frame++;
    InvalidateRect(window, 0, FALSE);
    return 0;
  }
  if (message == WM_PAINT) {
    PAINTSTRUCT paint;
    HDC dc = BeginPaint(window, &paint);
    RECT rect;
    GetClientRect(window, &rect);
    HBRUSH blue = CreateSolidBrush(RGB(0, 0, 255));
    FillRect(dc, &rect, blue);
    DeleteObject(blue);
    RECT bar = {frame % 300, 20, frame % 300 + 10, 40};
    HBRUSH green = CreateSolidBrush(RGB(0, 255, 0));
    FillRect(dc, &bar, green);
    DeleteObject(green);
    EndPaint(window, &paint);
    return 0;
  }
  return DefWindowProcA(window, message, w, l);
}
int main(void) {
  WNDCLASSA klass = {0};
  klass.lpfnWndProc = procedure;
  klass.hInstance = GetModuleHandleA(0);
  klass.lpszClassName = "AttaClipWineProof";
  RegisterClassA(&klass);
  HWND window = CreateWindowA(
      klass.lpszClassName, "AttaClip private Wine proof", WS_OVERLAPPEDWINDOW,
      30, 30, 340, 220, 0, 0, klass.hInstance, 0);
  ShowWindow(window, SW_SHOW);
  SetTimer(window, 1, 30, 0);
  printf("%lu\n", GetCurrentProcessId());
  fflush(stdout);
  MSG message;
  while (GetMessageA(&message, 0, 0, 0)) {
    TranslateMessage(&message);
    DispatchMessageA(&message);
  }
  return 0;
}
