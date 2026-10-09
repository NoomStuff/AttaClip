"""Build the experimental OBS portal health bridge. Does not stage production files."""
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys
import tarfile

root = pathlib.Path.cwd().resolve()
archive = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "work/linux-release-sources/packages/obs-studio-332199354460ab3c/obs-studio_32.2.0.orig.tar.gz").resolve()
expected = "ac4b530d1a3703edb0451de04790b578177dae550584a8afb5beb78b9cef63dc"

def digest(file):
    with open(file, "rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()

assert sys.platform == "linux", "Build this module on Linux"
assert digest(archive) == expected, "OBS source archive does not match the official 32.2.0 .dsc"
assert subprocess.check_output(["pkg-config", "--modversion", "libobs"], text=True).strip() == "32.2.0", "The installed OBS headers must match 32.2.0"
source = root / ".cache/wayland-patched-source"
build = root / ".cache/wayland-module-build"
assert source.parent == root / ".cache" and build.parent == root / ".cache"
if source.exists():
    shutil.rmtree(source)
source.mkdir(parents=True)
originals = {}
with tarfile.open(archive) as package:
    for member in package:
        tail = pathlib.PurePosixPath(*pathlib.PurePosixPath(member.name).parts[1:])
        if ".." in tail.parts or tail.is_absolute():
            raise ValueError("Invalid source archive path")
        if not (str(tail).startswith("plugins/linux-pipewire/") or str(tail).startswith("deps/glad/")) or not member.isfile():
            continue
        data = package.extractfile(member).read()
        file = source / str(tail)
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(data)
        originals[str(tail)] = hashlib.sha256(data).hexdigest()
assert len(originals) > 10, "The archive did not contain the required module source"
patch = root / "native/wayland/obs-pipewire-health.patch"
subprocess.run(["patch", "--batch", "--forward", "--fuzz=0", "-p1", "--input", str(patch)], cwd=source, check=True)
subprocess.run(["cmake", "-S", str(root / "native/wayland"), "-B", str(build), "-DCMAKE_BUILD_TYPE=Release", "-DOBS_PIPEWIRE_SOURCE_DIR=" + str(source)], check=True)
subprocess.run(["cmake", "--build", str(build), "-j2"], check=True)
module = build / "linux-pipewire.so"
provenance = {
    "experimental": True,
    "productionStaged": False,
    "obsVersion": "32.2.0",
    "sourceArchive": {"name": archive.name, "sha256": expected, "size": archive.stat().st_size},
    "originalSourceHashes": originals,
    "patchedSourceHashes": {name: digest(source / name) for name in originals},
    "sourceHashes": {name: digest(root / name) for name in ["native/wayland/CMakeLists.txt", "native/wayland/obs-pipewire-health.patch", "scripts/build-wayland-module.py"]},
    "module": {"name": module.name, "sha256": digest(module), "size": module.stat().st_size},
}
(build / "provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
print("Built experimental portal health module", module)
