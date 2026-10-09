#!/usr/bin/env python3
"""Restore the four controlled Linux CLI inputs from a captured source packet."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil


def prepare(packet, project):
    build = json.loads((packet / "controlled-cli/build/build-manifest.json").read_text())
    if build["producer"] != "attaclip-controlled-linux" or build["target"] != "linux-x64" or len(build["sourceArchives"]) != 4:
        raise ValueError("Unexpected controlled Linux source recipe")
    root = project / "work/release-sources"
    if (root / "manifest.json").exists():
        raise ValueError("Input manifest already exists. Do not overwrite another platform's packet")
    origins = ["https://github.com/FFmpeg/FFmpeg", "https://code.videolan.org/videolan/x264.git", "https://code.videolan.org/videolan/dav1d.git", "https://github.com/madler/zlib.git"]
    sources = []
    dependencies = []
    for index, record in enumerate(build["sourceArchives"]):
        relative = record["path"]
        source = (packet / "controlled-cli/sources" / relative).resolve()
        target = (root / relative).resolve()
        if not source.is_relative_to((packet / "controlled-cli/sources").resolve()) or not target.is_relative_to(root.resolve()):
            raise ValueError("Source recipe path escapes its input folder")
        with source.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        if digest != record["sha256"] or source.stat().st_size != record["size"]:
            raise ValueError("Controlled source input changed")
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists() and target.read_bytes() != source.read_bytes():
            raise ValueError("An existing input has different bytes")
        shutil.copyfile(source, target)
        if index == 0:
            sources.append({**record, "repository": "FFmpeg/FFmpeg", "commit": build["sourceCommits"]["ffmpeg"]})
        else:
            name = ["ffmpeg", "x264", "dav1d", "zlib"][index]
            dependencies.append({**record, "origin": origins[index], "resolvedRevision": build["sourceCommits"][name]})
    (root / "manifest.json").write_text(json.dumps({"sources": sources, "dependencySources": dependencies}, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("packet")
    parser.add_argument("project")
    args = parser.parse_args()
    prepare(Path(args.packet).resolve(), Path(args.project).resolve())
