import { describe, expect, test } from "bun:test";
import type { RegisteredDevice } from "../site";
import { binarySwitchSchema, cameraSchema, irRfBlasterDeviceSchema } from "../schemas";
import type { NodeRecord } from "../state/protocol";
import { renderGroupSwitchPage } from "./group-switch-page";
import { HOME_API, renderHomePage } from "./home";
import { renderSwitchPage } from "./switch-page";
import { SWITCH_API } from "./switch-definition";
import { renderSwitchesPage } from "./switches-page";
import { IR_RF_BLASTER_API, renderIrRfBlasterPage } from "./ir-rf-blaster-page";
import { testPageContext } from "./test-context";
import type { PageContext } from "./shell";

/** A page context whose graph holds the given records; `asked` collects the node lists pages snapshot. */
function seededContext(records: readonly NodeRecord[], asked: string[][] = []): PageContext {
  return { ...testPageContext(), state: { snapshot: (nodes) => { asked.push([...nodes]); return records.filter((record) => nodes.includes(record.node)); } } };
}

const relayRecord: NodeRecord = {
  node: "device/relay/one",
  version: 3,
  value: { id: "relay/one", name: "Porch relay", status: "online", capabilities: { binarySwitch: { id: "relay/one", state: { availability: "online", value: "on" }, actions: { turnOn: {}, turnOff: {}, toggle: {}, getState: {} } } } },
  observedAt: "2026-09-14T10:00:00.000Z",
  updatedAt: "2026-09-14T10:00:00.000Z",
};

const relay: RegisteredDevice = {
  id: "relay/one",
  name: 'Porch <relay> "one"',
  kind: "binary-switch",
  model: "shelly-plus-1",
  modelTitle: "Shelly Plus 1",
  capabilities: ["binarySwitch"],
  host: "10.77.0.228",
  page: "/devices/relay%2Fone",
  schemaId: binarySwitchSchema.$id,
  enabled: true,
};

const camera: RegisteredDevice = {
  id: "kitchen",
  name: "Kitchen pet camera",
  kind: "pet-camera",
  model: "tkenpro-2k-pet-camera-treat-dispenser",
  modelTitle: "TKENPRO 2K Pet Camera Treat Dispenser",
  capabilities: ["camera", "treatDispenser", "motionSensor"],
  host: "10.77.0.147",
  page: "/devices/kitchen",
  schemaId: cameraSchema.$id,
  enabled: true,
};

const blaster: RegisteredDevice = {
  id: "blaster",
  name: "Living room blaster",
  kind: "ir-rf-blaster",
  model: "broadlink-rm4-pro",
  modelTitle: "Broadlink RM4 Pro",
  capabilities: ["infraredBlaster", "radioFrequencyBlaster"],
  host: "10.77.0.30",
  page: "/devices/blaster",
  schemaId: irRfBlasterDeviceSchema.$id,
  enabled: true,
};

