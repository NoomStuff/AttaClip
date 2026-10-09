import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("appimage", Path(__file__).with_name("collect-appimage-sources.py"))
appimage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(appimage)


def git_hash(kind, data):
    return hashlib.sha1(kind.encode() + b" " + str(len(data)).encode() + b"\0" + data).hexdigest()


class ImmutableSourceTest(unittest.TestCase):
    def fixture(self, root):
        data = b"source with an exact upstream commit\n"
        blob = git_hash("blob", data)
        child = git_hash("tree", b"100644 source.c\0" + bytes.fromhex(blob))
        tree = git_hash("tree", b"40000 src\0" + bytes.fromhex(child))
        commit = ("tree " + tree + "\nauthor Example <example@example.invalid> 0 +0000\ncommitter Example <example@example.invalid> 0 +0000\n\nFixture\n").encode()
        expected = git_hash("commit", commit)
        (root / "commit.raw").write_bytes(commit)
        (root / "tree.json").write_text(json.dumps({"truncated": False, "tree": [
            {"path": "src", "mode": "040000", "type": "tree", "sha": child},
            {"path": "src/source.c", "mode": "100644", "type": "blob", "sha": blob},
        ]}))
        self.archive(root, data)
        return expected

    def archive(self, root, data, duplicate=False):
        with tarfile.open(root / "source.tar", "w") as archive:
            member = tarfile.TarInfo("upstream/src/source.c")
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
            if duplicate:
                archive.addfile(member, io.BytesIO(data))

    def verify(self, root, expected):
        appimage.verify_git_archive(root / "source.tar", root / "tree.json", root / "commit.raw", expected)

    def test_exact_git_objects_accept_source_and_reject_changed_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            expected = self.fixture(root)
            self.verify(root, expected)
            self.archive(root, b"silently replaced source\n")
            with self.assertRaisesRegex(ValueError, "archive bytes"):
                self.verify(root, expected)

    def test_rewriting_nested_metadata_cannot_adopt_another_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            expected = self.fixture(root)
            changed = b"replacement"
            self.archive(root, changed)
            tree = json.loads((root / "tree.json").read_text())
            tree["tree"][1]["sha"] = git_hash("blob", changed)
            # Even a caller who rewrites the manifest/archive digest cannot
            # change the Git tree pinned by the actual raw commit object.
            (root / "tree.json").write_text(json.dumps(tree))
            with self.assertRaisesRegex(ValueError, "Git tree"):
                self.verify(root, expected)

    def test_changed_commit_and_duplicate_archive_members_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            expected = self.fixture(root)
            (root / "commit.raw").write_bytes((root / "commit.raw").read_bytes() + b"changed")
            with self.assertRaisesRegex(ValueError, "commit/tree"):
                self.verify(root, expected)
            expected = self.fixture(root)
            self.archive(root, b"source with an exact upstream commit\n", duplicate=True)
            with self.assertRaisesRegex(ValueError, "Duplicate"):
                self.verify(root, expected)


if __name__ == "__main__":
    unittest.main()
