"""Bind actual staged Mach-O dependencies to the pinned official OBS image.

Run on the Mac build host. Never use a version string as a substitute for the
official-file byte comparison. The local helper and altered mux have their own
source/build records and are deliberately separate from provider binaries.
"""
import ctypes
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

PIN = "920d6f26703d2df6e4085bd3c1cbed30488325084136c7a6e9e37021fbd6aaf7"
project = Path.cwd()
runtime = project / "resources/recorder"
provenance = json.loads((runtime / "provenance.json").read_text())
archive = project / ".cache/macos-probe/OBS-Studio-32.2.2-macOS-Apple.dmg"
if hashlib.sha256(archive.read_bytes()).hexdigest() != PIN:
    raise RuntimeError("Official OBS image checksum mismatch")
if provenance["runtimeArchive"]["sha256"] != PIN:
    raise RuntimeError("Staged recorder uses another OBS release")
mount = Path(tempfile.mkdtemp(prefix="attaclip-source-obs-"))
subprocess.run(["hdiutil", "attach", "-readonly", "-nobrowse", "-mountpoint", str(mount), str(archive)], check=True, capture_output=True)
files = []
try:
    for entry in provenance["providerFiles"]:
        relative = Path(entry["path"])
        if relative.is_absolute() or ".." in relative.parts:
            raise RuntimeError("Unsafe provider path")
        staged = runtime / relative
        if hashlib.sha256(staged.read_bytes()).hexdigest() != entry["sha256"]:
            raise RuntimeError(f"Staged provider file changed: {relative}")
        if relative.parts[0] not in ["Frameworks", "PlugIns"]:
            continue
        official = mount / "OBS.app/Contents" / relative
        if staged.read_bytes() != official.read_bytes():
            raise RuntimeError(f"Staged provider differs from official OBS: {relative}")
        description = subprocess.check_output(["file", "-b", str(staged)], text=True).strip()
        if "Mach-O" in description:
            files.append({**entry, "size": staged.stat().st_size, "description": description,
                          "imports": subprocess.check_output(["otool", "-L", str(staged)], text=True)})
finally:
    subprocess.run(["hdiutil", "detach", str(mount)], check=True, capture_output=True)

libraries = runtime / "Frameworks"
configurations = []
for name, prefix in [("libavutil.dylib", "avutil"), ("libswresample.dylib", "swresample"),
                     ("libavcodec.dylib", "avcodec"), ("libavformat.dylib", "avformat"),
                     ("libavdevice.dylib", "avdevice"), ("libavfilter.dylib", "avfilter"),
                     ("libswscale.dylib", "swscale")]:
    library = ctypes.CDLL(str(libraries / name))
    configuration = getattr(library, prefix + "_configuration")
    configuration.restype = ctypes.c_char_p
    version = getattr(library, prefix + "_version")
    version.restype = ctypes.c_uint
    configurations.append({"file": "Frameworks/" + name, "version": version(), "configuration": configuration().decode()})
output = project / ".cache/macos-source/runtime-proof.json"
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps({"version": 1, "officialArchive": {"name": archive.name, "sha256": PIN},
                              "sourceCommit": provenance["sourceCommit"], "providerFiles": files,
                              "ffmpegConfigurations": configurations,
                              "provenanceSha256": hashlib.sha256((runtime / "provenance.json").read_bytes()).hexdigest()}, indent=2) + "\n")
print(f"Compared {len(files)} Mach-O files with official OBS and probed all FFmpeg configurations")
