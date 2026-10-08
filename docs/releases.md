# Release sources

AttaClip's source repository can be public independently of installers. Installer publication requires a source kit for the exact staged binaries. The kit contains immutable archives, license texts, build recipes, configuration, and file hashes. No command creates a written source offer.

## Windows media

Windows now builds its own static FFmpeg and ffprobe rather than packaging the broad BtbN binary. The controlled recipe is `scripts/build-media-windows.sh`. It retains built-in import decoders, demuxers, and filters, with x264 encoding, dav1d AV1 decoding, and zlib for PNG thumbnails. It disables network protocols and automatic external-library detection. Required encoders and import components are checked against the generated configuration.

The exact four source inputs are FFmpeg `29e619e767cde9045a75c29bc9a8278ae7b3a98b`, x264 `0480cb05fa188d37ae87e8f4fd8f1aea3711f7ee`, dav1d `9711965b60bb692ae24004659acf61f5c7d9ed61`, and zlib `51b7f2abdade71cd9bb0e7a373ef2610ec6f9daf`. The recipe verifies archive checksums before compiling. Git exports explicitly fix text conversion so Ubuntu and Windows collect identical input archives.

In Ubuntu 24.04, install the MinGW cross compiler, binutils, make, nasm, meson, ninja, and pkg-config listed in README. Run `bun scripts/release-sources.ts --controlled-inputs --collect-only`, then `bash scripts/build-media-windows.sh`. On Windows, run `bun scripts/controlled-media.ts` to execute the binaries and record hashes of their source inputs, build recipe, configurations, compiler details, imported DLLs, licenses, and verification files. Output goes to `work/controlled-media/windows-x64`.

Set `FFMPEG_PATH` and `FFPROBE_PATH` to those executables before `bun run bundle:media`. Staging copies the captured build evidence beside the binaries. Windows `provision-media.ts` requires this controlled output. CI uses the same Ubuntu build recipe, shares binaries and source inputs through a short-lived internal artifact, and records provenance on the Windows runner before tests and packaging. CI does not upload public installers.

The 2026-10-08 controlled build passed eight independent real-media import fixtures covering H264, HEVC 10-bit, AV1, VP8, VP9, AAC, Opus, Vorbis, FLAC, MP3, and PCM. Its decoded first frames matched the independent reference decoder. Actual application media tests passed full-duration size-target exports, multi-track playback, cancellation, categories, moved collections, metadata recovery, folder conflicts, and deletion boundaries. Run `bun scripts/smoke-controlled-media.ts` with an independent full reference FFmpeg in `ATTACLIP_REFERENCE_FFMPEG`, then record provenance again to include that report.

## Windows recorder

The recorder uses the hash-verified official OBS 32.2.2 zip, SHA-256 `4d6e40e3ab155f56b30de517380566a206d74b63cdf5ad49aa596924768f97e1`. OBS source commit `ba2f32bdf791005443988a4955e963663e16b1ed` pins the dependency bundle dated 2026-07-15. The corresponding obs-deps recipe commit is `8683107a02300923abe4f293920f4b5edc8cb624`. Installed version strings do not establish runtime correspondence.

`scripts/probe-obs-runtime.ps1` reads the actual staged avcodec DLL's build configuration. The evidence assembler compares its enabled libraries to those pinned recipes and retains the selected dependency sources, patches, license texts, and build instructions. Its set includes FFmpeg 8.1.2, AOM, SVT-AV1, Theora, LAME, x264, Opus, Vorbis, Ogg, VPX, librist, SRT, MbedTLS, zlib, curl, GPU headers, and OBS's vendored w32-pthreads. It checks the MbedTLS framework gitlink and retains that source too. It preserves embedded header licenses from NVIDIA and librist's vendored cJSON and LZ4 sources in the installer notices.

The larger research checkpoint retains 134 dependency source records, about 717 MB, with no failed downloads. That overset includes libraries from the old broad BtbN build. Their Rust locks and shaderc submodules do not become requirements of the controlled four-input Windows CLI. Linux and macOS provider binaries still need their own source correspondence and license work. A Windows source kit cannot clear them.

## Assembling a release kit

Run `bun scripts/release-sources.ts --collect-only` to collect known immutable core sources, dependency recipes, license files, and hashes of staged resources under `work/release-sources`. `--dependencies` collects the broader enabled recipe closure as data without running upstream recipes. `--retry-dependencies` retries missing sources. `--inventory-only` skips downloads.

Commit the final application source before running `bun scripts/assemble-source-evidence.ts`. The assembler archives the clean AttaClip commit, copies Electron and JavaScript notices, probes the actual OBS configuration, captures the selected dependency sources and licenses, and writes `dependency-evidence.json`. It also populates `resources/notices/native`, so package again after assembly. JavaScript notices come from `bun run build:notices`. Electron's MIT license requires retaining its notices, not publishing its entire source tree.

Run `bun scripts/release-sources.ts --check` afterward. The checker rejects changed staged files, missing or changed source archives, stale helper build inputs, unmatched official OBS files, and incomplete component records. `publicInstallerReady` reports completeness of this technical evidence, not a legal conclusion. Review whether the recorded inputs actually correspond to each bundled binary before publication. A source record naming an unrelated archive does not establish correspondence.

Publish the complete source kit with the installer it covers. Preserve AttaCut's MIT notice and the full dependency notices in the package. General-purpose compilers and build tools do not require source archives in this kit. Development binary overrides do not establish public-release correspondence.

[FFmpeg's legal page](https://ffmpeg.org/legal.html) explains its source, configuration, and external library obligations. Until the exact kit passes and its correspondence has been reviewed, installers stay unpublished. CI build reports and private verification artifacts remain available.
