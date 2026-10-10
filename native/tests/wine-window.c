// SPDX-License-Identifier: MIT
// Private Win32 pixels for actual Wine executable and capture verification.
#include <windows.h>

#include <math.h>
#include <mmsystem.h>
#include <stdio.h>

DWORD WINAPI audio(LPVOID unused) {
  WAVEFORMATEX format = {WAVE_FORMAT_PCM, 2, 48000, 48000 * 4, 4, 16, 0};
  HANDLE done = CreateEventA(0, FALSE, FALSE, 0);
  if (!done)
    return 2;
  HWAVEOUT stream;
  if (waveOutOpen(&stream, WAVE_MAPPER, &format, (DWORD_PTR)done, 0,
                  CALLBACK_EVENT) != MMSYSERR_NOERROR)
    return 3;
  short samples[4800 * 2];
  WAVEHDR header = {0};
  header.lpData = (LPSTR)samples;
  header.dwBufferLength = sizeof(samples);
  if (waveOutPrepareHeader(stream, &header, sizeof(header)) != MMSYSERR_NOERROR)
    return 4;
  unsigned long long position = 0;
  for (;;) {
    for (int i = 0; i < 4800; i++, position++)
      samples[i * 2] = samples[i * 2 + 1] =
          (short)(2200 * sin(2 * 3.141592653589793 * 777 * position / 48000));
    ResetEvent(done);
    if (waveOutWrite(stream, &header, sizeof(header)) != MMSYSERR_NOERROR)
      return 5;
    if (WaitForSingleObject(done, 5000) != WAIT_OBJECT_0)
      return 6;
  }
}
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
  CreateThread(0, 0, audio, 0, 0, 0);
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
