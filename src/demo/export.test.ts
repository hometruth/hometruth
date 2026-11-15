import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createDemoSnapshot, demoBasePath, DEMO_SNAPSHOT_TIME } from "./model";
import { exportDemo, renderDemoPages } from "./export";
import { MODELS } from "../registry";
import { validators } from "../validation";
import type { DevicesConfig } from "../schemas";

const config: DevicesConfig = { schemaVersion: 2, rooms: ["Personal Room"], devices: [
  { id: "secret-id", name: "Personal lamp", room: "Personal Room", model: "hue-light", config: { host: "192.0.2.99", lightId: "private-light-uuid" } },
  { id: "secret-switch", name: "Personal switch", room: "Personal Room", model: "shelly-plus-1", config: { host: "192.0.2.100" } },
], deviceGroups: [{ id: "personal-group", name: "Private group", asSwitch: true, criteria: { room: "Personal Room" } }] };

test("demo projection preserves layout and capabilities without copying private configuration or identifiers", () => {
  const snapshot = createDemoSnapshot(config, { now: "2026-01-01T00:00:00.000Z" });
  expect(snapshot.devices).toHaveLength(2);
  expect(snapshot.devices[0]?.room).toBe("Room 1");
  expect(snapshot.groups[0]?.members).toEqual(["demo-device-1", "demo-device-2"]);
  const text = JSON.stringify(snapshot);
  for (const privateValue of ["secret-id", "Personal", "Private", "192.0.2.", "private-light-uuid", "personal-group"]) expect(text).not.toContain(privateValue);
  const light = snapshot.records[0]!.value as { capabilities: { light: unknown } };
  expect(validators.light(light.capabilities.light)).toBe(true);
  const relay = snapshot.records[1]!.value as { capabilities: { binarySwitch: unknown } };
  expect(validators.binarySwitch(relay.capabilities.binarySwitch)).toBe(true);
  expect(createDemoSnapshot(config, { includeNames: true }).devices[0]?.name).toBe("Personal lamp");
  expect(() => demoBasePath("/demo/../../private")).toThrow();
});

test("every registered model renders without creating a device or contacting a service", async () => {
  const snapshot = createDemoSnapshot({ schemaVersion: 2, devices: MODELS.map((model, index) => ({ id: `fixture-${index}`, model: model.id, config: {} })) });
  for (const record of snapshot.records) expect(validators.homeTruthObject(record.value), record.node).toBe(true);
  const pages = await renderDemoPages(snapshot);
  for (const device of snapshot.devices) expect(pages.get(device.page)).toContain(device.name);
  expect(pages.get("/graph")).toContain("graph-card");
});

test("static graph includes every device even when one room exceeds the live graph display cap", async () => {
  const snapshot = createDemoSnapshot({ schemaVersion: 2, devices: Array.from({ length: 100 }, (_, index) => ({ id: `fixture-${index}`, model: "shelly-plus-1", config: {}, ...(index < 75 ? { room: "Large Room" } : {}) })) });
  const pages = await renderDemoPages(snapshot);
  const cards = [...pages.get("/graph")!.matchAll(/class="graph-card"/g)];
  expect(cards).toHaveLength(100);
  expect(snapshot.graphScene?.nodes).toHaveLength(100);
  expect(snapshot.graphScene?.omitted).toBe(0);
  expect(snapshot.graphScene?.groups.map(group => group.total)).toEqual([75, 25]);
  expect(snapshot.graphScene?.groups.every(group => group.hidden === 0)).toBe(true);
  expect(snapshot.graphScene?.nodes.map(node => node.node.name)).toContain("Shelly Plus 1 100");
});

