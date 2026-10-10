// SPDX-License-Identifier: GPL-2.0-or-later
// Private window and three real PulseAudio inputs. No user audio is read.
#include <X11/Xatom.h>
#include <X11/Xlib.h>
#include <atomic>
#include <cmath>
#include <cstdlib>
#include <pulse/simple.h>
#include <signal.h>
#include <sys/wait.h>
#include <thread>
#include <unistd.h>
#include <vector>

volatile sig_atomic_t quitting = 0;
void stop(int) { quitting = 1; }
void tone(int frequency) {
  pa_sample_spec spec{PA_SAMPLE_FLOAT32LE, 48000, 2};
  int error = 0;
  auto *stream = pa_simple_new(
      nullptr, "AttaClip private tone fixture", PA_STREAM_PLAYBACK, nullptr,
      "Deterministic test tone", &spec, nullptr, nullptr, &error);
  if (!stream)
    _exit(4);
  std::vector<float> samples(480 * 2);
  uint64_t position = 0;
  while (!quitting) {
    for (size_t i = 0; i < 480; i++, position++) {
      float value = float(.035 * std::sin(2 * 3.141592653589793 * frequency *
                                          double(position) / 48000));
      samples[i * 2] = samples[i * 2 + 1] = value;
    }
    if (pa_simple_write(stream, samples.data(), samples.size() * sizeof(float),
                        &error) < 0)
      break;
  }
  pa_simple_free(stream);
}
int main(int argc, char **argv) {
  signal(SIGTERM, stop);
  signal(SIGINT, stop);
  int base = argc > 2 ? atoi(argv[2]) : 997;
  pid_t child = fork();
  if (!child) {
    tone(base + 1002);
    return 0;
  }
  if (child < 0)
    return 5;
  auto *display = XOpenDisplay(nullptr);
  if (!display) {
    kill(child, SIGTERM);
    waitpid(child, nullptr, 0);
    return 2;
  }
  auto window = XCreateSimpleWindow(display, DefaultRootWindow(display), 30, 30,
                                    320, 180, 0, 0, 0x0000ff);
  XStoreName(display, window,
             argc > 1 ? argv[1] : "AttaClip private audio fixture");
  unsigned long pid = getpid();
  XChangeProperty(display, window, XInternAtom(display, "_NET_WM_PID", False),
                  XA_CARDINAL, 32, PropModeReplace,
                  reinterpret_cast<unsigned char *>(&pid), 1);
  XMapWindow(display, window);
  XFlush(display);
  std::thread first([&] { tone(base); });
  std::thread second([&] { tone(base + 502); });
  auto gc = XCreateGC(display, window, 0, nullptr);
  int frame = 0;
  while (!quitting) {
    XSetForeground(display, gc, 0x0000ff);
    XFillRectangle(display, window, gc, 0, 0, 320, 180);
    XSetForeground(display, gc, 0x00ff00);
    XFillRectangle(display, window, gc, frame++ % 300, 5, 12, 12);
    XFlush(display);
    usleep(30000);
  }
  XFreeGC(display, gc);
  first.join();
  second.join();
  kill(child, SIGTERM);
  waitpid(child, nullptr, 0);
  XDestroyWindow(display, window);
  XCloseDisplay(display);
}
