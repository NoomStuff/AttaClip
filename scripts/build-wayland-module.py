"""Build the pinned OBS portal module and record its corresponding source."""
import hashlib
import json
import pathlib
import shlex
import shutil
import subprocess
import sys
import tarfile
import urllib.request

root = pathlib.Path.cwd().resolve()
local = root / "work/linux-release-sources/packages/obs-studio-332199354460ab3c/obs-studio_32.2.0.orig.tar.gz"
archive = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else local if local.exists() else root / ".cache/obs-studio_32.2.0.orig.tar.gz").resolve()
expected = "ac4b530d1a3703edb0451de04790b578177dae550584a8afb5beb78b9cef63dc"
archive_url = "https://ppa.launchpadcontent.net/obsproject/obs-studio/ubuntu/pool/main/o/obs-studio/obs-studio_32.2.0.orig.tar.gz"

def digest(file):
    with open(file, "rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()

assert sys.platform == "linux", "Build this module on Linux"
if not archive.exists():
    assert archive == root / ".cache/obs-studio_32.2.0.orig.tar.gz", "A supplied source archive must exist"
    archive.parent.mkdir(parents=True, exist_ok=True)
    temporary = archive.with_suffix(".download")
    try:
        with urllib.request.urlopen(archive_url, timeout=60) as response, temporary.open("wb") as output:
            total = 0
            while block := response.read(1024 * 1024):
                total += len(block)
                assert total <= 160694412, "The source download exceeded the pinned archive size"
                output.write(block)
        assert digest(temporary) == expected, "Downloaded source digest differs from the official .dsc"
        temporary.replace(archive)
    finally:
        temporary.unlink(missing_ok=True)
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
        if not (str(tail).startswith("plugins/linux-pipewire/") or str(tail).startswith("deps/glad/") or str(tail) == "COPYING") or not member.isfile():
            continue
        data = package.extractfile(member).read()
        file = source / str(tail)
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(data)
        originals[str(tail)] = hashlib.sha256(data).hexdigest()
assert len(originals) > 10, "The archive did not contain the required module source"
patch = root / "native/wayland/obs-pipewire-health.patch"
subprocess.run(["patch", "--batch", "--forward", "--fuzz=0", "-p1", "--input", str(patch)], cwd=source, check=True)
subprocess.run(["cmake", "-S", str(root / "native/wayland"), "-B", str(build), "-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON", "-DOBS_PIPEWIRE_SOURCE_DIR=" + str(source)], check=True)
subprocess.run(["cmake", "--build", str(build), "-j2"], check=True)
# Record the linker's actual opened inputs, rather than infer them from -l flags.
link_command = [argument.replace("\\$", "$") for argument in shlex.split((build / "CMakeFiles/linux-pipewire.dir/link.txt").read_text())]
linked = subprocess.run([*link_command, "-Wl,-t"], cwd=build, text=True, capture_output=True, check=True)
(build / "linker-trace.txt").write_text(linked.stdout)
module = build / "linux-pipewire.so"
depfiles = list(build.glob("CMakeFiles/linux-pipewire.dir/**/*.o.d"))
assert len(depfiles) == 7, "The module dependency evidence is incomplete"
headers = set()
for depfile in depfiles:
    dependencies = shlex.split(depfile.read_text().replace("\\\n", " ").split(":", 1)[1])
    for dependency in dependencies:
        file = pathlib.Path(dependency).resolve()
        if not file.is_relative_to(source) and file.is_file():
            headers.add(file)
commands = json.loads((build / "compile_commands.json").read_text())
assert len(commands) == 7
compiler = shlex.split(commands[0]["command"])[0]
implicit_inputs = set()
linker_paths = {}
for line in linked.stdout.splitlines():
    file = pathlib.Path(line.strip())
    if file.is_absolute():
        reported = str(file)
        file = file.resolve()
        assert file.is_file(), "Linker input is missing: " + line
        implicit_inputs.add(file)
        linker_paths[reported] = str(file)
assert any(file.name.startswith("libobs.so") for file in implicit_inputs), "The linker trace must bind libobs"
compiler_inputs = {pathlib.Path(shutil.which(compiler)).resolve()}
compiler_paths = {compiler: str(next(iter(compiler_inputs)))}
for name in ["cc1", "as", "ld"]:
    program = subprocess.check_output([compiler, "-print-prog-name=" + name], text=True).strip()
    file = pathlib.Path(shutil.which(program) or program).resolve()
    assert file.is_file(), "Compiler program is missing: " + name
    compiler_inputs.add(file)
    compiler_paths[program] = str(file)
owners = {}
package_records = {}
query = subprocess.check_output(["dpkg-query", "-S", *map(str, sorted(headers | implicit_inputs | compiler_inputs))], text=True)
for line in query.splitlines():
    if ": " in line:
        owner, file = line.split(": ", 1)
        owners[file] = owner

def installed_record(file):
    owner = owners[str(file)]
    if owner not in package_records:
        fields = subprocess.check_output(["dpkg-query", "-W", "-f=${Package}\t${Version}\t${source:Package}\t${source:Version}", owner], text=True).split("\t")
        assert len(fields) == 4
        package_records[owner] = dict(zip(["binaryPackage", "binaryVersion", "sourcePackage", "sourceVersion"], fields))
    record = package_records[owner]
    system = record["binaryPackage"].startswith(("libc6", "linux-libc-dev", "libgcc-", "gcc-", "binutils"))
    return {"path": str(file), "sha256": digest(file), "size": file.stat().st_size, **record, "systemLibrary": system}

evidence = [build / "compile_commands.json", build / "CMakeCache.txt", build / "CMakeFiles/linux-pipewire.dir/link.txt", build / "linker-trace.txt", *depfiles]
provenance = {
    "obsVersion": "32.2.0",
    "sourceArchive": {"name": archive.name, "url": archive_url, "sha256": expected, "size": archive.stat().st_size},
    "originalSourceHashes": originals,
    "patchedSourceHashes": {name: digest(source / name) for name in originals},
    "sourceHashes": {name: digest(root / name) for name in ["native/wayland/CMakeLists.txt", "native/wayland/obs-pipewire-health.patch", "scripts/build-wayland-module.py"]},
    "module": {"name": module.name, "sha256": digest(module), "size": module.stat().st_size},
    "compilerVersion": subprocess.check_output([compiler, "--version"], text=True).strip(),
    "compilerInputs": [installed_record(file) for file in sorted(compiler_inputs)],
    "compilerPaths": compiler_paths,
    "buildEvidence": [{"path": str(file.relative_to(build)), "sha256": digest(file), "size": file.stat().st_size} for file in evidence],
    "headers": [installed_record(file) for file in sorted(headers)],
    "linkerInputs": [installed_record(file) for file in sorted(implicit_inputs)],
    "linkerPaths": linker_paths,
}
(build / "provenance.json").write_text(json.dumps(provenance, indent=2) + "\n")
print("Built pinned portal health module", module)
