import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtimePaths } from "./paths";
import { createSourceSnapshot } from "./snapshot";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hometruth-paths-")));
  roots.push(root);
  const source = join(root, "source");
  const installation = join(root, "private");
  await mkdir(join(source, "src"), { recursive: true });
  await mkdir(join(source, "node_modules"));
  await mkdir(installation);
  await writeFile(join(source, "src/example.ts"), "export const example = true;\n");
  await writeFile(join(source, "package.json"), '{"type":"module"}');
  return { root, source, installation };
}

test("source and installation must be disjoint, including symlink aliases", async () => {
  const { root, source } = await fixture();
  await mkdir(join(source, "private"));
  await symlink(join(source, "private"), join(root, "alias"));
  expect(() => runtimePaths(source, source)).toThrow("outside");
  expect(() => runtimePaths(source, join(source, "private"))).toThrow("outside");
  expect(() => runtimePaths(source, join(root, "alias"))).toThrow("outside");
  expect(() => runtimePaths(source, root)).toThrow("outside");
});

test("source snapshots and state links live only in the private runtime tree", async () => {
  const { source, installation } = await fixture();
  const paths = runtimePaths(source, installation);
  const snapshot = await createSourceSnapshot(paths, "test");
  expect(snapshot.startsWith(join(installation, ".hometruth/dev/"))).toBe(true);
  expect(await readFile(join(snapshot, "src/example.ts"), "utf8")).toContain("example = true");
  expect(await realpath(join(snapshot, "node_modules"))).toBe(join(source, "node_modules"));
  expect(await realpath(join(snapshot, ".hometruth"))).toBe(join(installation, ".hometruth"));
  expect(await Bun.file(join(source, ".hometruth")).exists()).toBe(false);
});
