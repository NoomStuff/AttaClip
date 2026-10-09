// SPDX-License-Identifier: GPL-2.0-or-later
#import <Cocoa/Cocoa.h>
#include <thread>

int attaclip_recorder_main(int argc, char **argv);

// OBS capture modules dispatch Cocoa work to the main queue. Reading stdin on
// that thread would deadlock source creation and stop delivery of Mac events.
int main(int argc, char **argv) {
  @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];
    int result = 1;
    std::thread commands([&] {
      @autoreleasepool {
        result = attaclip_recorder_main(argc, argv);
      }
      dispatch_async(dispatch_get_main_queue(), ^{
        [NSApp stop:nil];
        // stop: from a dispatched callback also needs an event to wake run:.
        NSEvent *event = [NSEvent otherEventWithType:NSEventTypeApplicationDefined
                                          location:NSZeroPoint modifierFlags:0
                                         timestamp:0 windowNumber:0 context:nil
                                           subtype:0 data1:0 data2:0];
        [NSApp postEvent:event atStart:YES];
      });
    });
    // The official capture module uses the main callback queue. Let AppKit own
    // that loop instead of approximating its dispatch with nextEvent polling.
    [NSApp run];
    commands.join();
    return result;
  }
}
