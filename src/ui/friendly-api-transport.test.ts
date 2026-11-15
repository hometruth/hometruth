import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import type { ApiAddressMappings } from "../element-api/address-paths";
import { CompositeDevice } from "../kindle/test-fixture";
import { Site, type RegisteredDevice } from "../site";
import { renderDeviceSettingsPage } from "./device-settings-page";
import { renderPrimitive } from "./kindle-widget";
import { renderEventList } from "./services-page";
import { CLIENT_RUNTIME, renderPage } from "./shell";
import { renderDeviceSwitchDefinition, renderGroupSwitchDefinition } from "./switch-definition";
import { renderTagsPage } from "./tags-page";
import { testPageContext } from "./test-context";

const addresses: ApiAddressMappings = {
  devices: { "switch-17": "exhaust-fan", "camera-9": "porch-camera", "exhaust-fan": "desk-lamp" },
  groups: { "group-8": "upstairs-lights" }, services: { mqtt: "message-broker" },
  elements: { opaque: "switches" }, tags: { "tag-2": "office" },
  stateNodes: { "device/switch-17": "exhaust-fan" },
};

function runtime(mappings?: ApiAddressMappings) {
  const requests: { url: string; init: RequestInit }[] = [];
  const window = { addEventListener() {}, ht: undefined as unknown as { apiPath(path: string): string; request(path: string, init?: RequestInit): Promise<unknown> } };
  runInNewContext(CLIENT_RUNTIME, {
    document: {
      documentElement: { lang: "en" },
      getElementById: (id: string) => id === "ht-api-addresses" && mappings ? { textContent: JSON.stringify(mappings) } : null,
      querySelector: () => null, addEventListener() {},
    },
    window, HTMLFormElement: class {}, URLSearchParams,
    fetch: async (url: string, init: RequestInit) => { requests.push({ url, init }); return { ok: true, json: async () => ({ ok: true }) }; },
  });
  return { ht: window.ht, requests };
}

test("the shared browser request maps internal identities exactly once and preserves request data", async () => {
  const { ht, requests } = runtime(addresses);
  const body = JSON.stringify({ value: "on" });
  expect(await ht.request("/api/devices/switch-17/capabilities/binarySwitch/controls/turnOn", { method: "POST", body })).toEqual({ ok: true });
  expect(requests[0]).toMatchObject({ url: "/api/devices/exhaust-fan/capabilities/binarySwitch/controls/turnOn", init: { method: "POST", body, credentials: "same-origin" } });
  expect(ht.apiPath("/api/cameras/camera-9/snapshot?t=123")).toBe("/api/cameras/porch-camera/snapshot?t=123");
  await ht.request("/api/devices/exhaust-fan");
  expect(requests[1]?.url).toBe("/api/devices/desk-lamp");
});

test("bare pages can make authentication requests without a device address map", async () => {
  const { ht, requests } = runtime();
  await ht.request("/api/auth/sign-in", { method: "POST", body: "{}" });
  expect(requests[0]?.url).toBe("/api/auth/sign-in");
});

test("rendered API links and event images expose friendly paths", () => {
  const ctx = testPageContext({ apiAddresses: addresses });
  const device: RegisteredDevice = {
    id: "switch-17", name: "Exhaust Fan", kind: "binary-switch", model: "test-relay", modelTitle: "Test relay",
    capabilities: ["binarySwitch"], host: "192.0.2.17", page: "/switches/exhaust-fan", schemaId: "https://hometruth.ai/schemas/binary-switch", enabled: true,
  };
  expect(renderDeviceSettingsPage({ ctx, device })).toContain('href="/api/devices/exhaust-fan">/api/devices/exhaust-fan</a>');
  const photo = "a".repeat(64);
  const html = renderEventList(ctx, [{ at: "2026-01-01T00:00:00Z", level: "info", type: "photo_labeled", message: "Photo reviewed", subject: "camera-9", data: { source: "reveal", photoId: photo } }]);
  expect(html).toContain(`src="/api/cameras/porch-camera/photos/${photo}"`);
  expect(html).toContain(`href="/api/cameras/porch-camera/photos/${photo}"`);
  const page = renderPage({ ctx, title: "Test", body: "" });
  const embedded = JSON.parse(page.match(/id="ht-api-addresses"[^>]*>(.*?)<\/script>/s)![1]!);
  expect(embedded).toEqual(addresses);
});

test("the elements catalog uses the same friendly links before and after browser filtering", () => {
  const html = renderTagsPage(testPageContext({ apiAddresses: addresses }), "elements", undefined, {
    tags: [], elements: [{ key: "opaque", name: "Switches", kind: "catalog", context: "", page: "/elements/switches", tagIds: [] }],
  });
  expect(html).toContain('href="/elements/switches"');
  const seed = JSON.parse(html.match(/data-tag-data>(.*?)<\/script>/s)![1]!);
  expect(seed.elements[0].page).toBe("/elements/switches");
});

test("Kindle controls preserve supplied public URLs and format model-derived URLs once", () => {
  const ctx = testPageContext({ apiAddresses: addresses });
  const primitive = {
    capability: "binarySwitch" as const, label: "Switch", availability: "online" as const, detail: "Off",
    actions: [{ capability: "binarySwitch" as const, control: "turnOn", label: "On" }],
  };
  const row = { deviceId: "switch-17", label: "Exhaust Fan", room: "", model: "Relay", availability: "online" as const, primitives: [primitive], missing: false };
  const path = "/api/devices/exhaust-fan/capabilities/binarySwitch/controls/turnOn";
  expect(renderPrimitive(ctx, row, primitive)).toContain(`data-kindle-action="${path}"`);
  expect(renderPrimitive(ctx, row, { ...primitive, actions: [{ ...primitive.actions[0]!, url: path }] })).toContain(`data-kindle-action="${path}"`);
});

test("copyable device and group switch definitions use friendly REST paths", () => {
  const ctx = testPageContext({ apiAddresses: addresses });
  const device = new CompositeDevice("switch-17", "Exhaust Fan");
  const group = { id: "group-8", name: "Upstairs Lights", members: [device.id] };
  const site = new Site([device], undefined, undefined, undefined, undefined, undefined, [group]);
  const deviceHtml = renderDeviceSwitchDefinition(ctx, site, device);
  expect(deviceHtml).toContain("POST /api/switches/exhaust-fan/turn-on {}");
  expect(deviceHtml).toContain("GET /api/switches/exhaust-fan/state");
  const groupHtml = renderGroupSwitchDefinition(ctx, site, group);
  expect(groupHtml).toContain("POST /api/device-groups/upstairs-lights/switch/turn-on {}");
  expect(groupHtml).toContain("GET /api/device-groups/upstairs-lights/switch");
});
