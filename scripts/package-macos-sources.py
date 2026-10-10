#!/usr/bin/env python3
"""Package or verify the exact referenced Mac source packet, without loading archives as code."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import stat
import zipfile


def safe_name(name):
    parts = name.split("/")
    if not name or "\\" in name or ":" in name or name.startswith("/") or any(part in (".", "..", "") for part in parts):
        raise ValueError("Unsafe source ZIP member: " + name)
    return name


def verify(archive, destination=None):
    with zipfile.ZipFile(archive) as packet:
        seen = set()
        for member in packet.infolist():
            name = safe_name(member.filename)
            if name in seen or member.is_dir() or stat.S_ISLNK(member.external_attr >> 16):
                raise ValueError("Duplicate or linked source ZIP member: " + name)
            seen.add(name)
        kit = json.loads(packet.read("macos-kit.json"))
        expected = {file["path"]: file for file in kit["files"]}
        if len(expected) != len(kit["files"]) or seen != set(expected) | {"macos-kit.json", "README.txt"}:
            raise ValueError("Source ZIP does not contain exactly its referenced evidence")
        for name, record in expected.items():
            safe_name(name)
            with packet.open(name) as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            if digest != record["sha256"] or packet.getinfo(name).file_size != record["size"]:
                raise ValueError("Source ZIP member changed: " + name)
        if destination:
            root = Path(destination).resolve()
            if root.exists() and any(root.iterdir()):
                raise ValueError("Extract source packet into a new empty directory")
            root.mkdir(parents=True, exist_ok=True)
            # Names were checked above. Never use archive.extractall on unvalidated entries.
            for name in sorted(seen):
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                with packet.open(name) as source, target.open("xb") as output:
                    while data := source.read(1024 * 1024):
                        output.write(data)
        return kit


def package(root, archive):
    kit = json.loads((root / "macos-kit.json").read_text())
    files = [file["path"] for file in kit["files"]] + ["macos-kit.json", "README.txt"]
    if len(set(files)) != len(files):
        raise ValueError("Duplicate packet file paths")
    with zipfile.ZipFile(archive, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as packet:
        for name in sorted(files):
            safe_name(name)
            source = (root / name).resolve()
            if not source.is_relative_to(root.resolve()) or not source.is_file() or (root / name).is_symlink():
                raise ValueError("Source input is a link or escapes its directory")
            # Most source and package archives already compress their data.
            compressed = source.suffix in (".xz", ".gz", ".bz2", ".deb", ".zip")
            packet.write(source, name, compress_type=zipfile.ZIP_STORED if compressed else zipfile.ZIP_DEFLATED)
    verify(archive)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory")
    parser.add_argument("--archive", required=True)
    parser.add_argument("--verify", action="store_true")
    parser.add_argument("--extract")
    args = parser.parse_args()
    if args.verify:
        kit = verify(args.archive, args.extract)
        print(json.dumps({"files": len(kit["files"]), "appCommit": kit["appCommit"]}))
    else:
        if not args.directory:
            parser.error("--directory is required for packaging")
        package(Path(args.directory).resolve(), args.archive)
