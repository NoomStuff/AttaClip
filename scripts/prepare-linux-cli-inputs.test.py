import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("inputs", Path(__file__).with_name("prepare-linux-cli-inputs.py"))
inputs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inputs)


class RestoreSourceInputsTest(unittest.TestCase):
    def fixture(self, root):
        packet = root / "packet"
        (packet / "controlled-cli/build").mkdir(parents=True)
        (packet / "controlled-cli/sources").mkdir()
        archives = []
        for name in ["ffmpeg", "x264", "dav1d", "zlib"]:
            data = (name + " exact source").encode()
            relative = name + ".tar.gz"
            (packet / "controlled-cli/sources" / relative).write_bytes(data)
            archives.append({"path": relative, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)})
        build = {"producer": "attaclip-controlled-linux", "target": "linux-x64", "sourceArchives": archives, "sourceCommits": {name: "a" * 40 for name in ["ffmpeg", "x264", "dav1d", "zlib"]}}
        (packet / "controlled-cli/build/build-manifest.json").write_text(json.dumps(build))
        return packet

    def test_restore_then_reject_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            packet = self.fixture(root)
            project = root / "app"
            inputs.prepare(packet, project)
            self.assertEqual((project / "work/release-sources/ffmpeg.tar.gz").read_bytes(), b"ffmpeg exact source")
            manifest = json.loads((project / "work/release-sources/manifest.json").read_text())
            self.assertEqual(manifest["sources"][0]["repository"], "FFmpeg/FFmpeg")
            self.assertEqual(len(manifest["dependencySources"]), 3)
            with self.assertRaisesRegex(ValueError, "overwrite"):
                inputs.prepare(packet, project)

    def test_reject_changed_input(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            packet = self.fixture(root)
            (packet / "controlled-cli/sources/ffmpeg.tar.gz").write_bytes(b"changed source")
            with self.assertRaisesRegex(ValueError, "changed"):
                inputs.prepare(packet, root / "app")


if __name__ == "__main__":
    unittest.main()
