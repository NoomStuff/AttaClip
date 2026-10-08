# Controlled Linux media

The Linux CLI recipe uses the same four source commits as the Windows release. It builds FFmpeg, x264, dav1d and zlib from existing hash-verified archives. It disables network protocols and external dependency detection, retains the built-in import decoders, and statically links the three external libraries. The ELF executables use the host C runtime and math library. Their recorded glibc requirements determine which Linux systems can run them.

Run this in the project checkout on Ubuntu 24.04 x64. The source inputs must already exist under `work/release-sources`. `scripts/release-sources.ts --controlled-inputs --collect-only` can collect them. Install GCC, G++, binutils, make, nasm, meson, ninja-build and pkg-config.

```sh
ATTACLIP_MEDIA_BUILD_JOBS=1 bash scripts/build-media-linux.sh
bun scripts/controlled-media-linux.ts
python3 scripts/smoke-controlled-media-linux.py
FFMPEG_PATH="$PWD/work/controlled-media/linux-x64/ffmpeg" \
FFPROBE_PATH="$PWD/work/controlled-media/linux-x64/ffprobe" bun tests/media.ts
bun scripts/controlled-media-linux.ts
```

The fixture script needs an independent full FFmpeg at `/usr/bin/ffmpeg`, or `ATTACLIP_REFERENCE_FFMPEG`. It generates eight real video/audio/container combinations, fully decodes each with the controlled binary, exercises PNG thumbnails, and compares decoded first-frame pixels with the independent reference. Record provenance again after verification to include the reports.

Output stays in `work/controlled-media/linux-x64`. The recipe captures source tar hashes, compressed archive hashes, configuration, full library licenses, compiler versions and ELF dependencies. The TypeScript recorder rejects unfinished builds, changed source inputs, missing required codecs and dynamically linked codec libraries. It records binary hashes and required glibc versions. It does not stage or overwrite `resources/media`.

This establishes correspondence for the Linux media CLI only. Public Linux installers also need corresponding sources and full notices for the exact OBS/PPA package, its bundled Ubuntu dependency libraries, Electron's playback FFmpeg module, and the final application. Passing the CLI checks does not clear those components.
