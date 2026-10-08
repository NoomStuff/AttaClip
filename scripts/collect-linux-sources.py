#!/usr/bin/env python3
"""Capture exact apt binary/source inputs without changing system apt or executing recipes."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import urllib.request
import urllib.parse


def run(args):
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT)


def digest(file):
    with open(file, "rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def paragraphs(text):
    records = []
    for paragraph in re.split(r"\n\s*\n", text):
        record, key = {}, None
        for line in paragraph.splitlines():
            if line.startswith((" ", "\t")) and key:
                record[key] += "\n" + line[1:]
            elif ": " in line:
                key, value = line.split(": ", 1)
                record[key] = value
            elif line.endswith(":"):
                key = line[:-1]
                record[key] = ""
        if record:
            records.append(record)
    return records


def source_identity(record):
    value = record.get("Source", record["Package"])
    match = re.fullmatch(r"([^ ]+)(?: \(([^)]+)\))?", value)
    if not match:
        raise ValueError(f"Invalid Debian Source field {value!r}")
    return match[1], match[2] or record["Version"]


def download(url, target, expected):
    if target.exists() and expected and digest(target) == expected:
        return
    temporary = target.with_name(target.name + ".pending")
    target.parent.mkdir(parents=True, exist_ok=True)
    # Keep apt's authoritative path and digest, while avoiding plaintext transport.
    url = url.replace("http://archive.ubuntu.com/", "https://archive.ubuntu.com/").replace("http://security.ubuntu.com/", "https://security.ubuntu.com/")
    request = urllib.request.Request(url, headers={"User-Agent": "AttaClip-source-collector/1"})
    with urllib.request.urlopen(request, timeout=120) as response, open(temporary, "wb") as stream:
        shutil.copyfileobj(response, stream)
    if expected and digest(temporary) != expected:
        temporary.unlink()
        raise ValueError(f"Checksum mismatch for {url}")
    temporary.replace(target)


def archive_name(name):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._+~%-]*", name) or name in {".", ".."}:
        raise ValueError(f"Unsafe package archive name: {name}")
    return name


def official_json(url):
    if not url.startswith("https://api.launchpad.net/1.0/"):
        raise ValueError("Unexpected Launchpad API origin")
    with urllib.request.urlopen(url, timeout=60) as response:
        return json.load(response)


def published_binary(owner, version):
    archive = "https://api.launchpad.net/1.0/~obsproject/+archive/ubuntu/obs-studio" if owner.split(":", 1)[0] == "obs-studio" else "https://api.launchpad.net/1.0/ubuntu/+archive/primary"
    name = owner.split(":", 1)[0]
    url = archive + "?" + urllib.parse.urlencode({"ws.op": "getPublishedBinaries", "binary_name": name, "version": version, "exact_match": "true"})
    while url:
        collection = official_json(url)
        for record in collection["entries"]:
            if record["binary_package_name"] == name and record["binary_package_version"] == version and record["distro_arch_series_link"].endswith("/noble/amd64"):
                return record
        url = collection.get("next_collection_link")
    raise ValueError(f"No official Noble amd64 publication for {owner}={version}")


def historical_inputs(root, owner, version):
    publication = published_binary(owner, version)
    source, source_version = publication["source_package_name"], publication["source_package_version"]
    folder = root / "history" / hashlib.sha256(f"{owner}={version}".encode()).hexdigest()[:16]
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "binary-publication.json").write_text(json.dumps(publication, indent=2) + "\n")
    build = official_json(publication["build_link"])
    if build["source_package_name"] != source or build["source_package_version"] != source_version or build["arch_tag"] != "amd64":
        raise ValueError("Official build identity disagrees with package publication")
    (folder / "build.json").write_text(json.dumps(build, indent=2) + "\n")
    download(build["changesfile_url"], folder / "binary.changes", None)
    changes = next(record for record in paragraphs((folder / "binary.changes").read_text()) if "Checksums-Sha256" in record)
    binary_name = owner.split(":", 1)[0]
    binary_files = [line.split() for line in changes["Checksums-Sha256"].splitlines() if line.strip() and line.split()[-1].startswith(binary_name + "_") and re.search(r"_(?:amd64|all)\.deb$", line.split()[-1])]
    if len(binary_files) != 1:
        raise ValueError("Official build changes do not identify one exact binary archive")
    binary_sha, _, binary_file = binary_files[0]
    binary_url = build["changesfile_url"].rsplit("/", 1)[0] + "/" + binary_file
    source_collection = official_json(publication["archive_link"] + "?" + urllib.parse.urlencode({"ws.op": "getPublishedSources", "source_name": source, "version": source_version, "exact_match": "true"}))
    source_publication = next(record for record in source_collection["entries"] if record["source_package_name"] == source and record["source_package_version"] == source_version and record["distro_series_link"].endswith("/noble"))
    (folder / "source-publication.json").write_text(json.dumps(source_publication, indent=2) + "\n")
    urls_list = official_json(source_publication["self_link"] + "?ws.op=sourceFileUrls")
    urls = {urllib.parse.unquote(url.rsplit("/", 1)[1]): url for url in urls_list}
    dsc_url = next(url for url in urls_list if url.endswith(".dsc"))
    dsc_file = folder / archive_name(urllib.parse.unquote(dsc_url.rsplit("/", 1)[1]))
    download(dsc_url, dsc_file, None)
    source_record = next(record for record in paragraphs(dsc_file.read_text()) if "Checksums-Sha256" in record)
    if source_record["Source"] != source or source_record["Version"] != source_version:
        raise ValueError("Official source .dsc identifies a different source version")
    source_record["Checksums-Sha256"] += f"\n{digest(dsc_file)} {dsc_file.stat().st_size} {dsc_file.name}"
    if build.get("buildinfo_url"):
        download(build["buildinfo_url"], folder / "binary.buildinfo", None)
    binary = {"Package": binary_name, "Version": version, "Source": f"{source} ({source_version})", "Filename": binary_file, "SHA256": binary_sha}
    return binary, source_record, binary_url, urls


def deb_data(archive):
    # dpkg-deb decompresses data only. No package script runs, and no path is extracted.
    return subprocess.check_output(["dpkg-deb", "--fsys-tarfile", str(archive)])


def match_member(data, filename, expected):
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        members = {member.name.removeprefix("./"): member for member in archive.getmembers()}
        for name, member in members.items():
            if Path(name).name != filename:
                continue
            seen = set()
            while member.issym() or member.islnk():
                if member.name in seen:
                    raise ValueError("Circular package symlink")
                seen.add(member.name)
                link = member.linkname
                key = os.path.normpath(str(Path(member.name).parent / link)) if member.issym() and not link.startswith("/") else link.lstrip("/")
                member = members.get(key.removeprefix("./"))
                if not member:
                    break
            if member and member.isfile():
                stream = archive.extractfile(member)
                if hashlib.file_digest(stream, "sha256").hexdigest() == expected:
                    return member.name
    return None


def evidence_path(root, relative):
    candidate = (root / relative).resolve()
    if not candidate.is_relative_to(root.resolve()) or candidate == root.resolve():
        raise ValueError(f"Evidence path escapes source directory: {relative}")
    return candidate


def check(args):
    root, stage = Path(args.output).resolve(), Path(args.stage).resolve()
    manifest = json.loads((root / "manifest.json").read_text())
    blockers = list(manifest["blockers"])
    if digest(stage / "provenance.json") != manifest["provenanceSha256"]:
        blockers.append("Recorder provenance changed after source collection")
    proven = {}
    notices = {}
    for package in manifest["packages"]:
        try:
            archive = evidence_path(root, package["binaryArchive"]["path"])
            if digest(archive) != package["binaryArchive"]["sha256"]:
                raise ValueError("Binary archive hash changed")
            control = paragraphs(run(["dpkg-deb", "-f", str(archive)]))[0]
            if control["Package"] != package["binaryPackage"].split(":", 1)[0] or control["Version"] != package["binaryVersion"] or source_identity(control) != (package["sourcePackage"], package["sourceVersion"]):
                raise ValueError("Official package source identity changed")
            data = deb_data(archive)
            for file in package["files"]:
                if digest(evidence_path(stage, file["path"])) != file["sha256"] or not match_member(data, Path(file["path"]).name, file["sha256"]):
                    raise ValueError(f"Staged ELF no longer matches official package: {file['path']}")
                if file["path"] in proven:
                    raise ValueError("Duplicate staged ELF evidence")
                proven[file["path"]] = file["sha256"]
            dsc = None
            for source in package["sourceArchives"]:
                file = evidence_path(root, source["path"])
                if digest(file) != source["sha256"] or file.stat().st_size != source["size"]:
                    raise ValueError("Corresponding source archive changed")
                if file.suffix == ".dsc":
                    dsc = next(record for record in paragraphs(file.read_text()) if "Checksums-Sha256" in record)
            if not dsc or dsc["Source"] != package["sourcePackage"] or dsc["Version"] != package["sourceVersion"]:
                raise ValueError("Source .dsc does not identify the binary's exact source package")
            sources_by_name = {Path(source["path"]).name: source for source in package["sourceArchives"]}
            for line in dsc["Checksums-Sha256"].splitlines():
                if not line.strip():
                    continue
                sha256, size, name = line.split()
                if name not in sources_by_name or sources_by_name[name]["sha256"] != sha256 or sources_by_name[name]["size"] != int(size):
                    raise ValueError("Missing or changed source archive required by .dsc")
            notice = package["copyright"]
            if digest(evidence_path(root, notice["path"])) != notice["sha256"]:
                raise ValueError("Copyright text changed")
            if match_member(data, "copyright", notice["sha256"]):
                notices[package["binaryPackage"]] = notice["sha256"]
        except Exception as error:
            blockers.append(f"{package['binaryPackage']}: {error}")
    for package in manifest["packages"]:
        notice = package["copyright"]
        if notices.get(notice.get("package", package["binaryPackage"])) != notice["sha256"]:
            blockers.append(f"Copyright lacks official package byte proof for {package['binaryPackage']}")
    for file in stage.rglob("*"):
        if file.is_file() and file.name != "attaclip-recorder" and file.open("rb").read(4) == b"\x7fELF" and str(file.relative_to(stage)) not in proven:
            blockers.append(f"Staged ELF has no exact package/source evidence: {file.relative_to(stage)}")
    print(json.dumps({"packages": len(manifest["packages"]), "elfFiles": len(proven), "blockers": blockers, "staticDependencyReview": manifest.get("staticDependencyReview", "pending")}, indent=2))
    # This checks collected source inputs, not application packaging or static dependency closure.
    return 1 if blockers else 0


def collect(args):
    root = Path(args.output).resolve()
    stage = Path(args.stage).resolve()
    root.mkdir(parents=True, exist_ok=True)
    apt = root / "apt"
    (apt / "lists/partial").mkdir(parents=True, exist_ok=True)
    (apt / "archives/partial").mkdir(parents=True, exist_ok=True)
    sources = "\n\n".join(file.read_text().replace("Types: deb\n", "Types: deb deb-src\n") for file in sorted(Path("/etc/apt/sources.list.d").glob("*.sources")))
    if "deb-src" not in sources:
        raise ValueError("No deb822 apt repository sources available")
    (apt / "repositories.sources").write_text(sources)
    options = [f"-oDir::State::lists={apt / 'lists'}", f"-oDir::Cache={apt}", f"-oDir::Cache::archives={apt / 'archives'}", f"-oDir::Etc::sourcelist={apt / 'repositories.sources'}", "-oDir::Etc::sourceparts=-", "-oAPT::Sandbox::User=" + os.environ["USER"]]
    if not args.no_update:
        print("Refreshing isolated signed apt indexes", flush=True)
        (apt / "update.log").write_text(run(["apt-get", *options, "update"]))
    manifest = {"version": 1, "stage": str(stage), "provenanceSha256": digest(stage / "provenance.json"), "packages": [], "blockers": [], "staticDependencyReview": "pending"}
    provenance = json.loads((stage / "provenance.json").read_text())
    ldconfig = run(["/sbin/ldconfig", "-p"])
    candidates = [Path(line.rsplit(" => ", 1)[1]) for line in ldconfig.splitlines() if " => " in line]
    candidates.extend([Path("/usr/bin/obs-ffmpeg-mux"), Path("/usr/lib/x86_64-linux-gnu/libobs-opengl.so")])
    candidates.extend(Path("/usr/lib/x86_64-linux-gnu/obs-plugins").glob("*.so"))
    candidates.extend(Path("/usr/lib/x86_64-linux-gnu/pulseaudio").glob("*.so"))
    by_name = {}
    for file in candidates:
        by_name.setdefault(file.name, []).append(file)
    groups = {}
    for file in Path("/usr/share/common-licenses").iterdir():
        if file.is_file():
            owner = run(["dpkg-query", "-S", str(file.resolve())]).split(": ", 1)[0]
            fields = paragraphs(run(["dpkg-query", "-s", owner]))[0]
            groups.setdefault((owner, fields["Version"]), [])
    expected_files = {entry["path"]: entry["sha256"] for entry in provenance["libraries"]}
    for file in stage.rglob("*"):
        if file.is_file() and file.name != "attaclip-recorder" and file.open("rb").read(4) == b"\x7fELF":
            relative = str(file.relative_to(stage))
            actual = digest(file)
            if relative in expected_files and expected_files[relative] != actual:
                raise ValueError(f"Staged file changed: {relative}")
            original = next((candidate.resolve() for candidate in by_name.get(file.name, []) if candidate.exists() and digest(candidate) == actual), None)
            if original is None:
                manifest["blockers"].append(f"No identical installed package file for {relative}")
                continue
            owner = run(["dpkg-query", "-S", str(original)]).split(": ", 1)[0]
            fields = paragraphs(run(["dpkg-query", "-s", owner]))[0]
            key = owner, fields["Version"]
            groups.setdefault(key, []).append({"path": relative, "sha256": actual, "installedPath": str(original)})
            notice = Path("/usr/share/doc") / owner.split(":", 1)[0] / "copyright"
            if notice.exists():
                notice_owner = run(["dpkg-query", "-S", str(notice.resolve())]).split(": ", 1)[0]
                notice_fields = paragraphs(run(["dpkg-query", "-s", notice_owner]))[0]
                groups.setdefault((notice_owner, notice_fields["Version"]), [])
    for (owner, version), files in sorted(groups.items()):
        print(f"Capture {owner}={version}, {len(files)} files", flush=True)
        try:
            try:
                binary = next(record for record in paragraphs(run(["apt-cache", *options, "show", f"{owner}={version}"])) if record.get("Version") == version and "Filename" in record)
                source, source_version = source_identity(binary)
                source_record = next(record for record in paragraphs(run(["apt-cache", *options, "showsrc", source])) if record.get("Version") == source_version)
                binary_uris = run(["apt-get", *options, "--print-uris", "download", f"{owner}={version}"])
                binary_url = next(re.match(r"'([^']+)'", line)[1] for line in binary_uris.splitlines() if line.startswith("'"))
                source_uris = run(["apt-get", *options, "--print-uris", "--only-source", "source", f"{source}={source_version}"])
                urls = {urllib.parse.unquote(line.split("'", 2)[1].rsplit("/", 1)[1]): line.split("'", 2)[1] for line in source_uris.splitlines() if line.startswith("'")}
                if owner.split(":", 1)[0] in {"libavcodec60", "librsvg2-2", "librav1e0", "libplacebo338", "obs-studio"}:
                    # These builds can embed static libraries or header-generated code.
                    # Exact installed build dependencies come from the actual binary build.
                    historical_inputs(root, owner, version)
            except (StopIteration, subprocess.CalledProcessError):
                binary, source_record, binary_url, urls = historical_inputs(root, owner, version)
                source, source_version = source_identity(binary)
            identifier = hashlib.sha256(f"{source} {source_version}".encode()).hexdigest()[:16]
            folder = root / "packages" / f"{source}-{identifier}"
            folder.mkdir(parents=True, exist_ok=True)
            (folder / f"{owner.replace(':', '_')}-binary-control.txt").write_text("\n".join(f"{key}: {value}" for key, value in binary.items()) + "\n")
            (folder / "source-control.txt").write_text("\n".join(f"{key}: {value}" for key, value in source_record.items()) + "\n")
            archive = folder / archive_name(Path(binary["Filename"]).name)
            cache_file = Path("/var/cache/apt/archives") / archive.name
            if cache_file.exists() and digest(cache_file) == binary["SHA256"]:
                shutil.copyfile(cache_file, archive)
            else:
                download(binary_url, archive, binary["SHA256"])
            control = paragraphs(run(["dpkg-deb", "-f", str(archive)]))[0]
            if source_identity(control) != (source, source_version) or control["Version"] != version:
                raise ValueError("Downloaded binary/source control identity disagrees")
            data = deb_data(archive)
            for file in files:
                member = match_member(data, Path(file["path"]).name, file["sha256"])
                if not member:
                    raise ValueError(f"Official .deb does not contain staged bytes for {file['path']}")
                file["debMember"] = member
            # Preserve authoritative signed-index checksums with every source archive.
            captured = []
            for line in source_record["Checksums-Sha256"].splitlines():
                if not line.strip():
                    continue
                sha256, size, name = line.split()
                archive_name(name)
                download(urls[name], folder / name, sha256)
                if (folder / name).stat().st_size != int(size):
                    raise ValueError(f"Wrong source size for {name}")
                captured.append({"path": str((folder / name).relative_to(root)), "sha256": sha256, "size": int(size), "url": urls[name]})
            notice = Path("/usr/share/doc") / owner.split(":", 1)[0] / "copyright"
            if not notice.exists():
                raise ValueError("Package copyright file missing")
            notice_target = folder / f"{owner.replace(':', '_')}-copyright.txt"
            shutil.copyfile(notice.resolve(), notice_target)
            notice_member = match_member(data, "copyright", digest(notice_target))
            notice_owner = owner if notice_member else run(["dpkg-query", "-S", str(notice.resolve())]).split(": ", 1)[0]
            if not notice_member and notice_owner == owner:
                raise ValueError("Copyright bytes differ from the verified package archive")
            manifest["packages"].append({"binaryPackage": owner, "binaryVersion": version, "sourcePackage": source, "sourceVersion": source_version, "binaryArchive": {"path": str(archive.relative_to(root)), "sha256": digest(archive), "url": binary_url}, "files": files, "sourceArchives": captured, "copyright": {"path": str(notice_target.relative_to(root)), "sha256": digest(notice_target), "package": notice_owner, "debMember": notice_member}})
        except Exception as error:
            manifest["blockers"].append(f"{owner}={version}: {error}")
        (root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    common = root / "common-licenses"
    common.mkdir(exist_ok=True)
    for file in Path("/usr/share/common-licenses").iterdir():
        if file.is_file():
            shutil.copyfile(file, common / file.name)
    for package in manifest["packages"]:
        notice = package["copyright"]
        if not notice["debMember"]:
            verified = next((other for other in manifest["packages"] if other["binaryPackage"] == notice["package"] and other["copyright"]["debMember"] and other["copyright"]["sha256"] == notice["sha256"]), None)
            if not verified:
                manifest["blockers"].append(f"Copyright owning package is not verified for {package['binaryPackage']}")
    manifest["collectionComplete"] = not manifest["blockers"]
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Captured {len(manifest['packages'])} exact binary/source package records. {len(manifest['blockers'])} blockers. Static dependency review remains pending.")
    return 1 if manifest["blockers"] else 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--no-update", action="store_true")
    parser.add_argument("--check", action="store_true")
    arguments = parser.parse_args()
    raise SystemExit(check(arguments) if arguments.check else collect(arguments))