describe("home page", () => {
  test("lists every configured device as a link to its page, escaped and nonce-protected", () => {
    const html = renderHomePage({ ctx: testPageContext({ nonce: 'n"once' }), devices: [camera, relay] });
    expect(html).toContain('<style id="ht-css" nonce="n&quot;once">');
    expect(html).toContain('<script nonce="n&quot;once">');
    expect(html).toContain('<script type="application/json" id="ht-state" nonce="n&quot;once">[]</script>');
    expect(html).toContain('<script type="module" nonce="n&quot;once" src="/ui/dev/themes/euclid/index.ts"></script>');
    expect(html).toContain('href="/devices/kitchen"');
    expect(html).toContain('href="/devices/relay%2Fone"');
    expect(html).toContain("Porch &lt;relay&gt; &quot;one&quot;");
    expect(html).not.toContain("<relay>");
    expect(html).toContain("TKENPRO 2K Pet Camera Treat Dispenser");
    expect(html).toContain("Shelly Plus 1");
    expect(html).toContain("10.77.0.147");
    expect(html.indexOf("Kitchen pet camera")).toBeLessThan(html.indexOf("Porch"));
  });

  test("gives every row cached status before the element upgrades", () => {
    const asked: string[][] = [];
    const html = renderHomePage({ ctx: seededContext([relayRecord], asked), devices: [camera, relay] });
    expect(html).toContain('<ht-status node="device/kitchen"><div data-state-snapshot');
    expect(html).toContain('<ht-status node="device/relay/one"><div data-state-snapshot');
    expect(asked.at(-1)).toEqual(["device/kitchen", "device/relay/one"]);
    expect(html).toContain(`<script type="application/json" id="ht-state" nonce="test-nonce">${JSON.stringify([relayRecord])}</script>`);
    expect(html).not.toContain("/api/devices");
    expect(html).not.toContain("ht:devices-changed");
    expect(HOME_API).toEqual({ rescan: "/api/network/rescan" });
  });

  test("groups devices under their rooms when any device has one", () => {
    const html = renderHomePage({ ctx: testPageContext(), devices: [{ ...camera, room: "Kitchen" }, relay] });
    expect(html).toContain("<h2>Kitchen</h2>");
    expect(html).toContain("<h2>No room</h2>");
    expect(html.indexOf("Kitchen pet camera")).toBeLessThan(html.indexOf("Porch"));
  });

  test("explains how to define devices when none are configured", () => {
    const html = renderHomePage({ ctx: testPageContext(), devices: [] });
    expect(html).toContain("devices.yml");
    expect(html).not.toContain('class="row"');
  });

  test("renders the shell in the chosen theme, scheme, and language with the preferences form", () => {
    const html = renderHomePage({ ctx: testPageContext({ locale: "de", path: "/x" }), devices: [] });
    expect(html).toContain('<html lang="de" dir="ltr" data-theme="euclid" data-scheme="auto">');
    expect(html).toContain('action="/ui/preferences"');
    expect(html).toContain('name="return" value="/x"');
    expect(html).toContain('<option value="de" selected>Deutsch</option>');
    expect(html).toContain('<option value="euclid" selected>');
  });
});

describe("switch page", () => {
  test("renders one ht-switch bound to the device node and no page script of its own", () => {
    const html = renderSwitchPage({ ctx: testPageContext(), device: relay });
    expect(html).toContain("<title>Porch &lt;relay&gt; &quot;one&quot; · HomeTruth</title>");
    expect(html).toContain('<main data-switch-page data-device-id="relay/one">');
    expect(html).toContain('<ht-switch node="device/relay/one"><div data-state-snapshot');
    expect(html).toContain('<script type="application/json" id="ht-state" nonce="test-nonce">[]</script>');
    expect(html).toContain('<script type="module" nonce="test-nonce" src="/ui/dev/themes/euclid/index.ts"></script>');
    expect(html).not.toContain("data-action");
    expect(html).not.toContain("data-api");
    expect(html).not.toContain("/api/switches");
    expect(html).toContain('href="/devices"');
    expect(html).toContain('href="/devices/relay%2Fone/log"');
    expect(html).toContain('href="/devices/relay%2Fone/settings"');
    for (const key of ["switch.turningOn", "grouping.mixed", "state.stale", "summary.ready"]) expect(html).toContain(`"${key}"`);
  });

  test("embeds the node's cached record so the element paints real state before the stream connects", () => {
    const asked: string[][] = [];
    const html = renderSwitchPage({ ctx: seededContext([relayRecord], asked), device: relay });
    expect(asked.at(-1)).toEqual(["device/relay/one"]);
    expect(html).toContain(`id="ht-state" nonce="test-nonce">${JSON.stringify([relayRecord])}</script>`);
  });

  test("the settings view shows the details in place of the element and asks the graph for nothing", () => {
    const asked: string[][] = [];
    const html = renderSwitchPage({ ctx: seededContext([relayRecord], asked), device: relay, settingsView: true, details: "<section data-details>Definition</section>" });
    expect(html).not.toContain("<ht-switch");
    expect(html).toContain("<section data-details>Definition</section>");
    expect(asked).toEqual([[]]);
  });

  test("the definition quotes the per-switch routes, which stay for the CLI and the Matter bridge", () => {
    expect(Object.values(SWITCH_API).every((route) => route.startsWith("/api/switches/:id"))).toBe(true);
  });
});

