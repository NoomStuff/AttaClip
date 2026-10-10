# Development status

Updated 10 October 2026. This file records verified checkpoints and unfinished work, not extra agent instructions.

## Current checkpoint

Main is pushed through 37f044a9666646047412c435615e37b7c0010fe8. GitHub Checks 37950362799, Linux capture 37950362533 and macOS native 37950362493 all passed. Mac source collection now compares the actual packaged Electron FFmpeg module with its checksum-verified official archive. Its earlier installed-path failure is resolved.

The working tree adds production Wayland screen capture, a native Cocoa notification helper, Mac microphone permission handling, final Mac source/container verification, bounded shareable decoding/filter threads and installed/portable AttaCut discovery. These changes require a new clean checkpoint and their corresponding CI proofs. Read the ignored platform handoffs before repeating expensive tests.

## Functional app

The Electron/React app has Recording, Library, Viewer, Settings and onboarding, stateful navigation, live preview, shared recording status and shortcut feedback. Closing or navigating the library does not stop native recording. Global clipping shortcuts work independently of the renderer. Updates restart only through an explicit action and the pending-work safeguards.

Collections are ordinary folders. Supported existing videos appear recursively. Overlapping categories do not move files. Metadata uses safe writes and backups, relative paths first and verified recovery. Shareables mirror original folders under the collection root's shareables folder. Actual exports verify size and duration. Creating or canceling a shareable preserves the original. Uploads and automatic telemetry are absent.

The recorder keeps requested save windows anchored to the hotkey moment, including queued requests. Stop clears unsaved history while accepted saves finish. Source loss preserves valid earlier footage and reports the actual state. Recording uses MKV originals with a master mix and isolated audio tracks. Additional audio sources support gain, mute and master inclusion. Fixed output allows source switches without clearing history.

Auto uses a locally cached Discord detectable-applications catalog and local exact-executable additions. Discord need not be installed. Catalog requests do not upload process information. Recognized foreground games win; ordinary-app focus retains the current game. Fullscreen breaks ties only among recognized games. Desktop fallback is explicit and off by default. Actual Windows Auto selection, selected pixels, navigation continuity, save and target-loss behavior passed. Windows Direct3D hook capture and asset lookup also passed.

## Actual platform evidence

Windows recording, separate audio, source loss/recovery, queued saves, overlap reduction, playback and size-limited sharing passed against actual media. Native animated feedback passed focus, capture exclusion and idle-resource tests. Microphone gain/mute tests passed and speaker settings were restored. Physical device removal and exclusive fullscreen feedback remain unverified.

Linux X11/PulseAudio screen and exact application capture passed. Application audio tests isolated the selected process from an unrelated tone and checked gain, mute, switching and server loss. Wine9 capture uses the verified mapped PE executable and process arguments; motion, decoding and target loss passed. A SIGSTOP/SIGCONT test preserves accepted saves and recovers timestamps, but does not prove real OS sleep. Steam-launched Proton remains unverified. The named-pixmap compatibility source has CPU cost. WSL hardware graphics teardown previously hung, so headless proofs do not establish Linux hardware gameplay performance.

Mac native and packaged screen/application capture passed at 96031c8 and adf1b19, then all 37f044a stages passed. Added application audio isolated 997 Hz from an independent 1613 Hz decoy; explicit System audio included both. Master inclusion/exclusion, gain, mute, source loss, saved audio and retained footage passed. Packaged navigation, minimize, close-to-tray and sharing preserved original hashes. Controlled Apple Silicon FFmpeg codec fixtures and official OBS provider/configuration comparisons passed. Physical microphone, permission-prompt UX and device hotplug remain unverified. The new Cocoa feedback helper still needs its actual Mac CI run. Its desktop-capture exclusion is not established.

Wayland's production helper and patched PipeWire module now compile. The first real isolated Sway run saved moving screen pixels and audible master/source tracks, retained saveable history after PipeWire loss and stopped cleanly. Expanded permission-denial, Stop-before-grant, explicit session loss and queued-save tests passed at .cache/linux-smoke/ec2b1c66-c5f4-415d-9f81-1211f0322901. Source ACK took 20 ms while picker selection stayed pending. Saved output had 69 distinct decoded frames and both audio tracks at -24.1 dB. Portal screen selection is explicit; App/Auto remain unavailable until exact target capture is proved. Electron must not open a second permission picker. The private portal-wlr0.5.0 SHM fixture does not replace the user's backend. Read .cache/recorder-wayland-handoff.md.

