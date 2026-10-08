# Development status

Updated 9 October 2026 at 00:04 Europe/Amsterdam. This is a handoff, not extra agent instructions.

## Published Windows checkpoint

AttaClip 0.1.0 Windows preview is public at https://github.com/NoomStuff/AttaClip/releases/tag/v0.1.0. Its immutable application commit is 647c7b7ba3dc824de316118305f757fbd65abea2. GitHub Checks, Linux capture and the full Windows/Linux/macOS desktop build matrix passed for that commit. All seven remote asset sizes and SHA-256 digests match the checked local files. The tag resolves to the same commit. Do not republish this release or replace its assets with later builds.

Windows installer and portable EXE include the native OBS recorder, controlled FFmpeg CLI, full dependency notices and source correspondence. Both payloads passed scripts/verify-release.ts against the source packet. The verifier checks current compiled files against app.asar, every packaged recorder/media/notice file, Electron runtime files, extracted EXE payloads and actual updater metadata/blockmap.

The source ZIP is work/AttaClip-0.1.0-windows-x64-sources-647c7b7b.zip, 174637711 bytes, SHA-256 968442132620ac69be85446eb318bbc0fbbc4b6f60262c70c266d349d9b76752. Assembly passed 15 component records and zero blockers. The ZIP has 259 referenced files. Runtime notices include 166 license files. Electron's LGPL module includes exact Chromium FFmpeg and vendored Opus sources, configuration, patches and build helpers. Source kit coverage is Windows only.

Later main changes add portable test tooling and documentation. They do not change the released application. Check out the v0.1.0 tag before rerunning its final correspondence gate. Do not regenerate the old release packet against later HEAD.

## Implemented

Strict TypeScript Electron/React app with purple accents, dark rounded surfaces, Recording, Library, Viewer, Settings, onboarding, stateful navigation, live preview, shared status strip and shortcut animations. Reused AttaCut patterns include playback, audio selection, shortcut editing, updates and release tooling.

Collections are ordinary folders. Supported existing videos appear recursively. Categories overlap without moving files. Metadata has safe writes/backups, verified relative-path recovery and ownership checks. Shareables mirror original folders under root/shareables. Creating or canceling one never modifies its original. Actual H.264/AAC exports verify completed size and duration. Compatible playback copies are on demand.

Windows libOBS capture uses NVENC H.264 or explicit software opt-in, MKV originals, master and isolated AAC tracks, fixed output through source changes, queued requests anchored at keypress time and global shortcuts independent of the library renderer. Stop clears unsaved history and retains accepted saves. Application loss preserves previous valid footage with honest feedback, then recovery starts fresh history to avoid timestamp gaps. Linux has tested X11/PulseAudio capture against official OBS PPA 32.2.0.

Closing the library hides it to tray. Live preview releases tracks on navigation, minimize and hide without interrupting native capture. Updates restart only through an explicit action and use the same pending-work safeguards. A failed installation leaves preferences, window and shortcut usable. No automatic uploads or telemetry.

## Verification

Final formatting, lint, strict types, all 44 unit tests and build passed. Real-media integration passed full-duration size-limited exports, original preservation, playback tracks, cancellation, categories, moved collections, damaged metadata and file ownership. The actual Electron UI suite passed, including onboarding and failed updates. Native UI verification saved the selected application while navigating, minimizing and closing to tray.

Final unpacked, actually installed and portable builds passed real recording, repeated saves through Stop, separate audio, full decoding, playback and a 1 MB shareable without changing the original. The installer was installed into an isolated workspace folder, tested and uninstalled. The portable launcher does not forward inspector stderr, so test:portable connects through a reserved localhost debugging port and runs the same assertions. Test processes are closed.

