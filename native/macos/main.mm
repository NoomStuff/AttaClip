// SPDX-License-Identifier: GPL-2.0-or-later
#import <Cocoa/Cocoa.h>
#include <atomic>
#include <thread>

int attaclip_recorder_main(int argc, char **argv);

// OBS capture modules dispatch Cocoa work to the main queue. Reading stdin on
// that thread would deadlock source creation and stop delivery of Mac events.
int main(int argc, char **argv) {
  @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];
    std::atomic<bool> finished{false};
    int result = 1;
    std::thread commands([&] {
      @autoreleasepool {
        result = attaclip_recorder_main(argc, argv);
      }
      finished.store(true);
      CFRunLoopWakeUp(CFRunLoopGetMain());
    });
    while (!finished.load()) {
      @autoreleasepool {
        NSEvent *event = [NSApp nextEventMatchingMask:NSEventMaskAny
                                          untilDate:[NSDate dateWithTimeIntervalSinceNow:0.025]
                                             inMode:NSDefaultRunLoopMode
                                            dequeue:YES];
        if (event) [NSApp sendEvent:event];
        [NSApp updateWindows];
      }
    }
    commands.join();
    return result;
  }
}
