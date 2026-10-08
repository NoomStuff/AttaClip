# Development status

Updated 8 October 2026. This records progress and remaining work, not additional agent instructions.

## Implemented

Strict TypeScript Electron and React application with a separate native libOBS recorder. The purple interface has Recording, Library, Viewer and Settings pages, first-run setup, persistent navigation state, a shared status strip and shortcut feedback.

The collection is an ordinary folder. Existing videos appear recursively. Metadata has safe writes and backup, overlapping categories, original/shareable associations, verified relative-path recovery and ownership checks. Shareables mirror source folders below the collection root. Cancellation and missing metadata never authorize deleting originals or unrelated files.

Actual H.264/AAC shareable encoding checks the completed size and duration, preserves originals, limits worker cost and supports cancellation. Compatible playback files and isolated audio playback are created on demand.

Windows capture uses pinned OBS 32.2.2 with NVENC H.264 or explicitly enabled x264, MKV, master and isolated AAC tracks, queued requests fixed at keypress time, source changes inside a stable output and measured audio levels. Linux has an X11 screen/PulseAudio backend against official OBS PPA 32.2.0. No simulated recorder ships.

Moving preview captures only the exact selected screen or application, without audio, at up to 960x540 and 15 fps. Navigation, minimize and close to tray release its tracks without interrupting native recording. Hidden windows also stop receiving routine renderer state events.

Tray lifecycle, global shortcut, safe exit choices, explicit updates, local diagnostics, AttaCut integration, installer configuration and GitHub Actions are implemented. Recording-start races now lock conflicting preference changes. Update preparation no longer commits application shutdown before the installer succeeds.

## Actual verification

Windows native checks passed real queued clips through source changes and Stop, full decoding, custom 640x360 at 24 fps and existing-destination preservation. The explicit software fallback passed actual x264 capture and a second session after first rejecting software use without opt-in.

Window-loss checks recorded synthetic blue pixels, minimized the application longer than a two-second history, retained a decodable clip longer than 1.5 seconds and identified it as previous footage. Restoring the window produced fresh decodable history without a timestamp gap. Closing the source also preserved earlier footage. Ordinary valid source changes still preserve continuous history.

Windows loopback tone checks measured both master and capture AAC at -45.1 dB with full gain, -51.1 dB at half gain before and after source switching, and -91 dB when muted. OBS meter events arrived. The machine's default audio endpoint was originally muted at volume zero. The test restored that exact state after temporarily using 25 percent volume.

Application process audio also passed actual 997 Hz tone checks in both master and capture tracks at -24.1 dB. Healthy, minimized, resumed and closed-source clips retained their expected pixels and audio. This did not change the user's speaker volume or mute.

Linux checks passed actual X11 pixels, PulseAudio tones at -24.1 dB full gain, -30.1 dB half gain and -91 dB muted, queued saves through Stop, full decoding, software opt-in rejection, filename collision preservation and clean shutdown. This used Xvfb, a private audio sink and Mesa software graphics. WSL's hardware D3D12 teardown hung in the graphics driver during the first attempt. Hardware gameplay performance remains unproven.

Actual Electron tests passed moving preview pixels, source changes and track teardown. The opt-in native UI check passed real application capture while navigating, minimizing and closing to tray, then saved and decoded the selected application's pixels while hidden. Four short samples measured Electron CPU at 2.53 percent with preview and 1.58 percent without it. Those samples include the fixture renderer and exclude the native helper, so they are a local comparison rather than a gameplay benchmark.

The global clip shortcut saved an actual clip while the library was hidden and Codex had focus. Actual unpacked and silently installed Windows builds passed recording, queued saves, playback, original preservation and a 1 MB shareable. The isolated installation was then uninstalled. These packages predate the latest moving preview, Linux and source-loss changes and must be rebuilt before distribution.

The latest unit run passed 37 tests. Real-media integration passed against the rebuilt controlled CLI. The full actual-Electron UI suite previously passed six tests, with its separate hardware test intentionally skipped. That hardware test passed separately when explicitly enabled. Re-run final formatting, lint, types, UI and packaging after the source-tooling checkpoint. Commit 48a1d24 is pushed. Its Linux capture run passed. Its Checks workflow passed fresh immutable source collection and is compiling the controlled media tools. Earlier CI failures came from gzip encoding differences between Git versions. The collector now verifies the exact uncompressed archive contents and retains the compressed archive checksum.

