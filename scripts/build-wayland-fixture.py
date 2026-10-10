"""Build an isolated SHM-compatible portal fixture, never install it on the host."""
import hashlib
import pathlib
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request

root = pathlib.Path.cwd().resolve()
archive = root / ".cache/xdpw-0.5.0.tar.gz"
expected = "961cdfbaf7873124f96c86f41e90d304888e93a1da7ebe4a6ea2f1a824788307"
archive.parent.mkdir(parents=True, exist_ok=True)
if not archive.exists():
    with urllib.request.urlopen("https://codeload.github.com/emersion/xdg-desktop-portal-wlr/tar.gz/refs/tags/v0.5.0", timeout=60) as response:
        data = response.read(2 * 1024 * 1024 + 1)
        assert len(data) <= 2 * 1024 * 1024
        assert hashlib.sha256(data).hexdigest() == expected
        archive.write_bytes(data)
assert hashlib.file_digest(archive.open("rb"), "sha256").hexdigest() == expected
with tempfile.TemporaryDirectory(prefix="attaclip-portal-build-") as private:
    source = pathlib.Path(private) / "source"
    source.mkdir()
    with tarfile.open(archive) as package:
        for member in package:
            tail = pathlib.PurePosixPath(*pathlib.PurePosixPath(member.name).parts[1:])
            assert not tail.is_absolute() and ".." not in tail.parts
            if not member.isfile():
                continue
            file = source / str(tail)
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(package.extractfile(member).read())
    build = pathlib.Path(private) / "build"
    subprocess.run(["meson", "setup", str(build), str(source), "-Dman-pages=disabled", "-Dsd-bus-provider=libsystemd"], check=True)
    subprocess.run(["meson", "compile", "-C", str(build), "-j2"], check=True)
    output = root / ".cache/wayland-portal-fixture"
    shutil.copy2(build / "xdg-desktop-portal-wlr", output)
    print("Private portal fixture", output)
