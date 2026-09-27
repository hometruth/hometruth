#!/usr/bin/env bun
/**
 * Link every skill under skills/ into an agent's skills directory so it loads
 * them: `../hometruth_private/.claude/skills/` by default, `~/.claude/skills/` with
 * `--global`. Run explicitly with `bun run skills:install`; dependency installation does not write agent settings.
 * Idempotent; never replaces a directory or a link that points elsewhere.
 */
import { lstat, mkdir, readdir, readlink, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const source = join(root, "skills");
const global = process.argv.includes("--global");
const target = global ? join(homedir(), ".claude", "skills") : resolve(root, "../hometruth_private/.claude/skills");

const skills: string[] = [];
for (const entry of await readdir(source, { withFileTypes: true })) {
  if (entry.isDirectory() && (await Bun.file(join(source, entry.name, "SKILL.md")).exists())) skills.push(entry.name);
}
skills.sort();

await mkdir(target, { recursive: true });
const linked: string[] = [];
const kept: string[] = [];
const warnings: string[] = [];
for (const name of skills) {
  const path = join(target, name);
  const wanted = relative(target, join(source, name));
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() && resolve(target, await readlink(path)) === join(source, name)) {
      kept.push(name);
    } else {
      warnings.push(`${path} exists and is not a link to ${wanted}; left untouched`);
    }
    continue;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
  }
  try {
    await symlink(wanted, path, "dir");
    linked.push(name);
  } catch (error) {
    warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const where = global ? "~/.claude/skills" : "../hometruth_private/.claude/skills";
if (linked.length) console.log(`Linked into ${where}: ${linked.join(", ")}`);
if (kept.length) console.log(`Already linked in ${where}: ${kept.join(", ")}`);
for (const warning of warnings) console.warn(`skills: ${warning}`);
