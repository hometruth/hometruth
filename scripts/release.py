#!/usr/bin/env python3
"""Export clean release trees and gate the exact Git index; never publish or start servers."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
PUBLIC_ROOTS = {"src", "docs", "skills", "scripts", "tests", "templates", ".github", ".githooks"}
PUBLIC_FILES = {"AGENTS.md", "CLAUDE.md", "README.md", "LICENSE", "SECURITY.md", "DESIGN.md", "PRODUCT.md", "package.json", "bun.lock", "tsconfig.json", "playwright.config.ts", ".gitignore", ".gitleaks.toml", ".env.example", "devices.example.yml", "hue-proxy.example.yml"}
PRIVATE_FILES = {"README.md", ".gitignore", "site.json", "devices.yml", "hue-proxy.yml", "kindle.json", "dog-announcer.json", ".github/workflows/check.yml", ".github/workflows/hometruth-action.yml"}
BLOCKED_PARTS = {".git", ".hometruth", "node_modules", "__pycache__", ".DS_Store", "artifacts", "captures", "recordings", "images", "secrets", "private", "local"}
BLOCKED_SUFFIXES = (".local.yml", ".local.yaml", ".local.md", ".local.json", ".pem", ".key", ".p12", ".pfx", ".pcap", ".pcapng", ".sqlite", ".sqlite-wal", ".sqlite-shm", ".db", ".log", ".bak", ".zip", ".tar", ".gz", ".pyc")
RESEARCH_SUFFIXES = {".md", ".txt", ".ts", ".mjs", ".js", ".sh", ".py", ".java", ".c", ".h", ".cpp", ".ino", ".ini", ".html"}
RESEARCH_BLOCKED_PARTS = BLOCKED_PARTS | {"apps", "ghidra", "community", "datasets"}

def allowed(path, kind):
    p = Path(path)
    if not p.parts or p.is_absolute() or ".." in p.parts:
        return False
    if kind == "private":
        if path in PRIVATE_FILES:
            return True
        return (p.parts[0] == "research" and p.suffix in RESEARCH_SUFFIXES
                and not any(part.startswith(".") or part in RESEARCH_BLOCKED_PARTS for part in p.parts[1:])
                and not path.endswith(BLOCKED_SUFFIXES))
    # The generic private-repo starter is public; no personal data goes there.
    parts = p.parts[2:] if p.parts[:2] == ("templates", "private") else p.parts
    if any(part in BLOCKED_PARTS or part == "research" for part in parts):
        return False
    if p.name.startswith(".env") and path != ".env.example":
        return False
    if path.endswith(BLOCKED_SUFFIXES):
        return False
    return path in PUBLIC_FILES or p.parts[0] in PUBLIC_ROOTS

def git(repo, *args):
    return subprocess.check_output(["git", "-C", str(repo), *args])

def copy_file(source, target):
    if source.is_symlink() or not source.is_file():
        raise ValueError(f"Refusing non-regular file: {source.name}")
    if any(parent.is_symlink() for parent in source.parents):
        raise ValueError(f"Refusing symlinked parent: {source.name}")
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)

def scan(tree, history=False, config=None):
    if not shutil.which("gitleaks"):
        raise ValueError("Install gitleaks before preparing or checking a release")
    command = ["gitleaks", "git" if history else "dir", "--redact", "--no-banner", "--ignore-gitleaks-allow", "--max-archive-depth=3", "--max-decode-depth=5"]
    command += ["--config", str(config or ROOT / ".gitleaks.toml")]
    if history:
        command += ["--log-opts=--all"]
    subprocess.run([*command, str(tree)], check=True)

def validate_private(tree):
    subprocess.run(["bun", str(ROOT / "scripts/site.ts"), str(tree), "check"], cwd=ROOT, check=True)

def export(output, installation):
    output = output.resolve()
    installation = installation.resolve()
    if ROOT == output or ROOT in output.parents:
        raise ValueError("Release output must be outside the public checkout")
    if output.exists():
        raise ValueError("Output already exists; choose a new empty destination")
    output.mkdir(parents=True, mode=0o700)
    public, private = output / "public", output / "private"
    public.mkdir(); private.mkdir()
    names = set(git(ROOT, "ls-files", "-c", "-o", "--exclude-standard", "-z").decode().split("\0")) - {""}
    excluded = []
    for name in sorted(names):
        source = ROOT / name
        if not source.exists():
            continue
        if allowed(name, "public"):
            copy_file(source, public / name)
        else:
            excluded.append(name)
    for source in (ROOT / "templates/private").rglob("*"):
        if source.is_file():
            copy_file(source, private / source.relative_to(ROOT / "templates/private"))
    # Only reviewed tracked files enter the private candidate. Runtime state,
    # secrets and unreviewed research remain in the separate private workspace.
    private_names = set(git(installation, "ls-files", "-z").decode().split("\0")) - {""}
    for name in sorted(private_names):
        if not allowed(name, "private"):
            raise ValueError(f"Not allowed in private installation: {name}")
        copy_file(installation / name, private / name)
    validate_private(private)
    # Private repositories get NO test-vector exceptions.
    scan(private, config=ROOT / "scripts/gitleaks-private.toml")
    scan(public)
    subprocess.run(["bun", str(ROOT / "scripts/audit-local-boundary.ts"), str(installation), str(public), str(private)], cwd=ROOT, check=True)
    inventory = {"public": {}, "private": {}, "excluded": excluded}
    for kind, tree in [("public", public), ("private", private)]:
        for path in sorted(tree.rglob("*")):
            if path.is_file():
                inventory[kind][str(path.relative_to(tree))] = hashlib.sha256(path.read_bytes()).hexdigest()
    (output / "manifest.json").write_text(json.dumps(inventory, indent=2) + "\n")
    print(f"Prepared {len(inventory['public'])} public and {len(inventory['private'])} private files. Manifest: {output / 'manifest.json'}")
    print("No Git history copied. No commits, remote changes, pushes, or server starts performed.")

def check(repo, kind, history):
    repo = repo.resolve()
    with tempfile.TemporaryDirectory(prefix="hometruth-index-") as temporary:
        tree = Path(temporary)
        entries = git(repo, "ls-files", "--stage", "-z").split(b"\0")
        count = 0
        for entry in entries:
            if not entry:
                continue
            metadata, raw_path = entry.split(b"\t", 1)
            mode, oid, stage = metadata.decode().split()
            path = raw_path.decode()
            if mode not in {"100644", "100755"} or stage != "0" or not allowed(path, kind):
                raise ValueError(f"Not allowed in {kind} repository index: {path}")
            target = tree / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(git(repo, "cat-file", "blob", oid))
            count += 1
        if not count:
            raise ValueError("Empty Git index")
        if kind == "private":
            validate_private(tree)
        config = ROOT / ("scripts/gitleaks-private.toml" if kind == "private" else ".gitleaks.toml")
        scan(tree, config=config)
        if history:
            # Refuse disallowed files even if removed from the latest tree.
            paths = git(repo, "log", "--all", "--name-only", "--format=", "-z").decode().split("\0")
            for path in paths:
                path = path.strip("\n")
                if path and not allowed(path, kind):
                    raise ValueError(f"Disallowed historical path: {path}; use a clean release history")
            scan(repo, history=True, config=config)
        print(f"Checked {count} {kind} index files" + (" and all local Git refs" if history else ""))

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["prepare", "check"])
    parser.add_argument("--output", type=Path)
    parser.add_argument("--repo", type=Path, default=ROOT)
    parser.add_argument("--kind", choices=["public", "private"], default="public")
    parser.add_argument("--history", action="store_true")
    parser.add_argument("--private-repo", type=Path, default=ROOT.parent / "hometruth_private")
    args = parser.parse_args()
    if args.command == "prepare":
        if not args.output:
            parser.error("prepare requires --output")
        export(args.output, args.private_repo)
    else:
        check(args.repo, args.kind, args.history)

if __name__ == "__main__":
    os.umask(0o077)
    try:
        main()
    except (ValueError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error))
