"""Rejection checks for the single controlled module source exception."""
import copy
import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

import controlled_wayland_sources as controlled


class ControlledModuleTest(unittest.TestCase):
    def proof(self):
        return {"obsVersion": "32.2.0", "sourceArchive": {"sha256": controlled.OBS_SHA, "size": controlled.OBS_SIZE},
                "sourceHashes": dict.fromkeys(controlled.INPUTS, "a" * 64),
                "module": {"name": "linux-pipewire.so", "sha256": "b" * 64, "size": 100},
                "compilerVersion": "pinned compiler", "compilerInputs": [{}] * 4,
                "buildEvidence": [{}], "headers": [{}], "linkerInputs": [{}], "linkerPaths": {"/lib": "/lib"}}

    def test_other_archive_recipe_or_binary_never_gets_exception(self):
        original = self.proof()
        controlled.validate_identity(original)
        for key, value in [("sha256", "f" * 64), ("size", controlled.OBS_SIZE + 1)]:
            modified = copy.deepcopy(original)
            modified["sourceArchive"][key] = value
            with self.assertRaises(ValueError):
                controlled.validate_identity(modified)
        for modification in [lambda p: p["sourceHashes"].pop("native/wayland/obs-pipewire-health.patch"),
                             lambda p: p["module"].update(name="obs-ffmpeg.so"),
                             lambda p: p.pop("compilerInputs"), lambda p: p.pop("linkerPaths")]:
            modified = copy.deepcopy(original)
            modification(modified)
            with self.assertRaises(ValueError):
                controlled.validate_identity(modified)

    def test_changed_module_is_rejected_before_source_exception(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "proof.json").write_text(json.dumps(self.proof()))
            record = {"proof": "proof.json", "path": controlled.MODULE}
            with self.assertRaisesRegex(ValueError, "actual staged build"):
                controlled.verify_inputs(root, record, {"waylandModule": self.proof()}, "f" * 64, 100)

    def test_exact_replay_rejects_changed_glad_patch_offset_and_extra_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            names = ["plugins/linux-pipewire/pipewire.c", *[f"deps/glad/include/header{i}.h" for i in range(11)]]
            content = b"old\nkeep\n"
            original = dict.fromkeys(names, hashlib.sha256(content).hexdigest())
            patched = {**original, names[0]: hashlib.sha256(b"new\nkeep\n").hexdigest()}
            archive = root / "source.tar"
            with tarfile.open(archive, "w") as package:
                for name in names:
                    member = tarfile.TarInfo("obs/" + name)
                    member.size = len(content)
                    package.addfile(member, io.BytesIO(content))
            health = root / "health.patch"
            exact = "--- a/plugins/linux-pipewire/pipewire.c\n+++ b/plugins/linux-pipewire/pipewire.c\n@@ -1,2 +1,2 @@\n-old\n+new\n keep\n"
            health.write_text(exact)
            controlled.replay_sources(archive, health, original, patched)
            for wrong in [{**patched, names[1]: "0" * 64}, {**patched, "deps/glad/extra.c": "0" * 64}]:
                with self.assertRaises(ValueError):
                    controlled.replay_sources(archive, health, original, wrong)
            health.write_text(exact.replace("@@ -1,2 +1,2 @@", "@@ -2,2 +2,2 @@"))
            with self.assertRaisesRegex(ValueError, "patch replay failed"):
                controlled.replay_sources(archive, health, original, patched)
            health.write_text(exact.replace("plugins/linux-pipewire/pipewire.c", "../private"))
            with self.assertRaisesRegex(ValueError, "outside"):
                controlled.replay_sources(archive, health, original, patched)

    def test_header_and_compiler_source_packages_are_required_even_for_system_inputs(self):
        header = {"path": "/usr/include/header.h", "sha256": "a" * 64, "size": 10, "systemLibrary": True,
                  "binaryPackage": "libc6-dev", "binaryVersion": "1", "sourcePackage": "glibc", "sourceVersion": "1"}
        proof = {"headers": [header], "linkerInputs": [], "compilerInputs": []}
        with self.assertRaisesRegex(ValueError, "Missing exact source"):
            controlled.check_header_packages(proof, [], lambda _: b"", lambda *args, **kwargs: True)
        package = {**header, "binaryArchive": {"sha256": "b" * 64}}
        with self.assertRaisesRegex(ValueError, "differs"):
            controlled.check_header_packages(proof, [package], lambda _: b"", lambda *args, **kwargs: False)

    def test_compiler_dependency_inventory_cannot_omit_consumed_header(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            record = {"files": []}
            proof = {"buildEvidence": []}
            with self.assertRaisesRegex(ValueError, "evidence is incomplete"):
                controlled.check_build_evidence(root, record, proof)

    def test_header_linker_and_compiler_substitutions_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def external(name, package="obs-studio"):
                return {"path": name, "sha256": "a" * 64, "size": 10, "binaryPackage": package,
                        "binaryVersion": "1", "sourcePackage": "source", "sourceVersion": "1", "systemLibrary": False}
            header = external("/usr/include/obs.h")
            library = external("/usr/lib/libobs.so.30")
            compiler = [external(name, "tool") for name in ["/usr/bin/x86_64-linux-gnu-gcc-13", "/usr/libexec/cc1", "/usr/bin/as", "/usr/bin/ld"]]
            names = ["camera-portal.c", "formats.c", "linux-pipewire.c", "pipewire.c", "portal.c", "screencast-portal.c", "glad.c"]
            sources = {name: "deps/glad/src/glad.c" if name == "glad.c" else "plugins/linux-pipewire/" + name for name in names}
            outputs = {name: "CMakeFiles/linux-pipewire.dir/" + name + ".o" for name in names}
            data = {"compile_commands.json": json.dumps([{"file": "/source/" + sources[name], "output": outputs[name], "command": "/usr/bin/cc -o " + outputs[name] + " -c /source/" + sources[name]} for name in names]),
                    "CMakeCache.txt": "pinned config", "CMakeFiles/linux-pipewire.dir/link.txt": "/usr/bin/cc " + " ".join(outputs.values()) + " /usr/lib/libobs.so.30",
                    "linker-trace.txt": "/usr/lib/libobs.so.30\n"}
            for name in names:
                data["CMakeFiles/linux-pipewire.dir/" + name + ".o.d"] = "object: /source/" + sources[name] + " /usr/include/obs.h\n"
            files = []
            for name, content in data.items():
                target = root / "wayland/build" / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content)
                files.append({"path": "wayland/build/" + name, "sha256": controlled.digest(target), "size": target.stat().st_size})
            proof = {"buildEvidence": [{**file, "path": file["path"].removeprefix("wayland/build/")} for file in files],
                     "compilerInputs": compiler, "compilerPaths": {"/usr/bin/cc": compiler[0]["path"], "cc1": compiler[1]["path"], "as": compiler[2]["path"], "ld": compiler[3]["path"]},
                     "headers": [header], "linkerInputs": [library], "linkerPaths": {library["path"]: library["path"]}, "patchedSourceHashes": dict.fromkeys(sources.values(), "a" * 64)}
            controlled.check_build_evidence(root, {"files": files}, proof)
            for modification in [lambda p: p.update(headers=[]), lambda p: p.update(linkerInputs=[]),
                                 lambda p: p["compilerPaths"].update({"/usr/bin/cc": "/unrecorded/compiler"}),
                                 lambda p: p["headers"][0].update(systemLibrary=True),
                                 lambda p: p["patchedSourceHashes"].pop("deps/glad/src/glad.c")]:
                modified = copy.deepcopy(proof)
                modification(modified)
                with self.assertRaises(ValueError):
                    controlled.check_build_evidence(root, {"files": files}, modified)


if __name__ == "__main__":
    unittest.main()