test("export contains portable pages, local bundles, and a transport-blocking policy", async () => {
  const output = await mkdtemp(join(tmpdir(), "hometruth-demo-export-"));
  try {
    const result = await exportDemo({ config, output, basePath: "/demo" });
    const html = await Bun.file(join(output, "demo/index.html")).text();
    expect(html).toContain('href="/demo/groups/group-1.html"');
    expect(html).toContain('id="ht-demo"');
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("form-action 'none'");
    expect(html).toContain("Static demo · Euclid · English");
    expect(html).not.toMatch(/<form\b[^>]*data-preferences/);
    expect(html.indexOf('src="/demo/assets/demo.js"')).toBeLessThan(html.indexOf("window.ht ="));
    expect(result.files.every(file => file.startsWith("/demo/"))).toBe(true);
    for (const file of result.files) if (file.endsWith(".html")) {
      const text = await Bun.file(join(output, file)).text();
      expect(text).not.toContain("192.0.2.");
      expect(text).not.toContain("secret-id");
      for (const [, href] of text.matchAll(/<a\b[^>]*href="(\/[^"?#]+)[^"]*"/g)) {
        const target = href === "/demo" ? "demo/index.html" : href!.slice(1);
        expect(await Bun.file(join(output, target)).exists(), href).toBe(true);
      }
    }
  } finally { await rm(output, { recursive: true, force: true }); }
});

async function exportedFiles(directory: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    files.push(...entry.isDirectory() ? await exportedFiles(directory, path) : [path]);
  }
  return files.sort();
}

test("exports are byte-identical across clocks, randomness, output directories, timezones, and build environment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hometruth-demo-repeatable-"));
  const exportModule = pathToFileURL(resolve(import.meta.dir, "export.ts")).href;
  const populated: DevicesConfig = {
    schemaVersion: 2,
    // Different collation rules must not change the order of these room sections.
    rooms: ["Ä room", "Z room", "a room"],
    devices: MODELS.map((model, index) => ({ id: `fixture-${index}`, model: model.id, name: `Fixture ${index}`, room: ["Ä room", "Z room", "a room"][index % 3]!, config: {} })),
    deviceGroups: [{ id: "fixture-group", name: "Fixture group", asSwitch: true, criteria: { room: "Ä room" } }],
  };
  try {
    for (const [name, fixture] of Object.entries({ populated, empty: { schemaVersion: 2, devices: [] } satisfies DevicesConfig })) {
      const outputs: string[] = [];
      for (const [index, environment] of [
        { at: "1999-12-31T23:59:50.000Z", random: 0.1, TZ: "America/Los_Angeles", LANG: "en_US.UTF-8", NODE_ENV: "development", HOMETRUTH_RELOAD_VERSION: "" },
        { at: "2040-07-01T18:30:00.000Z", random: 0.9, TZ: "Asia/Tokyo", LANG: "sv_SE.UTF-8", NODE_ENV: "production", HOMETRUTH_RELOAD_VERSION: "unrelated-live-runtime" },
      ].entries()) {
        const output = join(directory, `${name}-${index}`);
        outputs.push(output);
        // Isolate fake globals and locale initialization from the rest of the test suite.
        const source = `
          const RealDate = Date;
          const at = RealDate.parse(${JSON.stringify(environment.at)});
          globalThis.Date = class extends RealDate {
            constructor(...args) { if (args.length) super(...args); else super(at); }
            static now() { return at; }
          };
          Math.random = () => ${environment.random};
          const { exportDemo } = await import(${JSON.stringify(exportModule)});
          const result = await exportDemo({config:${JSON.stringify(fixture)},output:${JSON.stringify(output)},basePath:'/play/demo',includeNames:true});
          if (result.snapshot.graph.generatedAt !== ${JSON.stringify(DEMO_SNAPSHOT_TIME)}) throw new Error('Snapshot time was not fixed');
        `;
        const child = Bun.spawn([process.execPath, "--eval", source], {
          cwd: resolve(import.meta.dir, "../.."),
          env: { ...process.env, TZ: environment.TZ, LANG: environment.LANG, LC_ALL: environment.LANG, NODE_ENV: environment.NODE_ENV, HOMETRUTH_RELOAD_VERSION: environment.HOMETRUTH_RELOAD_VERSION },
          stdout: "pipe", stderr: "pipe",
        });
        const [exitCode, errors] = await Promise.all([child.exited, new Response(child.stderr).text()]);
        expect(exitCode, errors).toBe(0);
      }
      const [first, second] = outputs as [string, string];
      const files = await exportedFiles(first);
      expect(files.length).toBeGreaterThan(0);
      expect(await exportedFiles(second)).toEqual(files);
      for (const file of files) {
        const a = await Bun.file(join(first, file)).arrayBuffer();
        const b = await Bun.file(join(second, file)).arrayBuffer();
        expect(Buffer.from(a).equals(Buffer.from(b)), `${name}: ${file}`).toBe(true);
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 60_000);
