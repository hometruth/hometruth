import importlib.util
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
import subprocess

sys.path.insert(0, str(Path(__file__).parent))
import deployment


class DeploymentTest(unittest.TestCase):
    def fixture(self, directory):
        root = Path(directory)
        (root / 'source/src').mkdir(parents=True)
        (root / 'source/src/index.ts').write_text('export {};\n')
        manifest = {'treeSha256': 'synthetic-tree', 'files': {'src/index.ts': deployment.digest(root / 'source/src/index.ts')}}
        (root / 'manifest.json').write_text(json.dumps(manifest))
        (root / 'validated.json').write_text(json.dumps({'treeSha256': 'synthetic-tree'}))
        return root

    def test_modified_or_extra_source_cannot_be_selected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidate = self.fixture(root / 'releases/candidate')
            (candidate / 'source/src/index.ts').write_text('changed\n')
            with self.assertRaisesRegex(ValueError, 'checksum'):
                deployment.select(root, 'candidate')
            self.assertFalse((root / 'current').exists())
        with tempfile.TemporaryDirectory() as directory:
            root = self.fixture(directory)
            (root / 'source/.env.local').write_text('SYNTHETIC=value\n')
            with self.assertRaisesRegex(ValueError, 'outside its manifest'):
                deployment.verify(root)

    def test_cli_unpack_and_verify_round_trip(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidate = self.fixture(root / 'candidate')
            archive = root / 'release.tar.gz'
            with tarfile.open(archive, 'w:gz') as out:
                out.add(candidate / 'source', arcname='source')
                out.add(candidate / 'manifest.json', arcname='manifest.json')
            command = [sys.executable, str(Path(deployment.__file__).resolve())]
            subprocess.run([*command, 'unpack', str(archive), str(root / 'unpacked')], check=True)
            subprocess.run([*command, 'verify', str(root / 'unpacked')], check=True)

    def test_select_never_changes_installation_and_requires_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'installation').mkdir()
            state = root / 'installation/devices.yml'
            state.write_text('synthetic installation')
            first = self.fixture(root / 'releases/first')
            self.fixture(root / 'releases/second')
            deployment.select(root, 'first')
            (root / 'releases/second/validated.json').unlink()
            with self.assertRaisesRegex(ValueError, 'not passed validation'):
                deployment.select(root, 'second')
            self.assertEqual((root / 'current').resolve(), first.resolve())
            self.assertEqual(state.read_text(), 'synthetic installation')

    def test_archive_traversal_and_links_are_rejected(self):
        for name, kind in [('../escape', tarfile.REGTYPE), ('/absolute', tarfile.REGTYPE), ('source/src/key.ts', tarfile.SYMTYPE)]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                archive = root / 'input.tar.gz'
                with tarfile.open(archive, 'w:gz') as out:
                    info = tarfile.TarInfo(name)
                    info.type = kind
                    info.linkname = '/etc/passwd' if kind == tarfile.SYMTYPE else ''
                    out.addfile(info, io.BytesIO())
                with self.assertRaises(ValueError):
                    deployment.unpack(archive, root / 'release')
                self.assertFalse((root / 'release').exists())

    def test_dependency_symlink_does_not_allow_source_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = self.fixture(directory)
            (root / 'source/src/outside.ts').symlink_to('/etc/hosts')
            with self.assertRaisesRegex(ValueError, 'symlink'):
                deployment.verify(root)

if __name__ == '__main__':
    unittest.main()
