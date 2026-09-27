#!/usr/bin/env python3
"""Package reviewed source separately from installation data and select production releases."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile
import time
import uuid

import release


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify(directory):
    directory = Path(directory).resolve()
    manifest = json.loads((directory / 'manifest.json').read_text())
    files = manifest['files']
    if not isinstance(files, dict) or not files:
        raise ValueError('Empty release manifest')
    source = directory / 'source'
    for name, expected in files.items():
        path = source / name
        if not release.allowed(name, 'public') or path.is_symlink() or not path.is_file():
            raise ValueError('Invalid release path: ' + name)
        if any(parent.is_symlink() for parent in path.parents):
            raise ValueError('Symlink in release path: ' + name)
        if digest(path) != expected:
            raise ValueError('Release checksum mismatch: ' + name)
    actual = set()
    for path in source.rglob('*'):
        name = path.relative_to(source).as_posix()
        if name == 'node_modules' or name.startswith('node_modules/'):
            continue
        if path.is_symlink():
            raise ValueError('Unexpected symlink: ' + name)
        if path.is_file():
            actual.add(name)
    if actual != set(files):
        raise ValueError('Release contains files outside its manifest')
    return manifest


def pack(output, installation):
    output = output.resolve()
    installation = installation.resolve()
    if output == release.ROOT or release.ROOT in output.parents:
        raise ValueError('Release output must be outside public source')
    output.mkdir(parents=True, exist_ok=False, mode=0o700)
    source = output / 'source'
    source.mkdir()
    names = set(release.git(release.ROOT, 'ls-files', '-c', '-o', '--exclude-standard', '-z').decode().split('\0')) - {''}
    for name in sorted(names):
        path = release.ROOT / name
        if path.exists() and release.allowed(name, 'public'):
            release.copy_file(path, source / name)
    # Scan the exact exported index in a fresh repository, never development history.
    subprocess.run(['git', 'init', '-q', str(source)], check=True)
    release.git(source, 'add', '.')
    release.git(source, '-c', 'user.name=HomeTruth release audit', '-c', 'user.email=release@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Audited release snapshot')
    release.check(source, 'public', True)
    with tempfile.TemporaryDirectory(prefix='hometruth-empty-private-') as empty:
        subprocess.run(['bun', str(release.ROOT / 'scripts/audit-local-boundary.ts'), str(installation), str(source), empty], check=True)
    shutil.rmtree(source / '.git')
    files = {p.relative_to(source).as_posix(): digest(p) for p in sorted(source.rglob('*')) if p.is_file()}
    tree_hash = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()
    manifest = {'createdAt': datetime.now(timezone.utc).isoformat(), 'treeSha256': tree_hash,
                'bunVersion': json.loads((source / 'package.json').read_text())['packageManager'].removeprefix('bun@'), 'files': files}
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    verify(output)
    with tarfile.open(output / 'release.tar.gz', 'w:gz') as archive:
        archive.add(output / 'manifest.json', arcname='manifest.json')
        archive.add(source, arcname='source')
    print('Packaged source only: ' + str(output / 'release.tar.gz'))
    print('Tree SHA-256: ' + tree_hash)


def unpack(archive_path, destination):
    destination = Path(destination)
    if destination.exists():
        raise ValueError('Release already exists; releases are never overwritten')
    destination.mkdir(parents=True, mode=0o700)
    try:
        with tarfile.open(archive_path, 'r:gz') as archive:
            names = set()
            for member in archive.getmembers():
                path = Path(member.name)
                if path.is_absolute() or '..' in path.parts or member.name in names:
                    raise ValueError('Unsafe or duplicate archive path')
                names.add(member.name)
                if not member.isfile() and not member.isdir():
                    raise ValueError('Release archives cannot contain links or special files')
                if member.name != 'manifest.json' and member.name != 'source' and not member.name.startswith('source/'):
                    raise ValueError('Unexpected archive root')
                if member.mode & 0o7000:
                    raise ValueError('Privileged archive mode')
            archive.extractall(destination)
        verify(destination)
    except Exception:
        shutil.rmtree(destination)
        raise


def select(root, name):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,99}', name):
        raise ValueError('Invalid release name')
    root = Path(root).resolve()
    target = root / 'releases' / name
    verify(target)
    marker = target / 'validated.json'
    if not marker.is_file() or json.loads(marker.read_text())['treeSha256'] != verify(target)['treeSha256']:
        raise ValueError('Release has not passed validation on this host')
    current = root / 'current'
    if current.exists() and not current.is_symlink():
        raise ValueError('current must be a symlink')
    previous = os.readlink(current) if current.is_symlink() else None
    temporary = root / ('.current-' + uuid.uuid4().hex)
    temporary.symlink_to(Path('releases') / name)
    os.replace(temporary, current)
    print(json.dumps({'release': name, 'previous': previous}))


def validate(directory, installation, bun):
    directory = Path(directory).resolve()
    manifest = verify(directory)
    version = subprocess.check_output([bun, '--version'], text=True).strip()
    if version != manifest['bunVersion']:
        raise ValueError('Use the Bun version pinned in the release')
    subprocess.run([bun, 'install', '--frozen-lockfile', '--ignore-scripts'], cwd=directory / 'source', check=True)
    subprocess.run([bun, 'run', 'typecheck'], cwd=directory / 'source', check=True)
    subprocess.run([bun, 'scripts/site.ts', str(Path(installation).resolve()), 'check'], cwd=directory / 'source', check=True)
    verify(directory)
    (directory / 'validated.json').write_text(json.dumps({'treeSha256': manifest['treeSha256'], 'bunVersion': version}) + '\n')
    print('Validated release without starting a server')


def run(root, bun):
    """Stable launchd entry point. Only the selected release can run; no source watching."""
    import signal
    import logging
    from logging.handlers import RotatingFileHandler
    import threading
    root = Path(root).resolve()
    stopping = False
    def stop(_signal, _frame):
        nonlocal stopping
        stopping = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    logger = logging.getLogger('hometruth-production')
    logger.setLevel(logging.INFO)
    handler = RotatingFileHandler(root / 'logs/application.log', maxBytes=10 * 1024 * 1024, backupCount=5)
    logger.addHandler(handler)
    while not stopping:
        current = (root / 'current').resolve(strict=True)
        manifest = verify(current)
        if json.loads((current / 'validated.json').read_text())['treeSha256'] != manifest['treeSha256']:
            raise ValueError('Selected release was not validated')
        command = [bun, str(current / 'source/scripts/site.ts'), str(root / 'installation'), 'start']
        # Stay in launchd's process group so it also reaps the site launcher and
        # supervisor if this wrapper is killed without a chance to clean up.
        child = subprocess.Popen(command, cwd=root / 'installation',
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        def consume():
            for line in child.stdout:
                logger.info(line.rstrip('\n'))
        reader = threading.Thread(target=consume, daemon=True)
        reader.start()
        while not stopping and child.poll() is None and (root / 'current').resolve() == current:
            time.sleep(1)
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=15)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
                raise RuntimeError('Site launcher did not stop; exiting so launchd reaps its process group')
        reader.join(timeout=2)
        if not stopping:
            time.sleep(2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    p = commands.add_parser('pack'); p.add_argument('--output', type=Path, required=True); p.add_argument('--installation', type=Path, required=True)
    p = commands.add_parser('unpack'); p.add_argument('archive_path'); p.add_argument('destination')
    p = commands.add_parser('verify'); p.add_argument('directory')
    p = commands.add_parser('validate'); p.add_argument('directory'); p.add_argument('--installation', required=True); p.add_argument('--bun', required=True)
    p = commands.add_parser('select'); p.add_argument('--root', required=True); p.add_argument('name')
    p = commands.add_parser('run'); p.add_argument('--root', required=True); p.add_argument('--bun', required=True)
    args = vars(parser.parse_args())
    command = args.pop('command')
    globals()[command](**args)


if __name__ == '__main__':
    os.umask(0o077)
    try:
        main()
    except (ValueError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error))
