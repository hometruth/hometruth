import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { siteCommand, siteEnvironment } from "./site";
import { assertCredentialFree } from "../src/config/repository-safety";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hometruth-site-"))); roots.push(root);
  await Bun.write(join(root, "site.json"), JSON.stringify({ environment: { HOST: "127.0.0.1", PORT: "3000" } }));
  await Bun.write(join(root, "devices.yml"), "schemaVersion: 2\ndevices: []\n");
  return root;
}
test("external config paths resolve without starting services", async () => {
  const root = await fixture();
  expect(await siteEnvironment(root)).toEqual({ HOST: "127.0.0.1", PORT: "3000", HOMETRUTH_DEVICES: join(root, "devices.yml") });
});
test("private config rejects credentials, URL credentials and unknown environment variables", async () => {
  for (const value of [{ password: "test-only" }, { nested: { apiKey: "test-only" } }, { url: "rtsp://user:test-only@camera/" }, { url: "https://example.com/?X-Amz-Signature=test-only" }]) expect(() => assertCredentialFree(value)).toThrow();
  expect(() => assertCredentialFree({ passwordEnv: "MQTT_PASSWORD", tokenEnv: "SERVICE_TOKEN" })).not.toThrow();
  expect(() => assertCredentialFree({ passwordEnv: "a credential, not a reference" })).toThrow();
  const root = await fixture();
  await Bun.write(join(root, "site.json"), JSON.stringify({ environment: { NODE_OPTIONS: "--require something" } }));
  await expect(siteEnvironment(root)).rejects.toThrow("Unsupported");
});
test("parsing errors do not echo sensitive file contents", async () => {
  const root = await fixture();
  await Bun.write(join(root, "devices.yml"), "broken: [test-only-do-not-print");
  await expect(siteEnvironment(root)).rejects.toThrow("Invalid devices.yml; file contents are withheld");
});

test("installation checks validate the public proxy origin before a server starts", async () => {
  const root = await fixture();
  await Bun.write(join(root, "site.json"), JSON.stringify({ environment: { HOMETRUTH_PUBLIC_ORIGIN: "https://control.example.test" } }));
  expect((await siteEnvironment(root)).HOMETRUTH_PUBLIC_ORIGIN).toBe("https://control.example.test");
  await Bun.write(join(root, "site.json"), JSON.stringify({ environment: { HOMETRUTH_PUBLIC_ORIGIN: "https://control.example.test/path" } }));
  await expect(siteEnvironment(root)).rejects.toThrow("HOMETRUTH_PUBLIC_ORIGIN");
});
test("symlinked configuration cannot pull a secret file into an export", async () => {
  const root = await fixture();
  await rm(join(root, "devices.yml"));
  await symlink(join(root, "site.json"), join(root, "devices.yml"));
  await expect(siteEnvironment(root)).rejects.toThrow("symlink");
});
test("launch requests use private cwd and absolute public entry points without starting services", async () => {
  const root = await fixture();
  const source = join(import.meta.dir, "..");
  const launch = await siteCommand(root, "dev");
  expect(launch.cwd).toBe(root);
  expect(launch.argv).toEqual([process.execPath, join(source, "src/index.ts"), "--watch"]);
  expect(launch.env.HOMETRUTH_DEVICES).toBe(join(launch.cwd, "devices.yml"));
  const cli = await siteCommand(root, "ht", ["secrets", "get", "example"]);
  expect(cli.cwd).toBe(launch.cwd);
  expect(cli.argv.slice(1)).toEqual([join(source, "src/ht/index.ts"), "secrets", "get", "example"]);
});
test("source checkout cannot serve as an installation", async () => {
  await expect(siteEnvironment(join(import.meta.dir, ".."))).rejects.toThrow("outside the source");
});
test("Bun loads private environment files when an absolute external script uses private cwd", async () => {
  const root = await fixture();
  const other = await fixture();
  await Bun.write(join(root, ".env.local"), "HOMETRUTH_ENV_PROBE=private-installation\n");
  const entry = join(other, "probe.ts");
  await Bun.write(entry, 'process.stdout.write(process.env.HOMETRUTH_ENV_PROBE ?? "missing");');
  const child = Bun.spawn([process.execPath, entry], {
    cwd: root, env: { NODE_ENV: "development", PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe",
  });
  expect(await new Response(child.stdout).text()).toBe("private-installation");
  expect(await child.exited).toBe(0);
});