## Remaining work

The final controlled Windows FFmpeg rebuild completed. It uses immutable FFmpeg, x264, dav1d and zlib sources. Eight independent codec fixtures passed, including HEVC 10-bit, AV1, VP8/VP9 and common audio formats. Exact decoded pixels matched the independent reference. PNG encoding and full video/audio decoding passed. The runtime is staged in resources/media with 30 hashed evidence files. Real-media integration passed. Earlier Windows packages and installer verification passed, but must be repeated after the latest native runtime and complete license notices are staged.

A 1080p60 animated-application sample measured the helper at 0.69 percent total CPU alone and 0.83 percent during production shareable compression on 16 logical CPUs. Its working set stayed at 211 MB. Saves took 316 ms alone and 358 ms while the second compression pass was 41 percent complete. Both 20-second originals fully decoded with changing frames. The 9.19 MB shareable took 32.5 seconds. This excludes the library and a loaded game, so it does not establish gameplay GPU impact.

Actual microphone proof passed a known 997 Hz tone through the physical microphone at -67.0 dB full gain, -72.5 dB half gain and -91 dB muted. Master and isolated microphone audio both muted. Tests restored the exact original speaker volume and mute state. These private room recordings stay ignored. Killing the actual helper with a pending save produced an unexpected-stop error, cleared requests, emitted no false success and allowed restarting the same TS adapter.

Linux's real failed-destination test exposed SIGPIPE terminating the recorder. Blocking that signal before OBS starts now preserves recording after a save failure, and a later save fully decodes. Windows failed destinations also release the queue slot without stopping capture. A gated save test accepted three immutable windows, rejected a fourth and rejected profile restart until the pending clips finished, then verified a different profile in the next session.

Public binaries remain blocked by incomplete corresponding-source evidence. The agent has captured actual staged OBS runtime versions and configurations, enabled FFmpeg dependencies, static Jansson/SIMDe/Uthash/Detours inputs, embedded license texts and MbedTLS framework sources. Electron's shared ffmpeg.dll also needs its LGPL source. Its immutable Electron, Chromium and FFmpeg revisions are resolved and the targeted collector is being completed. The release inventory now hashes this DLL too. Commit the clean release source before assembling evidence, validate the packaged source ZIP, then rebuild installers with the complete notices. A URL or license name alone does not clear a binary.

Controlled-media CI integration now cross-builds the same Windows CLI from captured immutable sources and carries those source archives with the internal build artifact. Windows jobs verify and record the executable's provenance before staging. Linux and macOS retain separate, unpublished media paths. Desktop CI publishes reports rather than installers. Linux native capture has its own actual-media workflow. Re-run the complete matrix after the next coherent commit and resolve real failures.

macOS capture, Wayland capture, Linux application capture, automatic game detection and overlap avoidance remain unavailable. Physical microphone and selected-application audio passed real tone checks on this machine. HDR, exclusive fullscreen popups, loaded-game impact, monitor disconnect and audio-device hotplug remain unverified. These limits must remain explicit. Fullscreen feedback currently uses lightweight Electron popups, not an injected native game overlay.

## Continuation

Dave authorized full implementation, public GitHub publishing, builds, computer testing and delegation. Repository is https://github.com/NoomStuff/AttaClip on main. Preserve all existing changes. Generated binaries, isolated test collections and private live captures stay out of Git. Never publish desktop recordings or private screenshots.

Agent ownership remains recorder for native code, wrapper, build/smoke scripts and native Linux workflow. Collection owns media, collection, corresponding-source tooling, controlled CLI and its CI integration. Interface finished preview and update-failure verification. Recorder finished capture-with-compression measurements and froze the verified runtime. Collection is closing the Electron source evidence. Root owns main integration, preferences, packaged checks and status docs. Coordinate before committing active edits.

Next steps are final controlled-media staging, verification, commit and push, successful GitHub checks, rebuilding Windows installers and testing them, then source-evidence completion before binary publication. The single continuation automation fired on 8 October at 15:40 Europe/Amsterdam. There is no later wakeup currently scheduled. If another usage reset is needed, update that same automation rather than creating a duplicate.
