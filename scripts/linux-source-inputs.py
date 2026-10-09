#!/usr/bin/env python3
"""Verify Linux static source inputs and assemble full runtime notice texts."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path, PurePosixPath
import re
import sys
import tarfile

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("collector", Path(__file__).with_name("collect-linux-sources.py"))
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)

# These are static/header inputs observed in the actual recorded build recipes.
# Rust dev packages include test/build crates too, so capture the actual installed overset.
required = {
    "632ad7f2a509a602": r"glslang-dev|spirv-tools|libvulkan-dev|libffmpeg-nvenc-dev",
    "beb65370f8304c33": r"librust-.*-dev|libstd-rust-1\.75",
    "28192c144f62bba7": r"libsimde-dev|nlohmann-json3-dev|uthash-dev|libffmpeg-nvenc-dev",
    "128ce72410800d15": r"spirv-headers",
    "4c59bf38c52e3679": r"libstd-rust-1\.75",
}


def verify_static(root):
    archives = {}
    records = []
    for identifier, pattern in required.items():
        file = root / "static" / identifier / "manifest.json"
        manifest = json.loads(file.read_text())
        if manifest["blockers"]:
            raise ValueError(f"Static input collection failed: {manifest['blockers']}")
        buildinfo = collector.evidence_path(root, manifest["buildinfo"]["path"])
        if collector.digest(buildinfo) != manifest["buildinfo"]["sha256"]:
            raise ValueError("Static input build-info changed")
        record = next(record for record in collector.paragraphs(buildinfo.read_text()) if "Installed-Build-Depends" in record)
        expected = {(name, version) for name, version in re.findall(r"(?:^|[\n,])\s*([^\s,(]+)\s*\(= ([^)]+)\)", record["Installed-Build-Depends"]) if re.fullmatch(pattern, name)}
        captured = {(package["binaryPackage"], package["binaryVersion"]) for package in manifest["packages"]}
        if not expected or expected != captured or len(captured) != len(manifest["packages"]):
            raise ValueError(f"Static source evidence does not cover the exact actual build inputs: {identifier}")
        for package in manifest["packages"]:
            publication_folder = root / "history" / hashlib.sha256((package["binaryPackage"] + "=" + package["binaryVersion"]).encode()).hexdigest()[:16]
            publication = json.loads((publication_folder / "binary-publication.json").read_text())
            build = json.loads((publication_folder / "build.json").read_text())
            if publication["binary_package_name"] != package["binaryPackage"].split(":", 1)[0] or publication["binary_package_version"] != package["binaryVersion"] or publication["source_package_name"] != package["sourcePackage"] or publication["source_package_version"] != package["sourceVersion"]:
                raise ValueError("Static package source identity differs from actual official publication")
            if build["source_package_name"] != package["sourcePackage"] or build["source_package_version"] != package["sourceVersion"] or publication["build_link"] != build["self_link"]:
                raise ValueError("Static publication/build identity disagrees")
            dsc = None
            by_name = {}
            for source in package["sourceArchives"]:
                archive = collector.evidence_path(root, source["path"])
                if collector.digest(archive) != source["sha256"] or archive.stat().st_size != source["size"]:
                    raise ValueError(f"Static source archive changed: {source['path']}")
                by_name[archive.name] = source
                archives[source["sha256"]] = source
                if archive.suffix == ".dsc":
                    dsc = next(record for record in collector.paragraphs(archive.read_text()) if "Checksums-Sha256" in record)
            if not dsc or dsc["Source"] != package["sourcePackage"] or dsc["Version"] != package["sourceVersion"]:
                raise ValueError("Static source identity differs from exact published source package")
            for line in dsc["Checksums-Sha256"].splitlines():
                if line.strip():
                    sha256, size, name = line.split()
                    if name not in by_name or by_name[name]["sha256"] != sha256 or by_name[name]["size"] != int(size):
                        raise ValueError("Static source .dsc requires an absent or changed archive")
        records.append({"path": str(file.relative_to(root)), "sha256": collector.digest(file), "packages": len(captured), "buildinfo": manifest["buildinfo"]})
    return records, archives


def write_notices(root, destination, static_archives):
    manifest = json.loads((root / "manifest.json").read_text())
    destination.mkdir(parents=True, exist_ok=True)
    references = []
    def save(data, origin, member):
        digest = hashlib.sha256(data).hexdigest()
        file = destination / "texts" / (digest + ".txt")
        file.parent.mkdir(exist_ok=True)
        if file.exists() and collector.digest(file) != digest:
            raise ValueError("Runtime notice collision")
        file.write_bytes(data)
        references.append({"origin": origin, "member": member, "path": str(file.relative_to(destination)), "sha256": digest, "size": len(data)})
    archives = dict(static_archives)
    for package in manifest["packages"]:
        notice = package["copyright"]
        file = collector.evidence_path(root, notice["path"])
        if collector.digest(file) != notice["sha256"]:
            raise ValueError("Package copyright changed")
        save(file.read_bytes(), package["binaryPackage"] + "=" + package["binaryVersion"], "copyright")
        for source in package["sourceArchives"]:
            archives[source["sha256"]] = source
    for notice in manifest["commonLicenses"]:
        file = collector.evidence_path(root, notice["path"])
        if collector.digest(file) != notice["sha256"]:
            raise ValueError("Common license changed")
        save(file.read_bytes(), notice["package"], notice["debMember"])
    for source in archives.values():
        file = collector.evidence_path(root, source["path"])
        if not tarfile.is_tarfile(file):
            continue
        if collector.digest(file) != source["sha256"]:
            raise ValueError("Source archive changed before license extraction")
        with tarfile.open(file) as archive:
            for member in archive:
                name = PurePosixPath(member.name).name
                if member.isfile() and (re.fullmatch(r"(?:COPYING|LICEN[CS]E|NOTICE|COPYRIGHT)(?:[._-].*)?", name, re.I) or member.name.removeprefix("./") == "debian/copyright"):
                    if member.size > 16 * 1024 * 1024:
                        raise ValueError("Unexpected oversized source notice")
                    save(archive.extractfile(member).read(), source["path"], member.name)
    result = {"version": 1, "licenses": references, "uniqueTexts": len({reference["sha256"] for reference in references})}
    (destination / "manifest.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sources", required=True)
    parser.add_argument("--notices")
    parser.add_argument("--no-write", action="store_true", help="Validate an archived packet without changing its evidence")
    args = parser.parse_args()
    root = Path(args.sources).resolve()
    records, archives = verify_static(root)
    report = {"version": 1, "staticInputs": records, "packages": sum(record["packages"] for record in records), "uniqueArchives": len(archives)}
    if args.notices:
        result = write_notices(root, Path(args.notices).resolve(), archives)
        report["notices"] = {"references": len(result["licenses"]), "uniqueTexts": result["uniqueTexts"]}
    if not args.no_write:
        (root / "static-input-verification.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
