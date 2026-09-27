import { observedKindleState } from "./test-fixture";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Site } from "../site";
import { createApp } from "../server/app";
import { createTranslator } from "../ui/i18n";
import { testPageContext } from "../ui/test-context";
import { rasterLayoutCss, renderRasterCanvas } from "../ui/kindle-raster";
import { DEFAULT_KINDLE_CONFIG, parseKindleConfig, type DeviceWidget } from "./config";
import { canvasDraft } from "./canvas";
import { FileKindleConfigStore, MemoryKindleConfigStore } from "./store";
import { CompositeDevice } from "./test-fixture";
import { buildKindleSnapshot } from "./presentation";

const device = new CompositeDevice();
const site = new Site([device]);
const draft = () => canvasDraft(DEFAULT_KINDLE_CONFIG, site.list());

test("canvas validation preserves legacy settings and checks IDs and bounds", () => {
  expect(parseKindleConfig(DEFAULT_KINDLE_CONFIG)).not.toHaveProperty("canvas");
  expect(parseKindleConfig(draft()).canvas?.widgets).toHaveLength(4);
  const duplicate = draft(); duplicate.canvas.widgets.push({ ...duplicate.canvas.widgets[0]! });
  expect(() => parseKindleConfig(duplicate)).toThrow("unique");
  const outside = draft(); outside.canvas.widgets[0]!.x = outside.canvas.width;
  expect(() => parseKindleConfig(outside)).toThrow("inside");
  const script = draft(); script.canvas.widgets[0]!.id = 'x;body{color:red}';
  expect(() => parseKindleConfig(script)).toThrow();
  const tiny = draft(); const widget = tiny.canvas.widgets.find(w => w.kind === "device")!; widget.width = 10;
  expect(() => parseKindleConfig(tiny)).toThrow();
});

test("canvas draft preview uses shared geometry, escapes text, and never saves or invokes devices", async () => {
  const store = new MemoryKindleConfigStore();
  const app = createApp(undefined, site, undefined, undefined, undefined, undefined, undefined, undefined, undefined, store);
  const before = await store.load();
  const config = draft(); const text = config.canvas.widgets.find(w => w.kind === "text")!;
  text.text = '<img src=x onerror="attack()">'; text.x = 32;
  const response = await app.request("/api/kindle/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(config) });
  expect(response.status).toBe(200);
  const preview = await response.json();
  expect(preview.html).toContain("&lt;img"); expect(preview.html).not.toContain("<img src=x");
  expect(preview.css).toContain("#canvas-widget-heading{left:32px;");
  expect(preview.html).toContain('disabled data-kindle-action');
  const image = await app.request(preview.frame.imageUrl);
  expect(image.headers.get("content-type")).toBe("image/png");
  const png = Buffer.from(await image.arrayBuffer());
  expect(png.readUInt32BE(16)).toBe(config.canvas.width);
  expect(png.readUInt32BE(20)).toBe(config.canvas.height);
  expect(await store.load()).toEqual(before);
  expect(device.relay.writes + device.button.presses).toBe(0);
  expect(preview.html).toBe(renderRasterCanvas(config.canvas, preview.frame));
  expect(preview.css).toBe(rasterLayoutCss(config.canvas, preview.frame));
  const crossOrigin = await app.request("/api/kindle/preview", { method: "POST", headers: { "content-type": "application/json", origin: "https://elsewhere.test" }, body: JSON.stringify(config) });
  expect(crossOrigin.status).toBe(403);
});

test("each device widget binds independently while shared devices are only read once", async () => {
  const config = draft(); const widget = config.canvas.widgets.find(w => w.kind === "device") as DeviceWidget;
  config.canvas.widgets = [widget, { ...widget, id: "button-copy", capability: "button", mode: "status" }];
  let reads = 0;
  const snapshot = await buildKindleSnapshot(site, config, await observedKindleState(site), createTranslator("en"));
  expect(reads).toBe(0);
  expect(snapshot.rows.map(row => row.widgetId)).toEqual([widget.id, "button-copy"]);
  expect(snapshot.rows[1]!.primitives[0]).toMatchObject({ capability: "button", actions: [] });
});

test("canvas positions, dimensions and widget order survive storage reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kindle-canvas-"));
  try {
    const path = join(dir, "settings.json"), store = new FileKindleConfigStore(path), initial = await store.load();
    const config = draft(); config.canvas.widgets.reverse();
    await store.save(config, initial.revision);
    expect((await new FileKindleConfigStore(path).load()).config.canvas).toEqual(config.canvas);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
