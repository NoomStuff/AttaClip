// SPDX-License-Identifier: MIT
// Isolated, animated Direct3D surface for verifying real OBS game hooks.
#include <cmath>
#include <d3d11.h>
#include <iostream>
#include <mmsystem.h>
#include <vector>
#include <windows.h>
LRESULT CALLBACK procedure(HWND window, UINT message, WPARAM w, LPARAM l) {
  if (message == WM_DESTROY) {
    PostQuitMessage(0);
    return 0;
  }
  return DefWindowProcW(window, message, w, l);
}
int main(int argc, char **argv) {
  WNDCLASSW klass{};
  klass.lpfnWndProc = procedure;
  klass.hInstance = GetModuleHandleW(nullptr);
  klass.lpszClassName = L"AttaClipIsolatedD3DProof";
  RegisterClassW(&klass);
  HWND window = CreateWindowW(klass.lpszClassName,
                              L"AttaClip isolated Direct3D capture proof",
                              WS_OVERLAPPEDWINDOW, 80, 80, 660, 400, nullptr,
                              nullptr, klass.hInstance, nullptr);
  if (argc > 1)
    SetWindowTextA(window, argv[1]);
  HWAVEOUT sound = nullptr;
  WAVEHDR header{};
  std::vector<int16_t> tone;
  if (argc > 2) {
    int frequency = atoi(argv[2]);
    tone.resize(48000 * 2);
    for (size_t index = 0; index < tone.size() / 2; index++)
      tone[index * 2] = tone[index * 2 + 1] =
          int16_t(1000 * std::sin(2 * 3.141592653589793 * frequency *
                                  double(index) / 48000));
    WAVEFORMATEX format{WAVE_FORMAT_PCM, 2, 48000, 192000, 4, 16, 0};
    if (waveOutOpen(&sound, WAVE_MAPPER, &format, 0, 0, CALLBACK_NULL) !=
        MMSYSERR_NOERROR)
      return 3;
    header.lpData = reinterpret_cast<LPSTR>(tone.data());
    header.dwBufferLength = DWORD(tone.size() * sizeof(int16_t));
    header.dwFlags = WHDR_BEGINLOOP | WHDR_ENDLOOP;
    header.dwLoops = 120;
    if (waveOutPrepareHeader(sound, &header, sizeof(header)) !=
            MMSYSERR_NOERROR ||
        waveOutWrite(sound, &header, sizeof(header)) != MMSYSERR_NOERROR)
      return 4;
  }
  DXGI_SWAP_CHAIN_DESC desc{};
  desc.BufferCount = 2;
  desc.BufferDesc.Width = 640;
  desc.BufferDesc.Height = 360;
  desc.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
  desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
  desc.OutputWindow = window;
  desc.SampleDesc.Count = 1;
  desc.Windowed = TRUE;
  desc.SwapEffect = DXGI_SWAP_EFFECT_DISCARD;
  IDXGISwapChain *swap = nullptr;
  ID3D11Device *device = nullptr;
  ID3D11DeviceContext *context = nullptr;
  if (FAILED(D3D11CreateDeviceAndSwapChain(
          nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, 0, nullptr, 0,
          D3D11_SDK_VERSION, &desc, &swap, &device, nullptr, &context)))
    return 1;
  ID3D11Texture2D *buffer = nullptr;
  ID3D11RenderTargetView *view = nullptr;
  if (FAILED(swap->GetBuffer(0, __uuidof(ID3D11Texture2D),
                             reinterpret_cast<void **>(&buffer))) ||
      FAILED(device->CreateRenderTargetView(buffer, nullptr, &view)))
    return 2;
  buffer->Release();
  ShowWindow(window, SW_SHOW);
  std::cout << reinterpret_cast<uintptr_t>(window) << std::endl;
  MSG message{};
  uint64_t frame = 0;
  while (message.message != WM_QUIT) {
    while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
      TranslateMessage(&message);
      DispatchMessageW(&message);
    }
    float color[] = {0.1f, float(0.25 + 0.2 * std::sin(double(frame++) / 40.)),
                     0.8f, 1.f};
    context->ClearRenderTargetView(view, color);
    swap->Present(1, 0);
  }
  view->Release();
  context->Release();
  device->Release();
  swap->Release();
  if (sound) {
    waveOutReset(sound);
    waveOutUnprepareHeader(sound, &header, sizeof(header));
    waveOutClose(sound);
  }
  return 0;
}
