#!/usr/bin/env bash
set -euo pipefail

# Run on an Apple Silicon macOS host. Source archives come from release-sources.ts. This build
# never downloads a library or resolves a tag while compiling.
taskProject=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
taskSources="$taskProject/work/release-sources"
taskOutput="$taskProject/work/controlled-media/macos-arm64"
taskBuildRoot=${ATTACLIP_MEDIA_BUILD_ROOT:-$(mktemp -d -t attaclip-media.XXXXXX)}
taskJobs=${ATTACLIP_MEDIA_BUILD_JOBS:-2}
[[ $(uname -s) == Darwin && $(uname -m) == arm64 ]] || { echo "Build on an actual macOS arm64 host" >&2; exit 1; }
export MACOSX_DEPLOYMENT_TARGET=13.0
taskPrefix="$taskBuildRoot/prefix"
mkdir -p "$taskOutput" "$taskBuildRoot" "$taskPrefix"
# A rebuild must not retain verification records for the previous executables.
rm -f "$taskOutput/build-manifest.json" "$taskOutput/verification/codecs.json"
exec > >(tee "$taskOutput/build.log") 2>&1
printf '%s\n' "$taskBuildRoot" > "$taskOutput/build-root.txt"

taskFfmpegArchive="$taskSources/ffmpeg-btbn-core-29e619e767cde9045a75c29bc9a8278ae7b3a98b.tar.gz"
taskX264Archive="$taskSources/dependencies/02ba10fe849198a6-x264.tar.gz"
taskDav1dArchive="$taskSources/dependencies/35c9455c121eed5d-dav1d.tar.gz"
taskZlibArchive="$taskSources/dependencies/63e292ea77c8d4d2-zlib.tar.gz"
# Pin the entire tar, including its source bytes and metadata. Git and archive
# servers can use different gzip encoders without changing that input.
verify_source_tar() {
  local archive=$1 expected=$2 actual
  actual=$(gzip -cd "$archive" | shasum -a 256 | cut -d' ' -f1)
  if [[ "$actual" != "$expected" ]]; then
    printf 'Source contents changed: %s, expected %s, received %s\n' "$archive" "$expected" "$actual" >&2
    exit 1
  fi
  printf '%s  %s\n' "$actual" "$archive" >> "$taskOutput/source-tar-sha256.txt"
}
: > "$taskOutput/source-tar-sha256.txt"
verify_source_tar "$taskFfmpegArchive" e4febb1b201585dac61239258f5c2750e3ed7197e2d41d380385ff87fe2f92b0
verify_source_tar "$taskX264Archive" 5686546d663e7520bd05cd47a31d615d0dc707c089cfcb5924a1bcfd3aea7be5
verify_source_tar "$taskDav1dArchive" 86f69f5dd9a63c9f6bd6ba7f3b0172c89cf936559ba396dda40eba7a4e31e7a9
verify_source_tar "$taskZlibArchive" c26b1af0562377fe129e26be73e8adf50a2ac9250c2523fa5805bdbca47fabc7
shasum -a 256 "$taskFfmpegArchive" "$taskX264Archive" "$taskDav1dArchive" "$taskZlibArchive" > "$taskOutput/source-sha256.txt"

for tool in clang clang++ ar meson ninja pkg-config make otool xcrun; do
  command -v "$tool"
done
{
  sw_vers
  uname -a
  xcodebuild -version
  xcrun --show-sdk-path
  xcrun --show-sdk-version
  clang --version
  meson --version
  ninja --version
} > "$taskOutput/toolchain.txt"
cp "$taskProject/scripts/build-media-macos.sh" "$taskOutput/build-media-macos.sh"
shasum -a 256 "$taskOutput/build-media-macos.sh" > "$taskOutput/recipe-sha256.txt"

