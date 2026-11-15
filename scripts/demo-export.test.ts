import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoExportOptions, demoOutputPath, writeDemoOutput } from "./demo-export";
import { siteCommand } from "./site";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function directory() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hometruth-demo-cli-")));
  roots.push(root); return root;
}

test("demo arguments default to anonymized installation-local output", () => {
  expect(demoExportOptions([])).toEqual({ output: ".hometruth/demo-export", basePath: "/demo", includeNames: false });
  expect(demoExportOptions(["--output", "export", "--include-names", "--base-path", "/play/home"]).includeNames).toBe(true);
  for (const value of ["/", "//host", "/demo/", "/demo/../source", "https://example.com", "/demo?x=1"]) expect(() => demoExportOptions(["--base-path", value])).toThrow();
  expect(() => demoExportOptions(["--output"])).toThrow();
});

test("exports refuse unmanaged directories, source paths, and symlink aliases", async () => {
  const source = await directory();
  const installation = await directory();
  expect(await demoOutputPath(source, join(installation, "export"))).toBe(join(installation, "export"));
  await expect(writeDemoOutput(source, installation, async () => {})).rejects.toThrow("not a managed");
  await expect(demoOutputPath(source, join(source, "export"))).rejects.toThrow("outside");
  await expect(demoOutputPath(source, source)).rejects.toThrow("outside");
  await symlink(source, join(installation, "alias"));
  await expect(demoOutputPath(source, join(installation, "alias/export"))).rejects.toThrow("outside");
  await expect(demoOutputPath(source, join(installation, "alias"))).rejects.toThrow("symlink");
});

test("repeat generation replaces owned output, removes stale files, and preserves deterministic manifest bytes", async () => {
  const source = await directory(), installation = await directory();
  const output = join(installation, "export");
  const generate = async (path: string) => { await Bun.write(join(path, "demo/index.html"), "demo"); };
  await writeDemoOutput(source, output, generate);
  const manifest = await Bun.file(join(output, ".hometruth-demo-export.json")).text();
  await writeDemoOutput(source, output, generate);
  expect(await Bun.file(join(output, ".hometruth-demo-export.json")).text()).toBe(manifest);
  await writeDemoOutput(source, output, async path => {
    await generate(path); await Bun.write(join(path, "demo/removed.html"), "old page");
  });
  await writeDemoOutput(source, output, generate);
  expect(await Bun.file(join(output, "demo/removed.html")).exists()).toBe(false);
  expect(await Bun.file(join(output, ".hometruth-demo-export.json")).text()).toBe(manifest);
  expect(await readdir(installation)).toEqual(["export"]);
});

test("failed generation and overlapping runs preserve the previous successful output", async () => {
  const source = await directory(), installation = await directory();
  const output = join(installation, "export");
  await writeDemoOutput(source, output, async path => { await Bun.write(join(path, "demo/index.html"), "original"); });
  await expect(writeDemoOutput(source, output, async path => {
    await Bun.write(join(path, "demo/index.html"), "partial"); throw new Error("build failed");
  })).rejects.toThrow("build failed");
  expect(await Bun.file(join(output, "demo/index.html")).text()).toBe("original");
  expect(await readdir(installation)).toEqual(["export"]);
  await mkdir(`${output}.lock`);
  await expect(writeDemoOutput(source, output, async () => {})).rejects.toThrow("Another export");
  expect(await Bun.file(join(output, "demo/index.html")).text()).toBe("original");
});

test("edited, unexpected, and symlinked files cannot be silently overwritten", async () => {
  const source = await directory(), installation = await directory();
  for (const mode of ["edited", "unexpected", "symlink"]) {
    const output = join(installation, mode);
    await writeDemoOutput(source, output, async path => { await Bun.write(join(path, "demo/index.html"), "original"); });
    if (mode === "edited") await Bun.write(join(output, "demo/index.html"), "user edit");
    if (mode === "unexpected") await Bun.write(join(output, "notes.txt"), "user notes");
    if (mode === "symlink") await symlink(source, join(output, "alias"));
    let generated = false;
    await expect(writeDemoOutput(source, output, async () => { generated = true; })).rejects.toThrow();
    expect(generated).toBe(false);
    expect(await Bun.file(join(output, "demo/index.html")).text()).toBe(mode === "edited" ? "user edit" : "original");
  }
});

test("installation command exports without starting a server", async () => {
  const root = await directory();
  await Bun.write(join(root, "site.json"), JSON.stringify({ environment: {} }));
  await Bun.write(join(root, "devices.yml"), "schemaVersion: 2\ndevices: []\n");
  const command = await siteCommand(root, "demo:export", ["--output", "demo"]);
  expect(command.cwd).toBe(root);
  expect(command.argv.slice(-3)).toEqual([join(import.meta.dir, "demo-export.ts"), "--output", "demo"]);
});
