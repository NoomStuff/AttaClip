#!/usr/bin/env python3
"""Capture exact legacy AppImage toolset bytes, Ubuntu source sets and launcher notices."""
import argparse
import hashlib
import importlib.util
import io
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import urllib.request

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("collector", Path(__file__).with_name("collect-linux-sources.py"))
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)

toolset_sha = "d12ff7eb8f1d1ec4652ca5237a7fbdca33acc0c758045636feca62dc6ecb8ec4"
pins = {
    "appimagekit": ("AppImage/AppImageKit", "effcebc1d81c5e174a48b870cb420f490fb5fb4d"),
    "libappimage": ("AppImage/libappimage", "13f401a4a384ec59ec9a144e2a7006adf751571f"),
    "squashfuse": ("vasi/squashfuse", "1f980303b89c779eabfd0a0fdd36d6a7a311bf92"),
}
libraries = {
    "libappindicator.so.1": ("libappindicator1", "12.10.1+13.10.20130920-0ubuntu4"),
    "libgconf-2.so.4": ("libgconf-2-4", "3.2.6-0ubuntu2"),
    "libindicator.so.7": ("libindicator7", "12.10.2+14.04.20140402-0ubuntu1"),
    "libnotify.so.4": ("libnotify4", "0.7.6-1ubuntu3"),
    "libXss.so.1": ("libxss1", "1:1.2.2-1"),
    "libXtst.so.6": ("libxtst6", "2:1.2.2-1"),
}


def record(root, file):
    return {"path": str(file.relative_to(root)), "sha256": collector.digest(file), "size": file.stat().st_size}


def tar_file(file, suffix):
    with tarfile.open(file) as archive:
        found = [member for member in archive if member.isfile() and member.name.endswith("/" + suffix)]
        if len(found) != 1:
            raise ValueError("Source archive does not identify one exact file: " + suffix)
        return archive.extractfile(found[0]).read()


