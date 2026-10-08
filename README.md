# AttaClip

Save the moment. Keep it yours.

AttaClip is a local-first desktop clipping app built with Electron and a separate native libOBS recorder. It keeps recent footage while recording, saves clips through a global shortcut, and creates smaller shareable copies without changing the original.

## The workflow

Choose a screen or application, start recording, and press the clip shortcut when something happens. Browse your collection, preview individual audio tracks, and create a copy under your chosen file-size limit. Nothing is uploaded by the app.

The library is an ordinary folder. Existing supported videos appear automatically. Categories and original/shareable relationships live in `.attaclip`; compressed copies live under `shareables`, mirroring the source folders. Your videos remain usable without AttaClip.

AttaClip is for clips. Use OBS for full-session recording and AttaCut for cutting.

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

`provision-media.ts` downloads checksum-pinned FFmpeg and ffprobe builds. It exports their paths to later GitHub Actions steps. For a local shell, set `FFMPEG_PATH` and `FFPROBE_PATH` to the printed paths before running `bundle:media`, or supply your own compatible binaries. `bundle:media` stages them and records their hashes and build configuration. Development runs work without a native helper, but recording stays unavailable until it is built. The UI never simulates successful recording.

The first native backend targets Windows with an OBS runtime. macOS and Linux application packaging are targets, but their capture backends require platform verification. Automatic game detection is not yet implemented. Choose a screen or application explicitly.

## Verification

```sh
bun run verify
bun run test:media
bun run test:ui
bun run test:native
bun run package
bun run test:packaged
```

`verify` checks formatting, lint, unit tests, strict types, and the application build. Media verification creates isolated real videos and checks full-duration size-limited exports, original preservation, cancellation, playback tracks, collection recovery, and safe file ownership. UI tests launch the actual Electron app against an isolated profile. Screenshots and traces land in `test-results`. Native and packaged capture tests record the selected screen on a supported Windows machine, check queued saves through source changes and stopping, and decode the actual outputs. Run those with test content visible on screen.

`ATTACLIP_PROFILE`, `ATTACLIP_COLLECTION`, and `ATTACLIP_TEST=1` isolate manual or automated runs from your real preferences and library. The test flag suppresses notification windows and OS startup changes. Never point destructive tests at a real collection.

## Recording guarantees and current limits

Recording and clip requests belong to the native helper, not the library renderer. Source switches keep a stable output size. Clip requests retain their request boundaries while writing is queued. Stopping clears unsaved history but preserves accepted saves.

Low, Standard, High, and Custom profiles expose the actual resolution and frame rate. Custom settings include encoder quality. Hardware encoding is preferred; software encoding requires an explicit opt-in. Microphone selection, gain and mute controls belong to the recorder. Closing or minimizing the library stops its preview work while capture continues.

Originals currently use MKV for recoverable saving. Compatible MP4 playback copies are made on demand, without replacing the original. Shareables use H.264 video and the master audio mix in MP4. Their completed size and duration are checked before publication. A too-small budget produces an error rather than a truncated clip.

Shareable encoding is bounded, below-normal-priority software encoding. It is still extra work while recording. Native fullscreen popup behavior, encoder selection, HDR, application-audio compatibility, and cross-platform recording need further measurements. A successful installer build alone does not validate capture.

## Builds and releases

GitHub Actions runs the verification suite and has a separate manual/tagged desktop-build workflow. Public releases must include the corresponding sources and notices for the actual OBS and FFmpeg distributions used. Packaging does not automatically publish an installer.

Installed Windows and Linux AppImage updates can download through electron-updater and restart only on an explicit action. Unsigned macOS and portable Windows builds use the releases page. Pending saves and exports use the same exit safeguards when updating.

## License

AttaClip is GPL-3.0-or-later. Reused AttaCut code retains its MIT notices. See [third-party notices](THIRD_PARTY_NOTICES.md). Commercial use is permitted by the GPL; recorded videos do not inherit the software license.