Actual Windows microphone tone measured -67.0 dB at full gain, -72.5 dB at half gain and -91 dB muted. Master and isolated tracks both muted, and meters responded. Speaker settings were restored to their exact original state after tests. Application loopback tone passed at -24.1 dB through source loss/recovery. Linux tones measured -24.1 dB full gain, -30.1 dB half gain and -91 dB muted. Linux failed destinations exposed SIGPIPE; blocking it before OBS starts now preserves capture and permits a later successful save. Actual helper death clears requests, reports failure, avoids false success and permits restart.

Animated 1080p60 application capture measured helper CPU at 0.69 percent alone and 0.83 percent during production compression on 16 logical CPUs. Working set stayed near 211 MB. Saves took 316 ms alone and 358 ms during the second encoding pass. Both 20-second originals fully decoded with changing frames. The checked 9.19 MB shareable took 32.5 seconds. This excludes the library and a loaded game and does not establish gameplay GPU impact.

Private proof files remain ignored under .cache, work and isolated temporary profiles. Never publish desktop recordings, microphone recordings or private screenshots. Synthetic UI screenshots are under .cache/ui-evidence. Native source fingerprints match the frozen Windows runtime.

## Remaining platform work

Linux/macOS provider binaries need their own corresponding-source closure before public binary release. Linux X11 recording passed actual Xvfb/PulseAudio tests with Mesa software graphics. WSL hardware D3D12 teardown hung in the driver on the first attempt. Do not treat that as verified hardware gameplay performance. macOS capture, Wayland capture and Linux application capture remain unavailable. Automatic game detection and overlap avoidance are disabled. HDR, exclusive fullscreen feedback, monitor disconnect, audio-device hotplug and loaded-game impact remain unverified.

Preserve the verified Windows release while tackling these. Prioritize platform source correspondence and actual packaged testing before claiming support. macOS currently supports library/sharing only. Fullscreen feedback uses small Electron popups, not an injected native game overlay. Electron main persists during capture; closing the library does not mean every Electron process exits.

## Continuation

Dave authorized implementation, public GitHub publishing, builds, computer testing and delegation. Repository is https://github.com/NoomStuff/AttaClip on main. Preserve user changes. The research move and root AttaCut license removal are committed as fa1a448. The retained MIT notice now lives at licenses/AttaCut-MIT.txt, with packaging and verification following that location.

An isolated Linux application snapshot under .cache/linux-app builds an actual AppImage. Its first extracted payload passed real private X11/PulseAudio capture, repeated saves through Stop, actual screen pixels and audio, full decoding, playback and a 1 MB shareable. That run exposed a library registration race. A scan begun before a new recording completed could falsely report that its preserved file could not open. The regression test reproduced that failure. Registration now refreshes the stale snapshot and preserves the source attribution. Rebuilt AppImage verification is pending. The Linux capture workflow now also exercises the actual packaged app.

Controlled Linux FFmpeg is compiling with one worker from the four already pinned source archives. New recipe, provenance checks, codec fixtures and documentation are tracked. Source and full license evidence stage alongside the binaries. Actual compilation, independent codec checks and testing the AppImage with these controlled binaries remain pending. This does not close the separate OBS/PPA, bundled Ubuntu libraries or Electron source obligations. Do not publish a Linux binary yet.

The macOS investigation has a separate pinned OBS 32.2.2 module probe. It compiles Objective-C++ against the matching official framework and checks source/encoder registration without opening capture devices or requesting permissions. Its actual GitHub run is pending. Production Mac recording remains disabled. A backend needs exact display/window identity mapping, a main-thread Mac event loop, TCC permission attribution tests and VideoToolbox-specific configuration.

47 unit tests, strict types and real-media integration passed during this continuation. The new registration test failed before the fix and passes after it. An isolated Linux GUI test disables Chromium sandboxing for the private WSL fixture. This does not prove normal desktop sandbox startup or hardware gameplay performance. Private captures stay ignored.

Weekly account usage reached 93 percent. The next weekly reset is 14 October 2026 at 12:56 Europe/Amsterdam. Do not consume the account's manual reset credit without Dave's instruction. The old single continuation wake has fired and needs updating if further automatic work is deferred. Do not repeat or replace the published Windows release.
