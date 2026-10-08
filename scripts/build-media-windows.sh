#!/usr/bin/env bash
set -euo pipefail

# Run in Ubuntu WSL. Source archives come from release-sources.ts. This build
# never downloads a library or resolves a tag while compiling.
taskProject=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
taskSources="$taskProject/work/release-sources"
taskOutput="$taskProject/work/controlled-media/windows-x64"
taskBuildRoot=${ATTACLIP_MEDIA_BUILD_ROOT:-$(mktemp -d -t attaclip-media.XXXXXX)}
taskJobs=${ATTACLIP_MEDIA_BUILD_JOBS:-4}
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
  actual=$(gzip -cd "$archive" | sha256sum | cut -d' ' -f1)
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
sha256sum "$taskFfmpegArchive" "$taskX264Archive" "$taskDav1dArchive" "$taskZlibArchive" > "$taskOutput/source-sha256.txt"

for tool in x86_64-w64-mingw32-gcc-posix x86_64-w64-mingw32-g++-posix x86_64-w64-mingw32-ar nasm meson ninja pkg-config make; do
  command -v "$tool"
done
{
  cat /etc/os-release
  x86_64-w64-mingw32-gcc-posix --version
  x86_64-w64-mingw32-g++-posix --version
  meson --version
  nasm --version
  dpkg-query -W gcc-mingw-w64-x86-64-posix g++-mingw-w64-x86-64-posix mingw-w64-x86-64-dev binutils-mingw-w64-x86-64 nasm meson ninja-build pkg-config make
} > "$taskOutput/toolchain.txt"
cp "$taskProject/scripts/build-media-windows.sh" "$taskOutput/build-media-windows.sh"
sha256sum "$taskOutput/build-media-windows.sh" > "$taskOutput/recipe-sha256.txt"
mkdir -p "$taskOutput/toolchain-notices"
for package in gcc-mingw-w64-x86-64-posix gcc-mingw-w64-x86-64-posix-runtime mingw-w64-x86-64-dev; do
  cp "/usr/share/doc/$package/copyright" "$taskOutput/toolchain-notices/$package.txt"
done

mkdir -p "$taskBuildRoot/x264" "$taskBuildRoot/dav1d" "$taskBuildRoot/ffmpeg" "$taskBuildRoot/zlib"
tar -xf "$taskX264Archive" -C "$taskBuildRoot/x264" --strip-components=1
tar -xf "$taskDav1dArchive" -C "$taskBuildRoot/dav1d" --strip-components=1
tar -xf "$taskFfmpegArchive" -C "$taskBuildRoot/ffmpeg" --strip-components=1
tar -xf "$taskZlibArchive" -C "$taskBuildRoot/zlib" --strip-components=1
export CC=x86_64-w64-mingw32-gcc-posix
export CXX=x86_64-w64-mingw32-g++-posix
export PKG_CONFIG_LIBDIR="$taskPrefix/lib/pkgconfig"
export PKG_CONFIG_PATH=""

cd "$taskBuildRoot/zlib"
make -f win32/Makefile.gcc PREFIX=x86_64-w64-mingw32- -j"$taskJobs" libz.a
mkdir -p "$taskPrefix/include" "$taskPrefix/lib/pkgconfig"
cp libz.a "$taskPrefix/lib/"
cp zlib.h zconf.h "$taskPrefix/include/"
sed -e "s|@prefix@|$taskPrefix|g" -e "s|@exec_prefix@|$taskPrefix|g" -e "s|@libdir@|$taskPrefix/lib|g" -e "s|@includedir@|$taskPrefix/include|g" -e 's|@VERSION@|1.3.1|g' zlib.pc.in > "$taskPrefix/lib/pkgconfig/zlib.pc"
cp LICENSE "$taskOutput/LICENSE-zlib"

cd "$taskBuildRoot/x264"
./configure --host=x86_64-w64-mingw32 --cross-prefix=x86_64-w64-mingw32- --prefix="$taskPrefix" --enable-static --disable-cli --disable-opencl --extra-ldflags="-static -static-libgcc"
make -j"$taskJobs"
make install
cp config.mak "$taskOutput/x264-config.mak"
cp COPYING "$taskOutput/LICENSE-x264"

cat > "$taskBuildRoot/mingw-cross.ini" <<EOF
[binaries]
c = 'x86_64-w64-mingw32-gcc-posix'
cpp = 'x86_64-w64-mingw32-g++-posix'
ar = 'x86_64-w64-mingw32-gcc-ar'
strip = 'x86_64-w64-mingw32-strip'
windres = 'x86_64-w64-mingw32-windres'
pkgconfig = 'pkg-config'

[host_machine]
system = 'windows'
cpu_family = 'x86_64'
cpu = 'x86_64'
endian = 'little'

[properties]
needs_exe_wrapper = true
EOF
cp "$taskBuildRoot/mingw-cross.ini" "$taskOutput/mingw-cross.ini"
meson setup "$taskBuildRoot/dav1d-build" "$taskBuildRoot/dav1d" --cross-file="$taskBuildRoot/mingw-cross.ini" --prefix="$taskPrefix" --libdir=lib --buildtype=release --default-library=static -Denable_tools=false -Denable_examples=false -Denable_tests=false -Denable_docs=false
ninja -C "$taskBuildRoot/dav1d-build" -j"$taskJobs"
ninja -C "$taskBuildRoot/dav1d-build" install
cp "$taskBuildRoot/dav1d-build/config.h" "$taskOutput/dav1d-config.h"
cp "$taskBuildRoot/dav1d/COPYING" "$taskOutput/LICENSE-dav1d"

cd "$taskBuildRoot/ffmpeg"
# Keep FFmpeg's built-in import decoders, demuxers and filters. Only external
# dependencies and output encoders are reduced. Dav1d supplies software AV1.
./configure --prefix="$taskPrefix" --target-os=mingw32 --arch=x86_64 --enable-cross-compile --cross-prefix=x86_64-w64-mingw32- --cc=x86_64-w64-mingw32-gcc-posix --cxx=x86_64-w64-mingw32-g++-posix --enable-gpl --enable-libx264 --enable-libdav1d --enable-zlib --disable-autodetect --disable-network --disable-shared --enable-static --disable-doc --disable-debug --disable-ffplay --disable-devices --enable-indev=lavfi --disable-encoders --enable-encoder=libx264,aac,mjpeg,png,wrapped_avframe,pcm_s16le --disable-protocols --enable-protocol=file,pipe --pkg-config=pkg-config --pkg-config-flags=--static --extra-cflags="-I$taskPrefix/include" --extra-ldflags="-L$taskPrefix/lib -static -static-libgcc -static-libstdc++" --extra-version=attaclip-local
make -j"$taskJobs" ffmpeg.exe ffprobe.exe
cp ffmpeg.exe ffprobe.exe "$taskOutput/"
cp config.h config_components.h "$taskOutput/"
cp ffbuild/config.mak ffbuild/config.log "$taskOutput/"
cp COPYING.GPLv2 COPYING.LGPLv2.1 COPYING.LGPLv3 COPYING.GPLv3 LICENSE.md "$taskOutput/"
x86_64-w64-mingw32-objdump -p ffmpeg.exe > "$taskOutput/ffmpeg-imports.txt"
x86_64-w64-mingw32-objdump -p ffprobe.exe > "$taskOutput/ffprobe-imports.txt"
sha256sum "$taskOutput/ffmpeg.exe" "$taskOutput/ffprobe.exe" > "$taskOutput/binary-sha256.txt"
printf 'Controlled Windows media build completed: %s\n' "$taskOutput"
