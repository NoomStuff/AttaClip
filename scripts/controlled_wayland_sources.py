"""Verify one controlled OBS PipeWire module, including patched source and consumed headers."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import subprocess
import tarfile
import tempfile

OBS_SHA = "ac4b530d1a3703edb0451de04790b578177dae550584a8afb5beb78b9cef63dc"
OBS_SIZE = 160694412
MODULE = "obs-plugins/linux-pipewire.so"
INPUTS = {"native/wayland/CMakeLists.txt", "native/wayland/obs-pipewire-health.patch", "scripts/build-wayland-module.py"}


def digest(file):
    with open(file, "rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def safe_path(root, relative):
    if not relative or "\\" in relative or ":" in relative or relative.startswith("/") or any(part in ("", ".", "..") for part in relative.split("/")):
        raise ValueError("Unsafe controlled-module path: " + relative)
    target = root / relative
    if not target.resolve().is_relative_to(root.resolve()) or target.is_symlink():
        raise ValueError("Controlled-module path escapes its packet: " + relative)
    return target


def selected(name):
    return name == "COPYING" or name.startswith("plugins/linux-pipewire/") or name.startswith("deps/glad/")


def replay_sources(archive, patch, original, patched):
    """Read tar members as data, then apply the exact patch with no fuzzy matching."""
    if not original or set(original) != set(patched) or len(original) <= 10:
        raise ValueError("Module source inventory is incomplete")
    for line in patch.read_text().splitlines():
        if line.startswith(("--- ", "+++ ")):
            name = line[4:].split("\t", 1)[0].split(" ", 1)[0]
            if not name.startswith(("a/plugins/linux-pipewire/", "b/plugins/linux-pipewire/")) or ".." in PurePosixPath(name).parts:
                raise ValueError("Patch touches a file outside the pinned module")
    with tempfile.TemporaryDirectory(prefix="attaclip-wayland-replay-") as temporary:
        root = Path(temporary)
        found = {}
        with tarfile.open(archive) as source:
            for member in source:
                name = str(PurePosixPath(*PurePosixPath(member.name).parts[1:]))
                if not member.isfile() or not selected(name):
                    continue
                target = safe_path(root, name)
                if name in found:
                    raise ValueError("Duplicate original module source: " + name)
                data = source.extractfile(member).read()
                found[name] = hashlib.sha256(data).hexdigest()
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
        if found != original:
            raise ValueError("Original module or GLAD source differs from the pinned archive")
        result = subprocess.run(["patch", "--batch", "--forward", "--fuzz=0", "-p1", "--input", str(patch.resolve())], cwd=root, text=True, capture_output=True)
        if result.returncode or re.search(r"offset|fuzz|FAILED", result.stdout + result.stderr, re.I):
            raise ValueError("Exact module patch replay failed: " + result.stdout + result.stderr)
        actual = {name: digest(safe_path(root, name)) for name in found}
        extras = {str(file.relative_to(root)) for file in root.rglob("*") if file.is_file()}
        if actual != patched or extras != set(found):
            raise ValueError("Patched source inventory differs from exact replay")


def validate_identity(proof):
    archive = proof["sourceArchive"]
    if proof.get("obsVersion") != "32.2.0" or archive["sha256"] != OBS_SHA or archive["size"] != OBS_SIZE:
        raise ValueError("Controlled module uses another OBS source archive")
    if set(proof["sourceHashes"]) != INPUTS:
        raise ValueError("Controlled module build-input fingerprints are incomplete")
    if proof["module"]["name"] != "linux-pipewire.so" or not re.fullmatch(r"[a-f0-9]{64}", proof["module"]["sha256"]) or proof["module"]["size"] <= 0:
        raise ValueError("Controlled module binary identity is invalid")
    if not proof.get("compilerVersion") or len(proof.get("compilerInputs", [])) != 4 or not proof.get("buildEvidence") or not proof.get("headers") or not proof.get("linkerInputs") or not proof.get("linkerPaths"):
        raise ValueError("Controlled module lacks actual compiler, header or linker input evidence")


def check_build_evidence(root, record, proof):
    captured = {file["path"]: file for file in record["files"]}
    evidence = {file["path"]: file for file in proof["buildEvidence"]}
    if len(evidence) != len(proof["buildEvidence"]) or not {"compile_commands.json", "CMakeCache.txt", "CMakeFiles/linux-pipewire.dir/link.txt", "linker-trace.txt"}.issubset(evidence):
        raise ValueError("Controlled module compile/link/configuration evidence is incomplete")
    for relative, file in evidence.items():
        packet_name = "wayland/build/" + relative
        if packet_name not in captured or captured[packet_name]["sha256"] != file["sha256"] or captured[packet_name]["size"] != file["size"]:
            raise ValueError("Module build evidence differs from compilation: " + relative)
    commands = json.loads(safe_path(root, "wayland/build/compile_commands.json").read_text())
    expected = {"camera-portal.c", "formats.c", "linux-pipewire.c", "pipewire.c", "portal.c", "screencast-portal.c", "glad.c"}
    if len(commands) != 7 or {PurePosixPath(command["file"]).name for command in commands} != expected:
        raise ValueError("Module compilation did not use exactly the captured OBS and GLAD sources")
    compiled = set()
    outputs = {}
    for command in commands:
        name = PurePosixPath(command["file"]).name
        suffix = "deps/glad/src/glad.c" if name == "glad.c" else "plugins/linux-pipewire/" + name
        arguments = shlex.split(command["command"])
        if not command["file"].endswith("/" + suffix) or suffix not in proof["patchedSourceHashes"] or "-c" not in arguments or arguments[arguments.index("-c") + 1] != command["file"] or "-o" not in arguments or arguments[arguments.index("-o") + 1] != command.get("output"):
            raise ValueError("Compiler command is not bound to the replayed module source")
        outputs[command["output"] + ".d"] = command["file"]
        compiled.add(command["file"])
    compiler = {file["path"]: file for file in proof["compilerInputs"]}
    if len(compiler) != 4:
        raise ValueError("Compiler input evidence has duplicate programs")
    drivers = {shlex.split(command["command"])[0] for command in commands}
    link = shlex.split(safe_path(root, "wayland/build/CMakeFiles/linux-pipewire.dir/link.txt").read_text())
    aliases = proof.get("compilerPaths", {})
    if len(drivers) != 1 or link[0] not in drivers or set(aliases.values()) != set(compiler) or not drivers.issubset(aliases) or not PurePosixPath(aliases[link[0]]).name.startswith("x86_64-linux-gnu-gcc"):
        raise ValueError("Module compiler and linker evidence disagree")
    trace = {line.strip() for line in safe_path(root, "wayland/build/linker-trace.txt").read_text().splitlines() if line.strip().startswith("/")}
    if trace != set(proof["linkerPaths"]) or set(proof["linkerPaths"].values()) != {file["path"] for file in proof["linkerInputs"]}:
        raise ValueError("Recorded linker inputs differ from actual linker trace")
    explicit = {argument for argument in link if argument.startswith("/") and argument != link[0]}
    if not explicit.issubset(trace) or not any(PurePosixPath(name).name.startswith("libobs.so") for name in trace):
        raise ValueError("Actual module link did not consume matching libobs and explicit libraries")
    depfiles = [name for name in evidence if name.endswith(".o.d")]
    if len(depfiles) != 7 or set(depfiles) != set(outputs):
        raise ValueError("Missing actual dependency file for a module compilation unit")
    if {argument for argument in link if argument.endswith(".o")} != {name.removesuffix(".d") for name in outputs}:
        raise ValueError("Actual module linker did not consume the captured compilation outputs")
    headers = {file["path"]: file for file in proof["headers"]}
    if len(headers) != len(proof["headers"]):
        raise ValueError("Duplicate consumed module header")
    consumed = set()
    consumed_sources = set()
    for name in depfiles:
        text = safe_path(root, "wayland/build/" + name).read_text().replace("\\\n", " ")
        if ":" not in text:
            raise ValueError("Malformed module dependency file")
        dependencies = shlex.split(text.split(":", 1)[1])
        if outputs[name] not in dependencies:
            raise ValueError("Actual compiler dependency file omits its compilation source")
        for dependency in dependencies:
            if "/plugins/linux-pipewire/" in dependency or "/deps/glad/" in dependency:
                source_name = next((source for source in proof["patchedSourceHashes"] if dependency.endswith("/" + source)), None)
                if not source_name:
                    raise ValueError("Compilation consumed uncaptured OBS module source: " + dependency)
                consumed_sources.add(dependency)
            else:
                if dependency not in headers:
                    raise ValueError("Compilation consumed an external header without exact identity: " + dependency)
                consumed.add(dependency)
    if consumed != set(headers):
        raise ValueError("Recorded header set differs from actual compiler dependency files")
    if not compiled.issubset(consumed_sources):
        raise ValueError("Actual compiler dependency files omit a module compilation source")
    for file in [*proof["headers"], *proof["linkerInputs"], *proof["compilerInputs"]]:
        if not re.fullmatch(r"[a-f0-9]{64}", file["sha256"]) or file["size"] <= 0 or not file["path"].startswith("/") or not all(file.get(key) for key in ["binaryPackage", "binaryVersion", "sourcePackage", "sourceVersion"]):
            raise ValueError("Actual external module input has no complete package identity")
        system_package = re.fullmatch(r"(?:libc6(?:-dev)?|linux-libc-dev|gcc-[\d]+(?:-[a-z0-9-]+)?|libgcc-[\d]+-dev|libstdc\+\+-[\d]+-dev|libgcc-s1|binutils(?:-[a-z0-9-]+)?)(?::amd64)?", file["binaryPackage"]) is not None
        if file["systemLibrary"] != system_package:
            raise ValueError("A module dependency was incorrectly exempted as an OS/compiler input: " + file["binaryPackage"])


def check_header_packages(proof, packages, deb_data, match_member):
    by_identity = {(package["binaryPackage"], package["binaryVersion"]): package for package in packages}
    archives = {}
    for header in [*proof["headers"], *proof["linkerInputs"], *proof["compilerInputs"]]:
        package = by_identity.get((header["binaryPackage"], header["binaryVersion"]))
        if not package or (package["sourcePackage"], package["sourceVersion"]) != (header["sourcePackage"], header["sourceVersion"]):
            raise ValueError("Missing exact source package for consumed header: " + header["path"])
        identity = package["binaryArchive"]["sha256"]
        if identity not in archives:
            archives[identity] = deb_data(package)
        if not match_member(archives[identity], header["path"].lstrip("/"), header["sha256"], exact=True):
            raise ValueError("Consumed module header differs from the exact official dev package: " + header["path"])


def verify_inputs(root, record, native_provenance, module_sha, module_size):
    proof_path = safe_path(root, record["proof"])
    proof = json.loads(proof_path.read_text())
    validate_identity(proof)
    if proof != native_provenance.get("waylandModule") or record["path"] != MODULE or record.get("sha256") != proof["module"]["sha256"] or record.get("size") != proof["module"]["size"] or module_sha != proof["module"]["sha256"] or module_size != proof["module"]["size"]:
        raise ValueError("Controlled module differs from its actual staged build")
    files = {file["path"]: file for file in record["files"]}
    if len(files) != len(record["files"]) or record["proof"] not in files:
        raise ValueError("Controlled module evidence has duplicate or missing references")
    for file in files.values():
        target = safe_path(root, file["path"])
        if not target.is_file() or target.stat().st_size != file["size"] or digest(target) != file["sha256"]:
            raise ValueError("Controlled module evidence changed: " + file["path"])
    source = record["archive"]
    if source not in files or files[source]["sha256"] != OBS_SHA or files[source]["size"] != OBS_SIZE:
        raise ValueError("Controlled module original archive is missing")
    for name, sha in proof["sourceHashes"].items():
        relative = "wayland/inputs/" + name
        if relative not in files or files[relative]["sha256"] != sha or native_provenance["sourceHashes"].get(name) != sha:
            raise ValueError("Controlled module input differs from helper source fingerprint: " + name)
    check_build_evidence(root, record, proof)
    replay_sources(safe_path(root, source), safe_path(root, "wayland/inputs/native/wayland/obs-pipewire-health.patch"), proof["originalSourceHashes"], proof["patchedSourceHashes"])
    return proof


def copy_inputs(project, root, native_provenance):
    proof = native_provenance.get("waylandModule")
    if proof is None:
        return []
    validate_identity(proof)
    folder = root / "wayland"
    folder.mkdir(parents=True, exist_ok=True)
    packaged_archives = sorted((root / "packages").glob("obs-studio-*/obs-studio_32.2.0.orig.tar.gz"))
    packaged_archive = next((file for file in packaged_archives if file.is_file() and file.stat().st_size == OBS_SIZE and digest(file) == OBS_SHA), None)
    archive_relative = str(packaged_archive.relative_to(root)) if packaged_archive else "wayland/obs-studio_32.2.0.orig.tar.gz"
    paths = ["wayland/provenance.json", archive_relative,
             *["wayland/inputs/" + name for name in proof["sourceHashes"]],
             *["wayland/build/" + file["path"] for file in proof["buildEvidence"]]]
    previous = folder / "provenance.json"
    if previous.is_file() and json.loads(previous.read_text()) == proof and all(safe_path(root, name).is_file() for name in paths):
        record = {"path": MODULE, "sha256": proof["module"]["sha256"], "size": proof["module"]["size"],
                  "proof": paths[0], "archive": paths[1],
                  "files": [{"path": name, "sha256": digest(safe_path(root, name)), "size": safe_path(root, name).stat().st_size} for name in paths]}
        verify_inputs(root, record, native_provenance, record["sha256"], record["size"])
        return [record]
    files = []
    def capture(source, relative, sha=None):
        target = safe_path(root, relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        if source.resolve() != target.resolve():
            shutil.copyfile(source, target)
        actual = digest(target)
        if sha and sha != actual:
            raise ValueError("Actual module build input changed: " + relative)
        files.append({"path": relative, "sha256": actual, "size": target.stat().st_size})
    proof_file = folder / "provenance.json"
    proof_file.write_text(json.dumps(proof, indent=2) + "\n")
    capture(proof_file, "wayland/provenance.json")
    originals = list((project / "work/linux-release-sources/packages").glob("obs-studio-*/obs-studio_32.2.0.orig.tar.gz"))
    originals += [project / ".cache/obs-studio_32.2.0.orig.tar.gz"]
    archive = next((file for file in originals if file.is_file() and file.stat().st_size == OBS_SIZE and digest(file) == OBS_SHA), None)
    if archive is None:
        raise ValueError("Missing matching original OBS source used to compile controlled module")
    capture(packaged_archive or archive, archive_relative, OBS_SHA)
    for name, sha in proof["sourceHashes"].items():
        capture(safe_path(project, name), "wayland/inputs/" + name, sha)
    for file in proof["buildEvidence"]:
        capture(safe_path(project / ".cache/wayland-module-build", file["path"]), "wayland/build/" + file["path"], file["sha256"])
    record = {"path": MODULE, "sha256": proof["module"]["sha256"], "size": proof["module"]["size"], "proof": paths[0], "archive": archive_relative, "files": files}
    verify_inputs(root, record, native_provenance, record["sha256"], record["size"])
    return [record]
