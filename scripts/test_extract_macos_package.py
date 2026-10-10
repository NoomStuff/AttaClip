import importlib.util
import io
import stat
import unittest
import zipfile
from pathlib import Path

spec = importlib.util.spec_from_file_location("extract_mac", Path(__file__).with_name("extract-macos-package.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def fixture(entries):
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w") as archive:
        for name, content, mode in entries:
            member = zipfile.ZipInfo(name)
            member.create_system = 3
            member.external_attr = mode << 16
            archive.writestr(member, content)
    data.seek(0)
    return zipfile.ZipFile(data)


class MacZipTests(unittest.TestCase):
    def test_framework_link(self):
        with fixture([("AttaClip.app/Versions/A/lib.dylib", "code", stat.S_IFREG | 0o755), ("AttaClip.app/Versions/Current", "A", stat.S_IFLNK | 0o777)]) as archive:
            self.assertEqual(len(module.inspect(archive, "AttaClip.app")), 2)

    def test_escape_collision_cycle_and_linked_parent(self):
        cases = [
            [("AttaClip.app/link", "../../outside", stat.S_IFLNK)],
            [("AttaClip.app/lib", "code", stat.S_IFREG), ("AttaClip.app/LIB", "shadow", stat.S_IFREG)],
            [("AttaClip.app/a", "b", stat.S_IFLNK), ("AttaClip.app/b", "a", stat.S_IFLNK)],
            [("AttaClip.app/alias", "real", stat.S_IFLNK), ("AttaClip.app/alias/evil", "code", stat.S_IFREG), ("AttaClip.app/real/x", "code", stat.S_IFREG)],
            [("AttaClip.app/../outside", "code", stat.S_IFREG)],
            [("AttaClip.app/link", "absent", stat.S_IFLNK)],
        ]
        for entries in cases:
            with self.subTest(entries=entries), fixture(entries) as archive:
                with self.assertRaises(ValueError):
                    module.inspect(archive, "AttaClip.app")


if __name__ == "__main__":
    unittest.main()
