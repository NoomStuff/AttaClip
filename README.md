# AttaClip

Save the moment. Keep it yours.

AttaClip is a local-first desktop clipping app built with Electron and a separate native libOBS recorder. It keeps recent footage while recording, saves clips through a global shortcut, and creates smaller shareable copies without changing the original.

## The workflow

Choose a screen or application, start recording, and press the clip shortcut when something happens. Browse your collection, preview individual audio tracks, and create a copy under your chosen file-size limit. Nothing is uploaded by the app.

The library is an ordinary folder. Existing supported videos appear automatically. Categories and original/shareable relationships live in `.attaclip`; compressed copies live under `shareables`, mirroring the source folders. Your videos remain usable without AttaClip.

AttaClip is for clips. Use OBS for full-session recording and AttaCut for cutting.

## Try the Windows preview

[Download AttaClip 0.1.0](https://github.com/NoomStuff/AttaClip/releases/tag/v0.1.0). Choose the installer or portable executable. The release includes matching source archives, full dependency notices and checksums. Windows builds are unsigned.

Windows recording, audio, playback and sharing have passed actual installed and portable tests. Later development builds add automatic game selection, graphics-hook capture, additional isolated audio sources and native save feedback. Linux X11 screen and application capture, including isolated application audio, passed private real-media tests. macOS application capture passed actual media checks, but screen capture remains under investigation and packaged recording is unverified. Wayland capture remains unavailable. These later changes are not in the published 0.1.0 preview.

## Development

Use Bun 1.4.2 or later and a supported Node.js runtime. Windows recorder builds also need CMake and Visual Studio Build Tools with Desktop development with C++. The TypeScript build uses strict boundary validation and strict compiler checks.

```sh
bun install
bun scripts/provision-media.ts
bun run bundle:media
bun run build:icons
bun run build:native
bun run dev
```

Windows uses AttaClip's controlled FFmpeg build. In Ubuntu 24.04, including WSL, install `gcc-mingw-w64-x86-64`, `g++-mingw-w64-x86-64`, `binutils-mingw-w64-x86-64`, `make`, `nasm`, `meson`, `ninja-build`, and `pkg-config`. Run `bun scripts/release-sources.ts --controlled-inputs --collect-only`, then `bash scripts/build-media-windows.sh` in Ubuntu. Back in Windows, run `bun scripts/controlled-media.ts` before the commands above. CI builds the same recipe and passes its captured inputs and binaries to Windows verification.

On Linux and macOS, `provision-media.ts` downloads checksum-pinned provider builds. It exports binary paths to later GitHub Actions steps. For a local shell, set `FFMPEG_PATH` and `FFPROBE_PATH` to the printed paths before running `bundle:media`. You can also supply compatible binaries for development. `bundle:media` stages them and records their hashes and configuration. A development override does not establish release source correspondence. Development runs work without a native helper, but recording stays unavailable until it is built. The UI never simulates successful recording.

Windows capture uses a pinned OBS runtime. Linux X11 screen capture and PulseAudio recording also have a native backend. On Ubuntu 24.04, install the official OBS PPA package `obs-studio=32.2.0-0obsproject1~noble`, CMake, g++, make, pkg-config, libx11-dev, libxcb-composite0-dev, libpulse-dev and libsimde-dev before building it. X11 application capture can use an exact-window CPU compatibility method when OBS cannot import its window texture. Application audio monitors verified PulseAudio streams belonging to the selected process and its children. It never substitutes desktop audio. macOS staging builds a ScreenCaptureKit recorder with VideoToolbox encoding, but screen capture and packaging still need the Mac workflow to pass.

Auto mode matches running application windows against a locally cached game catalog and games you add yourself. Catalog refresh uses Discord's public detectable-applications endpoint without requiring Discord, an account or a token. It sends no running-process list or clips. The endpoint is undocumented, so cached entries, a small built-in list and local custom games remain available when refresh fails. Desktop fallback is off unless you enable it. Switching to an ordinary app retains the current game rather than switching capture to your desktop.

## Verification

```sh
bun run verify
bun run test:media
bun run test:ui
bun run test:native
bun run test:capture-loss
bun run test:ui:native
bun run package
bun run test:packaged
bun run test:portable
```

`verify` checks formatting, lint, unit tests, strict types, and the application build. Media verification creates isolated real videos and checks full-duration size-limited exports, original preservation, cancellation, playback tracks, collection recovery, and safe file ownership. UI tests launch the actual Electron app against an isolated profile. Screenshots and traces land in `test-results`. The portable check connects to the launcher's child through a temporary localhost debugging port and runs the same recording and media assertions. Native and packaged capture tests record the selected screen on a supported Windows machine, check queued saves through source changes and stopping, and decode the actual outputs. Run those with test content visible on screen.

`test:capture-loss` records an isolated application, loses its source for longer than the configured history, saves the retained footage, then verifies recovery and full decoding. `test:ui:native` verifies actual capture while preview streams end during navigation, minimize and close to tray. The regular UI suite tests moving preview pixels without requiring NVENC. Linux's dedicated Actions workflow records real X11 pixels and PulseAudio tones through an isolated Xvfb display and null audio sink.

`ATTACLIP_PROFILE`, `ATTACLIP_COLLECTION`, and `ATTACLIP_TEST=1` isolate manual or automated runs from your real preferences and library. The test flag suppresses notification windows and OS startup changes. Never point destructive tests at a real collection.

## Recording guarantees and current limits

Recording and clip requests belong to the native helper, not the library renderer. Source switches keep a stable output size. Clip requests retain their request boundaries while writing is queued. Stopping clears unsaved history but preserves accepted saves. If an application disappears, AttaClip preserves the last available footage and identifies it when saved. Capture recovery begins a fresh history to avoid a timestamp gap.

Clips overlap by default. The optional overlap reduction starts near the previous successfully saved moment. A preceding video keyframe can leave a small overlap. Failed saves do not advance that boundary, and queued requests keep their original endpoints.

Low, Standard, High, and Custom profiles expose the actual resolution and frame rate. Custom settings include encoder quality. Hardware encoding is preferred; software encoding requires an explicit opt-in. Microphone selection, gain and mute controls belong to the recorder. The moving preview captures only the selected source, without audio. Leaving the recording page, closing or minimizing the library releases that preview stream while recording continues.

Originals currently use MKV for recoverable saving. Compatible MP4 playback copies are made on demand, without replacing the original. Shareables use H.264 video and the master audio mix in MP4. Their completed size and duration are checked before publication. A too-small budget produces an error rather than a truncated clip.

Shareable encoding is bounded, below-normal-priority software encoding. It is still extra work while recording. Windows NVENC and Linux software recording have passed actual media checks. Physical microphone gain/mute and selected-application audio passed real tone checks on the development machine. Native fullscreen popup behavior, HDR, device hotplug, application-audio compatibility on other machines, and loaded-game impact still need verification. A successful installer build alone does not validate capture.

## Builds and releases

GitHub Actions runs the verification suite and has a separate manual/tagged desktop-build workflow. Public releases must include the corresponding sources and notices for the actual OBS and FFmpeg distributions used. Packaging does not automatically publish an installer.

Installed Windows and Linux AppImage updates can download through electron-updater and restart only on an explicit action. Unsigned macOS and portable Windows builds use the releases page. Pending saves and exports use the same exit safeguards when updating.

## License

AttaClip is GPL-3.0-or-later. Reused AttaCut code retains its MIT notices. See [third-party notices](THIRD_PARTY_NOTICES.md). Commercial use is permitted by the GPL; recorded videos do not inherit the software license.
