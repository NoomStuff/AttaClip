# Third-party notices

AttaClip is distributed under GPL-3.0-or-later. Reused MIT code retains its original license. See LICENSE and LICENSE-AttaCut.

## AttaCut

Copyright NoomStuff. MIT. AttaClip adapts AttaCut's media serving, binary provisioning, release conventions, and explicit update behavior. The renderer is a new design for this product.

Source: https://github.com/NoomStuff/AttaCut

## OBS Studio and libOBS

GNU GPL version 2 or later. The native helper links with libOBS. Runtime versions and source references are recorded in the recorder bundle's provenance.

Source and build instructions: https://github.com/obsproject/obs-studio

## FFmpeg

The build depends on the selected FFmpeg distribution. GPL builds require corresponding sources for FFmpeg and enabled libraries. Bundled versions, configure flags, and checksums are in resources/media/provenance.json. Provisioning uses checksum-pinned archives from scripts/media-lock.ts.

Source and build instructions: https://ffmpeg.org/ and https://github.com/BtbN/FFmpeg-Builds

## Application dependencies

Electron, React, electron-updater, Lucide, Zod, and the development toolchain retain their upstream licenses. The lockfile identifies the exact dependency versions. Lucide icons are ISC licensed. Electron includes Chromium and Node.js and their notices.

Release bundles must preserve upstream licenses and provide corresponding source for GPL components. A source archive of AttaClip alone does not include all bundled dependency sources.
