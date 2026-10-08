# Release sources

Publish the AttaClip repository independently of installers. The current installer bundles native recording and media binaries whose complete corresponding source sets are not yet captured. A successful build or a license text does not settle that gap.

Run `bun scripts/release-sources.ts --collect-only` to collect the known upstream source archives, build recipes, their license files, and hashes of every staged resource. Output goes to `work/release-sources`. `bun scripts/release-sources.ts --check` checks those files again and exits with failure while dependency evidence is incomplete. `--inventory-only` skips downloads. None of these commands creates a written source offer.

The source archive addresses use immutable commits. The collector records downloaded archive hashes, but does not claim those hashes were published independently by upstream. Keep the manifest and archives together. Recollect after rebuilding or changing staged resources. A kit for one binary set cannot clear another.

`dependencyRecipeRefs` lists the repositories, source revisions or download hashes, and enable flags parsed from the pinned BtbN and OBS dependency recipes. This is the starting list for collecting external sources. The recipe archives retain their patches and full scripts. General-purpose compilers and build tools are not missing application source; the collector does not require archiving a compiler container.

Add `--dependencies` to collect the declared enabled-library source set. The collector follows literal `ffbuild_depends` declarations and grouped private prerequisites without executing recipes. GitHub, GitLab and Googlesource archives, hash-pinned external archives, and pinned Git/SVN exports retain their revision and license evidence. AMF needs only the headers that its recipe installs, so its export excludes SDK sample binaries and media assets. Set `ATTACLIP_SVN_PATH` when SVN is not on PATH. `--retry-dependencies --collect-only` retries missing sources without repeating successful downloads. The manifest retains `dependencySources`, `dependencyFailures`, and source-specific review notes. Submodules, Rust package dependencies, mutable tag correspondence, and nonliteral dependency declarations still need review and additional source capture before release evidence is complete.

## Source collection checkpoint

The 2026-10-08 local collection captured 134 dependency source records, about 717 MB, with no remaining failed downloads. This includes OBS's FFmpeg 8.1.2 source at `38b88335f99e76ed89ff3c93f877fdefce736c13`, its dependency inputs, and the enabled BtbN libraries and declared prerequisites. Pinned SVN exports cover LAME revision 6835 and Xvid revision 2204. OBS's w32-pthreads source and license are already in the OBS core archive. The recipe archives include the required patches.

This checkpoint does not clear installers. Capture shaderc's DEPS inputs and the gitlinks fetched by the libjxl, libplacebo, GLib, zimg, OpenSSL and MbedTLS recipes. Rust libraries rav1e and librsvg also need the crate sources used by their recorded lockfiles. Review which submodules contain build tools or disabled tests so those do not become false source requirements. The nv-codec headers keep their license text inside source headers rather than a standalone license file; retain that text in the notices packet.

Vulkan-Headers, OpenSSL and MbedTLS recipes pin tags. The collector resolves today's tag to a commit and records both, but does not establish which commit the original dependency image used at release time. Confirm those inputs through the original build records or rebuild from captured immutable inputs before clearing the corresponding binaries. The current dependency catalog includes an overset of platform prerequisites; filter requirements using the selected platform's build conditions before declaring its exact source closure.

## Pinned inputs

OBS 32.2.2 uses commit `ba2f32bdf791005443988a4955e963663e16b1ed`. Its [CMake presets](https://github.com/obsproject/obs-studio/blob/ba2f32bdf791005443988a4955e963663e16b1ed/CMakePresets.json) pin the Windows dependency bundle dated 2026-07-15. The corresponding [obs-deps recipes](https://github.com/obsproject/obs-deps/tree/8683107a02300923abe4f293920f4b5edc8cb624) contain dependency versions, patches and license material. The kit collects the OBS source, its three pinned submodule sources, and those recipes. The runtime must come from the hash-verified official release zip. An installed OBS version string alone cannot identify all its DLLs.

Windows and Linux FFmpeg archives are pinned in `scripts/media-lock.ts` to BtbN's retained month-end build `autobuild-2026-09-30-13-08`. Its FFmpeg core commit is `29e619e767cde9045a75c29bc9a8278ae7b3a98b`. The build recipe commit is `6c9aec5fc9a72ec3abedd1fa84db141fa18cf52b`. The kit collects both. BtbN's [build script](https://github.com/BtbN/FFmpeg-Builds/blob/6c9aec5fc9a72ec3abedd1fa84db141fa18cf52b/build.sh) packages compiled files and the selected FFmpeg license. It does not package every external library's source in that binary archive. For example, its [x264 recipe](https://github.com/BtbN/FFmpeg-Builds/blob/6c9aec5fc9a72ec3abedd1fa84db141fa18cf52b/scripts.d/50-x264.sh) identifies a separate source commit.

Local Gyan binaries and the two macOS providers need separate correspondence records. The BtbN core archive cannot cover them. Never substitute a binary found on PATH during public release staging.

## Before publishing installers

- Capture the exact sources, patches and build instructions for each bundled OBS dependency and each enabled FFmpeg external library. Include the source used by the dependency container, rather than assuming its current upstream branch matches the retained binary.
- Match every staged OBS runtime file against the official zip. Record helper build-input hashes, compiler version and commands. Archive AttaClip's clean release commit, including the native helper, vendored JSON header and build scripts.
- Preserve the packaged Electron license and third-party notices. Electron's MIT license does not itself require publishing its source. Preserve AttaCut's MIT notice.
- Make the complete source kit available with the exact installer it covers. Review the dependency license requirements before turning on automatic public installer uploads. Do not add a source-offer promise to fill missing archives.

[FFmpeg's legal page](https://ffmpeg.org/legal.html) explains why exact source, build configuration and external library obligations matter. The kit is evidence collection, not a replacement for that review. Until the missing source sets are captured, CI may build private test artifacts and the source repository may be public, but installers stay unpublished.

## Completing the evidence

The manifest lists the actual missing component IDs under `requiredEvidence`. Add `work/release-sources/dependency-evidence.json` after collecting those files. Its `stagedDigest` is SHA-256 of the JSON serialization of the manifest's `staged` array. Its `components` array has one record per required ID, with `id`, `version`, SPDX `license`, and arrays named `sourceArchives`, `licenseFiles`, and `buildInstructions`. Each file record contains its path relative to the kit, SHA-256 and byte size. Include complete transitive dependencies in the OBS FFmpeg record, not only its core source.

The checker requires license evidence for every component. Known permissive SPDX licenses may omit source archives; copyleft or unclassified licenses require source and build material. A fresh collection can pass once all records match the current binaries and their files exist with the recorded hashes. `publicInstallerReady` reports completeness of this technical evidence, not a legal conclusion. Review whether the archived code actually corresponds to the binaries before enabling publication. A hand-written record naming an unrelated source archive does not establish that correspondence.
