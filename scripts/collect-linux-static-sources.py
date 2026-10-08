#!/usr/bin/env python3
"""Capture exact static/header source packages from an actual Ubuntu build-info file."""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import sys

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location("collector", Path(__file__).with_name("collect-linux-sources.py"))
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


def collect(args):
    root = Path(args.output).resolve()
    info = Path(args.buildinfo).resolve()
    if not info.is_relative_to(root):
        raise ValueError("Build-info must remain inside source packet")
    record = next(record for record in collector.paragraphs(info.read_text()) if "Installed-Build-Depends" in record)
    dependencies = re.findall(r"(?:^|[\n,])\s*([^\s,(]+)\s*\(= ([^)]+)\)", record["Installed-Build-Depends"])
    selected = [(name, version) for name, version in dependencies if re.fullmatch(args.packages, name)]
    if not selected:
        raise ValueError("No requested exact dependencies in actual build-info")
    destination = root / "static" / info.parent.name
    destination.mkdir(parents=True, exist_ok=True)
    manifest = {"buildinfo": {"path": str(info.relative_to(root)), "sha256": collector.digest(info), "sourcePackage": record["Source"], "sourceVersion": record["Version"]}, "selection": args.packages, "packages": [], "blockers": []}
    for owner, version in selected:
        print(f"Static source {owner}={version}", flush=True)
        try:
            binary, source_record, _, urls = collector.historical_inputs(root, owner, version)
            source, source_version = collector.source_identity(binary)
            folder = destination / re.sub(r"[^a-zA-Z0-9._-]", "_", owner)
            folder.mkdir(parents=True, exist_ok=True)
            archives = []
            for line in source_record["Checksums-Sha256"].splitlines():
                if not line.strip():
                    continue
                sha256, size, name = line.split()
                collector.archive_name(name)
                collector.download(urls[name], folder / name, sha256)
                if (folder / name).stat().st_size != int(size):
                    raise ValueError("Source archive size mismatch")
                archives.append({"path": str((folder / name).relative_to(root)), "sha256": sha256, "size": int(size), "url": urls[name]})
            manifest["packages"].append({"binaryPackage": owner, "binaryVersion": version, "sourcePackage": source, "sourceVersion": source_version, "sourceArchives": archives})
        except Exception as error:
            manifest["blockers"].append(f"{owner}={version}: {error}")
        (destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Captured {len(manifest['packages'])} exact static/header package sources, {len(manifest['blockers'])} blockers")
    return 1 if manifest["blockers"] else 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--buildinfo", required=True)
    parser.add_argument("--packages", required=True, help="Full-match regex selecting actual installed build dependencies")
    raise SystemExit(collect(parser.parse_args()))