def collect(args):
    root, toolset = Path(args.output).resolve(), Path(args.toolset).resolve()
    root.mkdir(parents=True, exist_ok=True)
    if collector.digest(Path(args.archive)) != toolset_sha:
        raise ValueError("AppImage toolset differs from electron-builder's pinned official archive")
    manifest = {"version": 1, "toolset": {"name": "appimage-12.0.1.7z", "sha256": toolset_sha}, "packages": [], "sources": [], "licenseFiles": [], "buildInstructions": [], "blockers": []}
    previous = json.loads((root / "manifest.json").read_text()) if (root / "manifest.json").exists() else None
    archived = root / "appimage-12.0.1.7z"
    shutil.copyfile(args.archive, archived)
    manifest["toolset"].update(record(root, archived))
    runtime = toolset / "runtime-x64"
    sevenzip = find_sevenzip(args)
    for relative in ["runtime-x64", *["lib/x64/" + name for name in libraries]]:
        official = subprocess.check_output([sevenzip, "x", "-so", str(archived), relative])
        if (toolset / relative).read_bytes() != official:
            raise ValueError("Extracted AppImage tool differs from the hash-pinned archive member: " + relative)
    # Execute only the hash-pinned official launcher, in an isolated copy with no payload.
    runtime_copy = root / "runtime-x64"
    shutil.copyfile(runtime, runtime_copy)
    runtime_copy.chmod(0o755)
    version = collector.run([str(runtime_copy), "--appimage-version"]).strip()
    if version != "Version: effcebc":
        raise ValueError("Official launcher does not declare the captured AppImageKit source commit")
    manifest["runtime"] = {**record(root, runtime_copy), "version": version}
    actual_libraries = {file.name for file in (toolset / "lib/x64").iterdir() if file.is_file()}
    if actual_libraries != set(libraries):
        raise ValueError("Official toolset injects an unexpected library set")
    for filename, (owner, version) in libraries.items():
        print("Capture AppImage " + owner + "=" + version, flush=True)
        try:
            existing = next((package for package in previous["packages"] if package["binaryPackage"] == owner and package["binaryVersion"] == version), None) if previous else None
            if existing:
                validate_package(root, existing)
                if existing["file"]["sha256"] != collector.digest(toolset / "lib/x64" / filename):
                    raise ValueError("Cached source proof differs from current injected library bytes")
                manifest["packages"].append(existing)
                continue
            binary, source_record, binary_url, urls = collector.historical_inputs(root, owner, version, None)
            source, source_version = collector.source_identity(binary)
            folder = root / "packages" / owner
            folder.mkdir(parents=True, exist_ok=True)
            archive = folder / collector.archive_name(Path(binary["Filename"]).name)
            collector.download(binary_url, archive, binary["SHA256"])
            control = collector.paragraphs(collector.run(["dpkg-deb", "-f", str(archive)]))[0]
            if control["Package"] != owner or control["Version"] != version or collector.source_identity(control) != (source, source_version):
                raise ValueError("AppImage library package source identity disagrees")
            data = collector.deb_data(archive)
            actual = collector.digest(toolset / "lib/x64" / filename)
            member = collector.match_member(data, filename, actual)
            if not member:
                raise ValueError("Injected AppImage library does not match the published Ubuntu package bytes")
            archives = []
            for line in source_record["Checksums-Sha256"].splitlines():
                if not line.strip():
                    continue
                digest, size, name = line.split()
                collector.archive_name(name)
                target = folder / name
                collector.download(urls[name], target, digest)
                if target.stat().st_size != int(size):
                    raise ValueError("Wrong AppImage corresponding source archive size")
                archives.append({**record(root, target), "url": urls[name]})
            with tarfile.open(fileobj=io.BytesIO(data)) as package:
                notices = [item for item in package if item.isfile() and item.name.removeprefix("./") == "usr/share/doc/" + owner + "/copyright"]
                if len(notices) != 1:
                    raise ValueError("Exact AppImage package copyright member missing")
                copyright_file = folder / "copyright.txt"
                copyright_file.write_bytes(package.extractfile(notices[0]).read())
            manifest["packages"].append({"binaryPackage": owner, "binaryVersion": version, "sourcePackage": source, "sourceVersion": source_version,
                                        "binaryArchive": {**record(root, archive), "url": binary_url}, "sourceArchives": archives,
                                        "copyright": {**record(root, copyright_file), "debMember": notices[0].name},
                                        "file": {"path": "usr/lib/" + filename, "sha256": actual, "size": (toolset / "lib/x64" / filename).stat().st_size, "debMember": member}})
        except Exception as error:
            manifest["blockers"].append(filename + ": " + str(error))
        (root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    for name, (repository, commit) in pins.items():
        folder = root / "sources"
        folder.mkdir(exist_ok=True)
        archive = folder / (name + "-" + commit + ".tar.gz")
        url = "https://codeload.github.com/" + repository + "/tar.gz/" + commit
        if not archive.exists():
            collector.download(url, archive, None)
        manifest["sources"].append({**record(root, archive), "repository": repository, "commit": commit, "url": url})
        tree = root / "build" / (name + "-tree.json")
        git_commit = root / "build" / (name + "-commit.json")
        if not tree.exists():
            tree.parent.mkdir(parents=True, exist_ok=True)
            request = urllib.request.Request("https://api.github.com/repos/" + repository + "/git/trees/" + commit + "?recursive=1", headers={"User-Agent": "AttaClip-source-collector/1"})
            with urllib.request.urlopen(request, timeout=60) as response:
                tree.write_text(json.dumps(json.load(response), indent=2) + "\n")
        if not git_commit.exists():
            request = urllib.request.Request("https://api.github.com/repos/" + repository + "/git/commits/" + commit, headers={"User-Agent": "AttaClip-source-collector/1"})
            with urllib.request.urlopen(request, timeout=60) as response:
                git_commit.write_text(json.dumps(json.load(response), indent=2) + "\n")
        raw_commit = root / "build" / (name + "-commit.raw")
        if not raw_commit.exists():
            cache = root / "git-cache" / name
            if not cache.exists():
                subprocess.check_call(["git", "init", "--bare", str(cache)], stdout=subprocess.DEVNULL)
            subprocess.check_call(["git", "-C", str(cache), "fetch", "--depth=1", "https://github.com/" + repository + ".git", commit], stdout=subprocess.DEVNULL)
            raw_commit.write_bytes(subprocess.check_output(["git", "-C", str(cache), "cat-file", "commit", commit]))
        manifest["buildInstructions"].extend([record(root, tree), record(root, git_commit), record(root, raw_commit)])
    for name in ["appImage-packages-x64.sh", "README.md"]:
        target = root / "build" / name
        collector.download("https://raw.githubusercontent.com/electron-userland/electron-builder-binaries/57839c6516289c0412c1b0887a6718d71e1ac5c2/" + name, target, None)
        manifest["buildInstructions"].append(record(root, target))
    xz = root / "sources/xz-5.2.3.tar.gz"
    if not xz.exists():
        collector.download("https://tukaani.org/xz/xz-5.2.3.tar.gz", xz, None)
    expected_xz = "a5eb4f707cf31579d166a6f95dbac45cf7ea181036d1632b4f123a4072f502f8d57cd6e7d0588f0bf831a07b8fc4065d26589a25c399b95ddcf5f73435163da6"
    with xz.open("rb") as stream:
        if hashlib.file_digest(stream, "sha512").hexdigest() != expected_xz:
            raise ValueError("XZ source archive does not match the captured runtime build recipe")
    manifest["sources"].append({**record(root, xz), "url": "https://tukaani.org/xz/xz-5.2.3.tar.gz", "sha512": expected_xz})
    extract_notices(root, manifest)
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"packages": len(manifest["packages"]), "sources": len(manifest["sources"]), "notices": len(manifest["licenseFiles"]), "blockers": manifest["blockers"]}, indent=2))
    return 1 if manifest["blockers"] else 0