mkdir -p "$taskBuildRoot/x264" "$taskBuildRoot/dav1d" "$taskBuildRoot/ffmpeg" "$taskBuildRoot/zlib"
tar -xf "$taskX264Archive" -C "$taskBuildRoot/x264" --strip-components=1
tar -xf "$taskDav1dArchive" -C "$taskBuildRoot/dav1d" --strip-components=1
tar -xf "$taskFfmpegArchive" -C "$taskBuildRoot/ffmpeg" --strip-components=1
tar -xf "$taskZlibArchive" -C "$taskBuildRoot/zlib" --strip-components=1
export CC=clang
export CXX=clang++
export PKG_CONFIG_LIBDIR="$taskPrefix/lib/pkgconfig"
export PKG_CONFIG_PATH=""
export CFLAGS="-O3 -mmacosx-version-min=13.0"
export LDFLAGS="-mmacosx-version-min=13.0"

cd "$taskBuildRoot/zlib"
./configure --static --prefix="$taskPrefix"
make -j"$taskJobs"
make install
cp zconf.h "$taskOutput/zlib-config.h"
cp LICENSE "$taskOutput/LICENSE-zlib"

cd "$taskBuildRoot/x264"
./configure --prefix="$taskPrefix" --enable-static --enable-pic --disable-cli --disable-opencl
make -j"$taskJobs"
make install
cp config.mak "$taskOutput/x264-config.mak"
cp COPYING "$taskOutput/LICENSE-x264"

meson setup "$taskBuildRoot/dav1d-build" "$taskBuildRoot/dav1d" --prefix="$taskPrefix" --libdir=lib --buildtype=release --default-library=static --wrap-mode=nodownload -Denable_tools=false -Denable_examples=false -Denable_tests=false -Denable_docs=false
ninja -C "$taskBuildRoot/dav1d-build" -j"$taskJobs"
ninja -C "$taskBuildRoot/dav1d-build" install
cp "$taskBuildRoot/dav1d-build/config.h" "$taskOutput/dav1d-config.h"
cp "$taskBuildRoot/dav1d/COPYING" "$taskOutput/LICENSE-dav1d"

cd "$taskBuildRoot/ffmpeg"
# Keep FFmpeg's built-in import decoders, demuxers and filters. Only external
# dependencies and output encoders are reduced. Dav1d supplies software AV1.
./configure --prefix="$taskPrefix" --cc=clang --cxx=clang++ --arch=arm64 --target-os=darwin --enable-gpl --enable-libx264 --enable-libdav1d --enable-zlib --disable-autodetect --disable-network --disable-shared --enable-static --disable-doc --disable-debug --disable-ffplay --disable-devices --enable-indev=lavfi --disable-encoders --enable-encoder=libx264,aac,mjpeg,png,rawvideo,wrapped_avframe,pcm_s16le,pcm_f32le --disable-protocols --enable-protocol=file,pipe --pkg-config=pkg-config --pkg-config-flags=--static --extra-cflags="-I$taskPrefix/include -mmacosx-version-min=13.0" --extra-ldflags="-L$taskPrefix/lib -mmacosx-version-min=13.0" --extra-version=attaclip-local
make -j"$taskJobs" ffmpeg ffprobe
codesign --force --sign - ffmpeg ffprobe
cp ffmpeg ffprobe "$taskOutput/"
cp config.h config_components.h "$taskOutput/"
cp ffbuild/config.mak ffbuild/config.log "$taskOutput/"
cp COPYING.GPLv2 COPYING.LGPLv2.1 COPYING.LGPLv3 COPYING.GPLv3 LICENSE.md "$taskOutput/"
otool -L ffmpeg > "$taskOutput/ffmpeg-imports.txt"
otool -L ffprobe > "$taskOutput/ffprobe-imports.txt"
shasum -a 256 "$taskOutput/ffmpeg" "$taskOutput/ffprobe" > "$taskOutput/binary-sha256.txt"
printf 'Controlled macOS media build completed: %s\n' "$taskOutput"