describe("group switch page", () => {
  const group = { id: "kitchen-lights-a357dc17", name: "Kitchen Lights", members: ["relay/one"], asSwitch: true, page: "/groups/kitchen-lights", switchPage: "/switches/kitchen-lights" };

  test("binds the same ht-switch to the group node and links the source group and its members", () => {
    const asked: string[][] = [];
    const html = renderGroupSwitchPage({ ctx: seededContext([], asked), group, members: [relay], definition: "<section data-switch-definition>Definition</section>" });
    expect(html).toContain('<ht-switch node="group/kitchen-lights-a357dc17">');
    expect(asked.at(-1)).toEqual(["group/kitchen-lights-a357dc17"]);
    expect(html).toContain('<p data-switch-source>Switch based on group: <a href="/groups/kitchen-lights">Kitchen Lights</a></p>');
    expect(html).toContain('<a href="/devices/relay%2Fone" data-group-member="relay/one">');
    expect(html).not.toContain("data-switch-definition");
    expect(html).not.toContain("switch-gap");
    expect(html).not.toContain("/api/device-groups");
  });

  test("the settings view shows the definition instead of the element", () => {
    const html = renderGroupSwitchPage({ ctx: testPageContext(), group, members: [relay], definition: "<section data-switch-definition>Definition</section>", settingsView: true });
    expect(html).not.toContain("<ht-switch");
    expect(html).toContain("<section data-switch-definition>Definition</section>");
    expect(html).toContain('<a href="/switches/kitchen-lights/settings" aria-current="page">');
  });
});

describe("switches list", () => {
  test("gives each row an ht-switch-row bound to its device or group node and keeps only the builder script", () => {
    const asked: string[][] = [];
    const group = { id: "kitchen-lights-a357dc17", name: "Kitchen Lights", members: ["relay/one"], asSwitch: true };
    const hidden = { id: "no-switch", name: "Just a group", members: ["relay/one"], asSwitch: false };
    const html = renderSwitchesPage({ ctx: seededContext([relayRecord], asked), switches: [relay], buttons: [], canCreate: true, groups: [group, hidden] });
    expect(html).toContain('<li class="row switch-row" data-switch-id="relay/one">');
    expect(html).toContain('<ht-switch-row node="device/relay/one"><div data-state-snapshot');
    expect(html).toContain('<ht-switch-row node="group/kitchen-lights-a357dc17">');
    expect(html).not.toContain("no-switch");
    expect(asked.at(-1)).toEqual(["device/relay/one", "group/kitchen-lights-a357dc17"]);
    expect(html).toContain(`id="ht-state" nonce="test-nonce">${JSON.stringify([relayRecord])}</script>`);
    expect(html).toContain('<a class="btn btn-small" href="/devices/relay%2Fone/settings#switch-definition">Settings</a>');
    expect(html).toContain('<a class="btn btn-small" href="/switches/kitchen-lights/settings">Settings</a>');
    expect(html).not.toContain("data-switch-action");
    expect(html).not.toContain("data-switch-endpoint");
    expect(html).not.toContain("data-switch-state");
    expect(html).not.toContain("/api/switches/");
    expect(html).toContain("data-switch-builder");
  });
});

describe("IR/RF blaster page", () => {
  test("offers a hold in seconds for ad-hoc sends that defaults to sending once", () => {
    const html = renderIrRfBlasterPage({ ctx: testPageContext(), device: blaster });
    expect(html).toContain('data-device-id="blaster"');
    expect(html).toContain('data-hold-max-seconds="60"');
    expect(html).toMatch(/<input type="number" class="num" id="send-duration" step="0.1" min="0" max="60" value="0">/u);
    expect(html).toContain("Hold (seconds)");
    expect(html).toContain("Set default");
    const api = JSON.parse(/data-api="([^"]+)"/u.exec(html)?.[1]?.replaceAll("&quot;", '"') ?? "{}") as Record<string, string>;
    expect(api).toEqual(IR_RF_BLASTER_API);
    expect(api.updateCode).toBe("/api/ir-rf-blasters/:id/codes/:codeId/update");
  });
});
