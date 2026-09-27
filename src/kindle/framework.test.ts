import { observedKindleState } from "./test-fixture";
import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPABILITY_KINDS } from "../models/capability";
import { Site } from "../site";
import { createApp } from "../server/app";
import { createTranslator } from "../ui/i18n";
import { DEFAULT_KINDLE_CONFIG, kindleConfigSchema, parseKindleConfig, type KindleConfig } from "./config";
import { buildKindleSnapshot } from "./presentation";
import { FileKindleConfigStore, MemoryKindleConfigStore } from "./store";
import { CompositeDevice } from "./test-fixture";

const i18n = createTranslator("en");
const item = (deviceId: string, capability: "auto" | "button" | "binarySwitch" = "auto", mode: "auto" | "status" = "auto") => ({ deviceId, capability, mode, label: "" });
const fixture = (config: KindleConfig = DEFAULT_KINDLE_CONFIG) => {
  const device = new CompositeDevice(); const site = new Site([device]); const store = new MemoryKindleConfigStore(config);
  const app = createApp(undefined, site, undefined, undefined, undefined, undefined, undefined, undefined, undefined, store);
  return { app, device, site, store };
};

describe("Kindle capability framework", () => {
  test("composite views expose cached capability controls without reading a device", async () => {
    const { site, device } = fixture(); let reads = 0;
    const state = await observedKindleState(site);
    device.describe = async () => { reads++; throw new Error("Rendering must not read devices"); };
    const snapshot = await buildKindleSnapshot(site, { ...DEFAULT_KINDLE_CONFIG, selection: "custom", items: [item(device.id), item(device.id, "button"), item(device.id, "binarySwitch", "status")] }, state, i18n);
    expect(reads).toBe(0);
    expect(snapshot.rows[0]!.primitives.map((p) => p.actions.map((a) => `${a.capability}.${a.control}`))).toEqual([["binarySwitch.turnOn", "binarySwitch.turnOff"], ["button.press"], ["light.turnOn", "light.turnOff"]]);
    expect(snapshot.rows[1]!.primitives.map((p) => p.capability)).toEqual(["button"]);
    expect(snapshot.rows[2]!.primitives[0]!.actions).toEqual([]);
    expect(device.relay.writes + device.button.presses).toBe(0);
    expect(JSON.stringify(snapshot)).not.toContain('"host"');
  });
  test("offline and removed devices never invent state or controls", async () => {
    const { site, device } = fixture(); device.relay.offline = true;
    const snapshot = await buildKindleSnapshot(site, { ...DEFAULT_KINDLE_CONFIG, selection: "custom", items: [item(device.id), item("removed")] }, await observedKindleState(site), i18n);
    expect(snapshot.rows[0]!.primitives[0]).toMatchObject({ availability: "offline", detail: "Offline", actions: [] });
    expect(snapshot.rows[0]!.primitives[1]!.actions).toHaveLength(1);
    expect(snapshot.rows[1]).toMatchObject({ missing: true, primitives: [], availability: "unknown" });
  });
  test("controls use existing invocation, update observed state, and record presses", async () => {
    const { app, device } = fixture();
    const invoke = (capability: string, control: string) => app.request(`/api/devices/composite/capabilities/${capability}/controls/${control}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect((await invoke("binarySwitch", "turnOn")).status).toBe(200);
    expect((await invoke("button", "press")).status).toBe(200);
    expect((await invoke("light", "turnOn")).status).toBe(200);
    expect(device.relay.state).toBe("on"); expect(device.relay.writes).toBe(1); expect(device.button.presses).toBe(1); expect(device.light.on).toBe(true);
    const snapshot = await (await app.request("/api/kindle/snapshot")).json();
    expect(snapshot.rows[0].primitives[0].actions[0].pressed).toBe(true);
    expect((await invoke("button", "turnOn")).status).toBe(404);
  });
  test("configuration validates boundaries, conflicts, and origin before saving", async () => {
    const { app, store } = fixture(); const { revision } = await store.load();
    const put = (config: unknown, origin?: string) => app.request("/api/kindle/config", { method: "PUT", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify({ config, revision }) });
    expect((await put({ ...DEFAULT_KINDLE_CONFIG, refreshSeconds: 0 })).status).toBe(400);
    expect((await put(DEFAULT_KINDLE_CONFIG, "https://evil.test")).status).toBe(403);
    expect((await put({ ...DEFAULT_KINDLE_CONFIG, title: "Dashboard" })).status).toBe(200);
    expect((await put(DEFAULT_KINDLE_CONFIG)).status).toBe(409);
    expect((await store.load()).config.title).toBe("Dashboard");
    expect((await app.request("/api/kindle/config", { method: "PUT", body: "{}" })).status).toBe(415);
    expect([...kindleConfigSchema.properties.items.items.properties.capability.enum].sort().join(",")).toBe(["auto", ...CAPABILITY_KINDS].sort().join(","));
    expect(() => parseKindleConfig({ ...DEFAULT_KINDLE_CONFIG, items: [{ ...item("composite"), capability: "madeUp" }] })).toThrow();
  });
  test("only the Kindle view allows same-origin embedding", async () => {
    const { app } = fixture();
    const preview = await app.request("/kindle?preview=1");
    expect(preview.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    expect(preview.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(await preview.text()).toContain('data-preview="1"');
    const settings = await app.request("/kindle/settings");
    expect(settings.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });
});

test("Kindle settings survive reload, serialize competing writes, and preserve corrupt files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kindle-store-")); const path = join(directory, "view.json");
  try {
    const store = new FileKindleConfigStore(path); const { revision } = await store.load();
    const results = await Promise.allSettled([store.save({ ...DEFAULT_KINDLE_CONFIG, title: "First" }, revision), store.save({ ...DEFAULT_KINDLE_CONFIG, title: "Second" }, revision)]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect((await new FileKindleConfigStore(path).load()).config.title).toBe("First");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await writeFile(path, "broken");
    await expect(store.load()).rejects.toThrow();
    await expect(store.save(DEFAULT_KINDLE_CONFIG, revision)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("broken");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
