import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { TokenStore } from "../auth/store";
import { CompositeDevice } from "../kindle/test-fixture";
import { createApp } from "../server/app";
import { Site } from "../site";
import { StateHub } from "../state/hub";
import { TagStore } from "../tags/store";

test("the public CLI download runs alone while friendly-address reads still require authorization", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hometruth-cli-download-"));
  const cwd = join(directory, "client");
  await mkdir(cwd);
  const executable = join(directory, "ht");
  const device = new CompositeDevice("stored-switch-id", "Example Relay");
  const site = new Site([device]), hub = new StateHub(), tags = new TagStore(), tokens = new TokenStore();
  const app = createApp(undefined, site, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, tags, hub, tokens);
  hub.observer.publish(device.id, await device.describe());
  const token = tokens.issue({ name: "Synthetic CLI reader", permissions: ["read"], subject: { device: device.id } }).token;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  try {
    const download = await fetch(new URL("/ht-cli.js", server.url));
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toContain("text/javascript");
    expect(download.headers.get("content-disposition")).toBe('attachment; filename="ht-cli.js"');
    const source = await download.text();
    expect(source.startsWith("#!/usr/bin/env bun\n")).toBe(true);
    expect(source).not.toContain(token);
    expect(source).not.toContain(device.name);
    expect(source).not.toContain(resolve(import.meta.dir, "../.."));
    expect(source).not.toContain("sourceMappingURL");
    await Bun.write(executable, source);
    await chmod(executable, 0o755);

    const run = async (args: string[], authenticated = true) => {
      const child = Bun.spawn([executable, ...args], {
        cwd,
        env: {
          PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
          HOMETRUTH_URL: server.url.toString(),
          ...(authenticated ? { HOMETRUTH_TOKEN: token } : {}),
        },
        stdout: "pipe", stderr: "pipe",
      });
      const timeout = setTimeout(() => child.kill(), 10_000);
      try {
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
        ]);
        return { exitCode, stdout, stderr };
      } finally { clearTimeout(timeout); }
    };

    const help = await run(["--help"], false);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("ht — the HomeTruth client");
    expect(help.stderr).toBe("");

    expect((await fetch(new URL("/api/inventory/example-relay", server.url))).status).toBe(401);
    const refused = await run(["example-relay", "status", "--json"], false);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("401");

    const commands = await run(["example-relay", "help"]);
    expect(commands.exitCode).toBe(0);
    expect(commands.stderr).toBe("");
    expect(commands.stdout).toContain("ht example-relay status");

    const status = await run(["example-relay", "status", "--json"]);
    expect(status.exitCode).toBe(0);
    expect(status.stderr).toBe("");
    expect(JSON.parse(status.stdout)).toMatchObject({ id: device.relay.id, state: { availability: "online", value: "off" } });
    const element = await run(["example-relay", "--json"]);
    expect(element.exitCode).toBe(0);
    expect(element.stderr).toBe("");
    expect(JSON.parse(element.stdout)).toMatchObject({ id: device.id, name: device.name });
    expect(device.relay.writes).toBe(0);
    expect(await readdir(cwd)).toEqual([]);
    expect((await readdir(directory)).sort()).toEqual(["client", "ht"]);
  } finally {
    await server.stop(true);
    hub.stop();
    tags.close();
    tokens.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
