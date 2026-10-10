#!/usr/bin/env python3
"""Validate and extract an application ZIP without following archive-controlled links."""
import argparse
import posixpath
from pathlib import Path
import stat
import zipfile


def member_name(name):
    name = name.rstrip("/")
    if not name or name.startswith("/") or "\\" in name or ":" in name or any(part in ("", ".", "..") for part in name.split("/")):
        raise ValueError("Unsafe Mac ZIP member: " + name)
    return name


def inspect(packet, app_name):
    records = {}
    folded = set()
    for member in packet.infolist():
        name = member_name(member.filename)
        if name.split("/")[0] != app_name or name.casefold() in folded:
            raise ValueError("Unexpected or duplicate Mac ZIP member: " + name)
        folded.add(name.casefold())
        mode = member.external_attr >> 16
        kind = "directory" if member.is_dir() else "link" if stat.S_ISLNK(mode) else "file"
        if stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR, stat.S_IFLNK):
            raise ValueError("Special Mac ZIP member: " + name)
        target = None
        if kind == "link":
            target = packet.read(member).decode("utf-8", errors="strict")
            if not target or target.startswith("/") or "\\" in target or ":" in target or "\x00" in target:
                raise ValueError("Unsafe Mac ZIP link: " + name)
            resolved = posixpath.normpath(posixpath.join(posixpath.dirname(name), target))
            if not resolved.startswith(app_name + "/"):
                raise ValueError("Mac ZIP link escapes application: " + name)
        records[name] = (member, kind, target)
    if not records:
        raise ValueError("Empty Mac package")
    for name, (_, _, _) in records.items():
        ancestor = posixpath.dirname(name)
        while ancestor:
            if ancestor in records and records[ancestor][1] != "directory":
                raise ValueError("Mac ZIP writes through a file or link: " + name)
            ancestor = posixpath.dirname(ancestor)
    # Follow link identities as data before creating any link. Framework links
    # can target a directory without an explicit ZIP directory entry.
    def resolve(name, visiting):
        parts = name.split("/")
        for length in range(1, len(parts) + 1):
            prefix = "/".join(parts[:length])
            record = records.get(prefix)
            if record and record[1] == "link":
                if prefix in visiting:
                    raise ValueError("Cyclic Mac ZIP link: " + prefix)
                replacement = posixpath.normpath(posixpath.join(posixpath.dirname(prefix), record[2]))
                suffix = "/".join(parts[length:])
                return resolve(posixpath.join(replacement, suffix) if suffix else replacement, visiting | {prefix})
        if name not in records and not any(other.startswith(name + "/") for other in records):
            raise ValueError("Dangling Mac ZIP link: " + name)
        return name
    for name, (_, kind, _) in records.items():
        if kind == "link":
            resolve(name, set())
    return records


def extract(archive, destination, app_name="AttaClip.app"):
    root = Path(destination).resolve()
    if root.exists() and any(root.iterdir()):
        raise ValueError("Extract into an empty directory")
    with zipfile.ZipFile(archive) as packet:
        records = inspect(packet, app_name)
        root.mkdir(parents=True, exist_ok=True)
        for name, (member, kind, _) in sorted(records.items()):
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            if kind == "directory":
                target.mkdir(exist_ok=True)
            elif kind == "file":
                with packet.open(member) as source, target.open("xb") as output:
                    while data := source.read(1024 * 1024):
                        output.write(data)
                target.chmod((member.external_attr >> 16) & 0o777 or 0o644)
        for name, (_, kind, target) in sorted(records.items()):
            if kind == "link":
                (root / name).symlink_to(target)
        return len(records)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True)
    parser.add_argument("--destination", required=True)
    args = parser.parse_args()
    print(extract(args.archive, args.destination))
