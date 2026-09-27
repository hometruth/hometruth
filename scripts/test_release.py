import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
import hashlib
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("release", Path(__file__).with_name("release.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

class ReleasePolicyTest(unittest.TestCase):
    def test_real_scanner_blocks_a_staged_synthetic_pat_even_when_worktree_is_clean(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            token = "ghp_" + hashlib.sha256(b"synthetic nonfunctional scanner canary").hexdigest()[:36]
            (root / "README.md").write_text("credential = " + token)
            release.git(root, "add", "README.md")
            (root / "README.md").write_text("removed from working copy")
            with self.assertRaises(subprocess.CalledProcessError):
                release.check(root, "public", False)

    def test_public_and_private_boundaries(self):
        for path in ["src/index.ts", "docs/REPOSITORIES.md", "templates/private/site.json", ".env.example"]:
            self.assertTrue(release.allowed(path, "public"), path)
        for path in ["devices.yml", ".env.production", ".hometruth/secrets.yml", "research/log.md", "docs/research/log.md", "tools/aqara/pair-matter.ts", "templates/private/research/notes.md", "src/private/settings.json", "src/capture.pcapng", "src/key.pem", "src/../site.json"]:
            self.assertFalse(release.allowed(path, "public"), path)
        for path in ["devices.yml", "site.json", "kindle.json", ".github/workflows/check.yml", "research/device/JOURNAL.md", "research/device/tools/probe.ts"]:
            self.assertTrue(release.allowed(path, "private"), path)
        for path in ["src/index.ts", ".env", "secrets.yml", "backup.zip", ".hometruth/pairing.json", "research/device/captures/decoded.md", "research/device/apps/source.java", "research/device/.env", "research/device/keys.pem", "research/device/config.local.json", "research/device/pairing.json", "research/.git/config"]:
            self.assertFalse(release.allowed(path, "private"), path)

    def test_private_research_secrets_are_blocked(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            (root / "research").mkdir()
            token = "ghp_" + hashlib.sha256(b"private research scanner canary").hexdigest()[:36]
            (root / "research/JOURNAL.md").write_text("credential = " + token)
            release.git(root, "add", ".")
            with patch.object(release, "validate_private"), self.assertRaises(subprocess.CalledProcessError):
                release.check(root, "private", False)

    def test_scans_index_bytes_instead_of_unstaged_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            (root / "README.md").write_text("staged payload")
            release.git(root, "add", "README.md")
            (root / "README.md").write_text("innocent working copy")
            def inspect(tree, **kwargs):
                self.assertEqual((tree / "README.md").read_text(), "staged payload")
            with patch.object(release, "scan", side_effect=inspect):
                release.check(root, "public", False)

    def test_forced_ignored_file_and_symlink_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            (root / ".env").write_text("TEST_ONLY=value")
            release.git(root, "add", "-f", ".env")
            with self.assertRaisesRegex(ValueError, "Not allowed"):
                release.check(root, "public", False)
            release.git(root, "rm", "--cached", ".env")
            (root / "README.md").symlink_to(root / ".env")
            release.git(root, "add", "README.md")
            with self.assertRaisesRegex(ValueError, "Not allowed"):
                release.check(root, "public", False)

    def test_history_rejects_a_deleted_private_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            release.git(root, "config", "user.name", "Test")
            release.git(root, "config", "user.email", "test@example.invalid")
            (root / "README.md").write_text("test")
            (root / "devices.yml").write_text("test")
            release.git(root, "add", ".")
            release.git(root, "commit", "-qm", "test fixture")
            release.git(root, "rm", "devices.yml")
            release.git(root, "commit", "-qm", "remove private file")
            with patch.object(release, "scan"), self.assertRaisesRegex(ValueError, "historical"):
                release.check(root, "public", True)

if __name__ == "__main__":
    unittest.main()