def validate_package(root, package):
    archive = collector.evidence_path(root, package["binaryArchive"]["path"])
    if collector.digest(archive) != package["binaryArchive"]["sha256"]:
        raise ValueError("AppImage official binary archive changed")
    control = collector.paragraphs(collector.run(["dpkg-deb", "-f", str(archive)]))[0]
    if control["Package"] != package["binaryPackage"] or control["Version"] != package["binaryVersion"] or collector.source_identity(control) != (package["sourcePackage"], package["sourceVersion"]):
        raise ValueError("AppImage exact binary/source identities changed")
    data = collector.deb_data(archive)
    filename = PurePosixPath(package["file"]["path"]).name
    if collector.match_member(data, filename, package["file"]["sha256"]) != package["file"]["debMember"]:
        raise ValueError("AppImage injected library has no exact official package byte proof")
    copyright = package["copyright"]
    if collector.digest(collector.evidence_path(root, copyright["path"])) != copyright["sha256"] or collector.match_member(data, "copyright", copyright["sha256"]) != copyright["debMember"]:
        raise ValueError("AppImage full package notice differs from official package")
    dsc, by_name = None, {}
    for source in package["sourceArchives"]:
        file = collector.evidence_path(root, source["path"])
        if collector.digest(file) != source["sha256"] or file.stat().st_size != source["size"]:
            raise ValueError("AppImage corresponding source input changed")
        by_name[file.name] = source
        if file.suffix == ".dsc":
            dsc = next(record for record in collector.paragraphs(file.read_text()) if "Checksums-Sha256" in record)
    if not dsc or dsc["Source"] != package["sourcePackage"] or dsc["Version"] != package["sourceVersion"]:
        raise ValueError("AppImage source .dsc no longer identifies the exact binary source package")
    for line in dsc["Checksums-Sha256"].splitlines():
        if line.strip():
            sha256, size, name = line.split()
            if name not in by_name or by_name[name]["sha256"] != sha256 or by_name[name]["size"] != int(size):
                raise ValueError("AppImage source .dsc requires a missing or changed input")
    history = root / "history" / hashlib.sha256((package["binaryPackage"] + "=" + package["binaryVersion"]).encode()).hexdigest()[:16]
    published = json.loads((history / "binary-publication.json").read_text())
    if published["binary_package_name"] != package["binaryPackage"] or published["binary_package_version"] != package["binaryVersion"] or published["source_package_name"] != package["sourcePackage"] or published["source_package_version"] != package["sourceVersion"]:
        raise ValueError("AppImage binary/source identity disagrees with its official publication")