## Loaded-game measurement

Actual Portal2 gameplay passed at .cache/loaded-game/64ffb1dd-34c7-40b8-b047-6ba94c022d49. Native logs confirm Direct3D9 shared-texture capture with NVENC. Both 20-second originals fully decoded with moving frames, including a concurrent shareable. All 83 backed-up game/config files were restored byte-for-byte. No game or test encoder remains running.

On this RTX 3070, uncapped recording averaged 1034.6 fps and concurrent compression 838.4 fps. Helper CPU stayed near 0.55 percent of the 16 logical CPUs and 191 MB working set. These are one-game native-helper measurements, not whole-app performance or a general low-impact claim. FFmpeg input decoding now uses two threads and filter pools one thread, in addition to its existing two-thread output encoder. Actual media integration passed after the change. Remeasure gameplay before claiming improvement.

The private benchmark uses PresentMon 2.6.0 with GPU, display and input tracking disabled. It measures presentation intervals only. Steam must be running; prior attempts opened an Engine Error because it was not. The real PowerShell executable is C:/Users/Dave/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe. The exec tool substitutes that runtime for the nonexistent Program Files path, but Bun subprocesses do not. Use the real path. .cache/game-benchmark.ts preserves and restores game files and validates the owned game's foreground window.

## Source and release checkpoints

Public Windows v0.1.0 is immutable at 647c7b7ba3dc824de316118305f757fbd65abea2, https://github.com/NoomStuff/AttaClip/releases/tag/v0.1.0. Its installer and portable executable passed actual capture/playback/sharing and the complete payload/source/updater verifier. All remote asset sizes and hashes matched. Never replace its tag or assets. New app changes need a new release version.

Its source ZIP is work/AttaClip-0.1.0-windows-x64-sources-647c7b7b.zip,174637711bytes, SHA256968442132620ac69be85446eb318bbc0fbbc4b6f60262c70c266d349d9b76752. Recheck this frozen release only against its tag.

The frozen d109b2e Linux AppImage and complete source ZIP/container/updater gate passed. AppImage SHA25676f0ab5151560cf08191526ae8cad6960446e5e84072573ce799ef11210c8d1c. Source ZIP work/AttaClip-0.1.0-linux-x64-sources-d109b2e0.zip is1338039049bytes, SHA2562980365b85934580ef088537fd1e3055e44f5af98662f6bb37399c20874a6db2. It covers5476files,223ELFs and200packages. Preserve .cache/linux-app and /home/dave/.cache/attaclip-controlled-package. This gate does not approve later Wayland module changes. The patched module needs exact source replay and dependency correspondence before distribution.

Mac source collection verified 17 exact dependency inputs, 116 full notices, actual runtime configurations and all seven library versions. New tooling assembles the full frozen source ZIP and independently rebuilds/repackages the app, then compares files, modes, links, ZIP SHA512 and updater blockmap. The actual final Mac gate remains pending on the new checkpoint. Source collection alone does not authorize distributing a binary.

## Next work

Finish the current Wayland lifecycle proof and changed-module source closure. Run the new Mac helper and full source/container/updater gate on GitHub. Check the new cached microphone permission and device-loss states on actual Mac CI. Then verify exact XWayland/Steam Proton capture, whole-app gameplay/concurrent sharing, real sleep/device recovery and fullscreen/HDR limitations where this machine permits. Do not equate compilation, synthetic fixtures or pregranted CI permissions with untested behavior.

Private recordings, raw process arguments and game files remain ignored under .cache, work and isolated profiles. Publish only curated synthetic evidence. Latest local strict types, lint, 79 unit tests, production build and actual media integration passed. Six regular Electron UI tests passed. Installed/portable AttaCut launching passed against the actual application and selected MKV, with its original hash unchanged.

Dave authorized implementation, GitHub publishing, builds, machine testing and delegation. Preserve all user changes. Keep continue-attaclip-after-reset active until the authorized work is complete. Do not consume manual reset credits. Read .cache/functional-continuation-handoff.md and the recorder, Mac and source handoffs before continuing.
