import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("packet", Path(__file__).with_name("package-linux-sources.py"))
packet = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packet)


class SourceZipTest(unittest.TestCase):
    def fixture(self, root):
        data = b"exact archive source bytes"
        (root / "source.tar").write_bytes(data)
        kit = {"appCommit": "a" * 40, "files": [{"path": "source.tar", "sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}]}
        (root / "linux-kit.json").write_text(json.dumps(kit))
        (root / "README.txt").write_text("Rebuild these sources")
        return kit

    def test_byte_verification_and_safe_extract(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "inputs"
            source.mkdir()
            expected = self.fixture(source)
            archive = root / "source.zip"
            packet.package(source, archive)
            self.assertEqual(packet.verify(archive, root / "output"), expected)
            self.assertEqual((root / "output/source.tar").read_bytes(), (source / "source.tar").read_bytes())
            with zipfile.ZipFile(root / "changed.zip", "w") as changed:
                for name in ["linux-kit.json", "README.txt"]:
                    changed.writestr(name, (source / name).read_bytes())
                changed.writestr("source.tar", b"wrong archive source bytes")
            with self.assertRaisesRegex(ValueError, "changed"):
                packet.verify(root / "changed.zip")

    def test_unsafe_names_and_unexpected_members(self):
        for name in ["../private", "/root/private", "a/./b", "a/../b", "a//b", "a/", "C:/private", "a\\b", "a:stream"]:
            with self.assertRaises(ValueError):
                packet.safe_name(name)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            expected = self.fixture(root)
            with zipfile.ZipFile(root / "extra.zip", "w") as archive:
                for name in ["linux-kit.json", "README.txt", "source.tar"]:
                    archive.writestr(name, (root / name).read_bytes())
                archive.writestr("unreviewed", b"extra")
            with self.assertRaisesRegex(ValueError, "exactly"):
                packet.verify(root / "extra.zip")
            self.assertEqual(expected["appCommit"], "a" * 40)


if __name__ == "__main__":
    unittest.main()