def check(args):
    root = Path(args.output).resolve()
    manifest = json.loads((root / "manifest.json").read_text())
    if manifest["blockers"]:
        raise ValueError("AppImage source collection has blockers")
    archive = collector.evidence_path(root, manifest["toolset"]["path"])
    if collector.digest(archive) != toolset_sha:
        raise ValueError("AppImage supplier archive changed")
    sevenzip = find_sevenzip(args)
    runtime = collector.evidence_path(root, manifest["runtime"]["path"])
    if collector.digest(runtime) != manifest["runtime"]["sha256"] or runtime.read_bytes() != subprocess.check_output([sevenzip, "x", "-so", str(archive), "runtime-x64"]):
        raise ValueError("AppImage runtime differs from the official supplier archive")
    if {package["file"]["path"] for package in manifest["packages"]} != {"usr/lib/" + name for name in libraries}:
        raise ValueError("AppImage source evidence misses an injected library")
    for package in manifest["packages"]:
        validate_package(root, package)
        filename = PurePosixPath(package["file"]["path"]).name
        if (package["binaryPackage"], package["binaryVersion"]) != libraries[filename]:
            raise ValueError("AppImage source package version differs from the pinned toolset's actual inputs")
        official = subprocess.check_output([sevenzip, "x", "-so", str(archive), "lib/x64/" + filename])
        if hashlib.sha256(official).hexdigest() != package["file"]["sha256"] or len(official) != package["file"]["size"]:
            raise ValueError("AppImage injected library differs from exact toolset bytes")
    captured = {source["repository"]: source for source in manifest["sources"] if "repository" in source}
    for _, (repository, commit) in pins.items():
        if repository not in captured or captured[repository]["commit"] != commit:
            raise ValueError("AppImage launcher source does not cover its declared commit and dependency pins")
    for name, (repository, commit) in pins.items():
        verify_git_archive(collector.evidence_path(root, captured[repository]["path"]), root / "build" / (name + "-tree.json"), root / "build" / (name + "-commit.raw"), commit)
    for record in manifest["sources"] + manifest["licenseFiles"] + manifest["buildInstructions"]:
        file = collector.evidence_path(root, record["path"])
        if collector.digest(file) != record["sha256"] or file.stat().st_size != record["size"]:
            raise ValueError("AppImage source, build recipe or full notice changed")
    appimagekit = collector.evidence_path(root, captured["AppImage/AppImageKit"]["path"])
    gitlink = tar_file(appimagekit, ".gitmodules")
    if b"lib/libappimage" not in gitlink:
        raise ValueError("AppImageKit source misses its runtime dependency layout")
    tree = json.loads((root / "build/appimagekit-tree.json").read_text())
    if next(item["sha"] for item in tree["tree"] if item["path"] == "lib/libappimage") != pins["libappimage"][1]:
        raise ValueError("AppImageKit immutable tree pins a different runtime source submodule")
    libappimage = collector.evidence_path(root, captured["AppImage/libappimage"]["path"])
    recipe = tar_file(libappimage, "cmake/dependencies.cmake")
    if b"GIT_TAG 1f98030" not in recipe or b"xz-5.2.3.tar.gz" not in recipe:
        raise ValueError("Actual AppImage runtime recipe has different embedded dependencies")
    xz = next(source for source in manifest["sources"] if source["path"].endswith("xz-5.2.3.tar.gz"))
    with collector.evidence_path(root, xz["path"]).open("rb") as stream:
        if hashlib.file_digest(stream, "sha512").hexdigest().encode() not in recipe:
            raise ValueError("AppImage embedded XZ source differs from the recipe's pinned archive")
    print(json.dumps({"packages": len(manifest["packages"]), "sources": len(manifest["sources"]), "notices": len(manifest["licenseFiles"]), "blockers": []}))
    return 0


def verify_git_archive(archive_file, tree_file, commit_file, expected_commit):
    tree = json.loads(tree_file.read_text())
    commit = commit_file.read_bytes()
    commit_digest = hashlib.sha1(b"commit " + str(len(commit)).encode() + b"\0" + commit).hexdigest()
    if tree.get("truncated") or commit_digest != expected_commit:
        raise ValueError("Captured immutable Git commit/tree identity disagrees")
    root_tree = commit.splitlines()[0].decode().removeprefix("tree ")
    directories = {"": root_tree, **{item["path"]: item["sha"] for item in tree["tree"] if item["type"] == "tree"}}
    for directory, expected in directories.items():
        children = [item for item in tree["tree"] if ("" if PurePosixPath(item["path"]).parent == PurePosixPath(".") else str(PurePosixPath(item["path"]).parent)) == directory]
        children.sort(key=lambda item: (PurePosixPath(item["path"]).name + ("/" if item["type"] == "tree" else "")).encode())
        raw_tree = b"".join(item["mode"].lstrip("0").encode() + b" " + PurePosixPath(item["path"]).name.encode() + b"\0" + bytes.fromhex(item["sha"]) for item in children)
        actual = hashlib.sha1(b"tree " + str(len(raw_tree)).encode() + b"\0" + raw_tree).hexdigest()
        if actual != expected:
            raise ValueError("Captured Git tree contents differ from the immutable commit")
    expected = {item["path"]: item["sha"] for item in tree["tree"] if item["type"] == "blob"}
    actual = {}
    with tarfile.open(archive_file) as archive:
        for member in archive:
            if member.isdir():
                continue
            parts = member.name.split("/", 1)
            if len(parts) != 2:
                raise ValueError("Unexpected source archive prefix")
            name = parts[1]
            if member.isfile():
                data = archive.extractfile(member).read()
            elif member.issym():
                data = member.linkname.encode()
            else:
                raise ValueError("Unsupported linked Git archive member")
            if name in actual:
                raise ValueError("Duplicate Git source archive member")
            actual[name] = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
    if actual != expected:
        raise ValueError("Source archive bytes do not match the exact immutable Git tree")


def extract_notices(root, manifest):
    destination = root / "notices"
    destination.mkdir(exist_ok=True)
    archives = manifest["sources"] + [file for package in manifest["packages"] for file in package["sourceArchives"]]
    for source in archives:
        file = collector.evidence_path(root, source["path"])
        if not tarfile.is_tarfile(file):
            continue
        with tarfile.open(file) as archive:
            for member in archive:
                name = PurePosixPath(member.name).name
                special = any(member.name.endswith("/" + suffix) for suffix in ["src/runtime.c", "src/notify.c", "src/libappimage_hashlib/md5.c", "src/libappimage_shared/light_elf.h", "src/libappimage_shared/light_byteswap.h"])
                if member.isfile() and (re.fullmatch(r"(?:COPYING|LICEN[CS]E|NOTICE|COPYRIGHT)(?:[._-].*)?", name, re.I) or member.name.removeprefix("./") == "debian/copyright" or special):
                    data = archive.extractfile(member).read()
                    target = destination / (hashlib.sha256(data).hexdigest() + ".txt")
                    target.write_bytes(data)
                    manifest["licenseFiles"].append({**record(root, target), "origin": source["path"], "member": member.name})
    for package in manifest["packages"]:
        manifest["licenseFiles"].append(package["copyright"])
    for name in ["GPL-2", "LGPL-2.1"]:
        target = destination / (name + ".txt")
        shutil.copyfile("/usr/share/common-licenses/" + name, target)
        manifest["licenseFiles"].append(record(root, target))


def find_sevenzip(args):
    if args.sevenzip:
        return args.sevenzip
    installed = shutil.which("7zz") or shutil.which("7z") or shutil.which("7za")
    if installed:
        return installed
    cached = sorted((Path.home() / ".cache/electron-builder/7zip@1.0.0").glob("*/bin/7zz"))
    if len(cached) != 1:
        raise ValueError("Pass --sevenzip with the approved local 7-Zip extractor")
    return str(cached[0])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--toolset")
    parser.add_argument("--archive")
    parser.add_argument("--sevenzip")
    parser.add_argument("--check", action="store_true")
    arguments = parser.parse_args()
    if not arguments.check and (not arguments.toolset or not arguments.archive):
        parser.error("--toolset and --archive are required for collection")
    raise SystemExit(check(arguments) if arguments.check else collect(arguments))
