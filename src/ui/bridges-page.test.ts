import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { ACCESSORY_PROFILES } from "../bridges/profiles";
import type { AccessoryMapping, BridgeMembership, BridgeProtocol, BridgeStatus, SharedItem } from "../bridges/model";
import { FakeDocument, type FakeElement } from "./browser/test-dom";
import { renderBridgePage, type BridgeCandidate } from "./bridges-page";
import { en } from "./i18n/en";
import { formatMessage } from "./i18n/format";
import { testPageContext } from "./test-context";

const buttonKey = "capability:sample-workflow:button";
const otherButton = "capability:other-workflow:button";
const relayKey = "device:sample-relay";
const lampKey = "device:sample-lamp";
const momentary = (): AccessoryMapping => ({
  id: "sample-trigger", name: "Evening lights", profile: "MomentarySwitch",
  characteristics: { On: { trigger: { element: buttonKey } } },
});
const relayItem = (overrides: Partial<SharedItem["accessories"][number]> = {}): SharedItem => ({
  element: relayKey, name: "Garden relay", room: "Garden", page: "/switches/sample-relay", missing: false, custom: false,
  accessories: [
    { slot: "binarySwitch", id: "relay-switch", name: "Garden relay", automaticName: "Garden relay", profile: "Switch", automaticProfile: "Switch", profiles: ["Lightbulb", "Outlet", "Switch"], hidden: false, ...overrides },
    { slot: "sensor-battery", id: "relay-battery", name: "Relay battery", automaticName: "Relay battery", profile: "Battery", automaticProfile: "Battery", profiles: ["Battery"], hidden: false },
  ],
});

type Interactive = FakeElement & {
  onclick: () => Promise<unknown>; onchange: () => void; oninput: () => void;
  read: () => AccessoryMapping; value: string; checked: boolean; disabled: boolean;
};

interface Options { members?: BridgeMembership[]; items?: SharedItem[]; protocol?: BridgeProtocol; element?: string; candidates?: BridgeCandidate[] }
function harness({ members = [{ element: relayKey, mappings: [] }], items = [relayItem()], protocol = "homekit", element, candidates }: Options = {}) {
  const bridge = { id: "sample-bridge", name: "Sample home", protocol, enabled: true, port: 52100, revision: 3, members };
  const status: BridgeStatus = { running: true, paired: true, updatedAt: "2026-10-17T12:00:00Z", detail: "Paired", accessories: 2, reachable: 2, unreachable: [] };
  const catalog = {
    profiles: ACCESSORY_PROFILES,
    elements: [{ key: buttonKey, name: "Evening lights", kind: "capability", context: "Study", page: "/buttons/evening-lights" }],
    buttons: [{ key: buttonKey, name: "Evening lights" }, { key: otherButton, name: "Reading lights" }],
    sources: [{ key: "property:sample-relay:state", name: "Relay state", path: "/binarySwitch/on" }],
    controls: [{ key: "control:sample-relay:turnOn", name: "Relay on" }],
    cameras: [],
  };
  const list: BridgeCandidate[] = candidates ?? [
    { key: relayKey, name: "Garden relay", context: "Shelly", kind: "device", page: "/switches/sample-relay", room: "Garden", automatic: ["Switch"] },
    { key: "capability:sample-relay:binarySwitch", name: "Relay", context: "Garden relay", kind: "capability", page: "/elements/x", device: relayKey, automatic: ["Switch"] },
    { key: lampKey, name: "Desk lamp", context: "Hue", kind: "device", page: "/lights/sample-lamp", room: "Study", automatic: ["Lightbulb"] },
    { key: buttonKey, name: "Evening lights", context: "Study", kind: "capability", page: "/buttons/evening-lights", automatic: [] },
  ];
  const rendered = renderBridgePage(testPageContext({ admin: true }), { bridge, status, items, candidates: list, catalog });
  const scripts = [...rendered.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]!);
  const script = scripts.flatMap(source => source.match(/\(\(\) => \{\n  const seed = JSON\.parse[\s\S]*?\n  follow\(\);\n\}\)\(\);/) ?? [])[0];
  if (!script) throw new Error("Bridge page script is missing");
  const document = new FakeDocument();
  document.body.innerHTML = rendered.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
  const enhance = (node: FakeElement) => Object.assign(node, {
    scrollIntoView: () => {}, focus: () => {},
    replaceWith: (replacement: FakeElement) => {
      const parent = node.parentNode;
      if (!parent) return;
      parent.replaceChildren(...[...parent.childNodes].filter(child => child !== replacement).map(child => child === node ? replacement : child));
    },
  });
  for (const node of document.querySelectorAll("*")) enhance(node);
  const createElement = document.createElement.bind(document);
  document.createElement = tag => enhance(createElement(tag));
  const seed = document.createElement("script");
  seed.setAttribute("data-bridge-data", "");
  seed.textContent = JSON.stringify({ bridge, status, items, candidates: list, catalog });
  document.body.append(seed);
  const requests: { path: string; method: string; body: Record<string, any> }[] = [];
  let respond = (body: Record<string, any>): unknown => ({ bridge: { ...bridge, revision: bridge.revision + 1 }, items, ...body });
  const streams: { url: string; listeners: Record<string, (event: { data: string }) => void> }[] = [];
  const ht = {
    t: (key: string, params?: Record<string, string | number>) => formatMessage((en as Record<string, string>)[key] ?? key, params),
    apiPath: (path: string) => path,
    say: (element: FakeElement, message: string) => { element.textContent = message; },
    request: async (path: string, options: { method: string; body?: string }) => {
      const body = options.body ? JSON.parse(options.body) : {};
      requests.push({ path, method: options.method, body });
      return respond(body);
    },
  };
  let intervals = 0;
  runInNewContext(script, {
    document, ht, URL,
    location: { href: `https://example.invalid/bridges/sample-bridge${element ? `?element=${encodeURIComponent(element)}` : ""}` },
    window: { addEventListener: () => {} },
    setInterval: () => { intervals++; return 1; }, setTimeout: () => 1,
    EventSource: class { listeners: Record<string, (event: { data: string }) => void> = {}; constructor(readonly url: string) { streams.push(this); } addEventListener(type: string, listener: (event: { data: string }) => void) { this.listeners[type] = listener; } close() {} },
    crypto: { randomUUID: () => "new-sample-mapping" },
  });
  const get = (selector: string) => document.querySelector<Interactive>(selector)!;
  const all = (selector: string) => document.querySelectorAll<Interactive>(selector);
  const buttonNamed = (text: string, scope: FakeElement = document.body) => scope.querySelectorAll<Interactive>("button").find(b => b.textContent === text)!;
  const rows = () => get("[data-shared]").querySelectorAll<Interactive>("tr[data-accessory]");
  return { get, all, rows, buttonNamed, requests, streams, intervals: () => intervals, card: () => get(".bridge-mapping"), setResponse: (fn: typeof respond) => { respond = fn; } };
}

function field(card: FakeElement, title: string): Interactive {
  const label = card.querySelectorAll("label").find(label => label.querySelector("span")?.textContent === title);
  const input = label?.querySelector<Interactive>("input,select,textarea");
  if (!input) throw new Error(`Missing field: ${title}`);
  return input;
}

test("the shared table lists every exported accessory with its Apple Home name and type", () => {
  const view = harness();
  const rows = view.rows();
  expect(rows.map(row => row.querySelector<Interactive>("input")!.value)).toEqual(["Garden relay", "Relay battery"]);
  expect(rows[0]!.querySelector("select")!.querySelectorAll("option").map(o => o.textContent)).toEqual(["Light", "Outlet", "Switch"]);
  expect(rows[1]!.querySelector("select")).toBeNull();
  expect(rows[1]!.textContent).toContain("Battery");
  expect(view.get("[data-shared]").textContent).toContain("Garden · Automatic");
  expect(view.requests).toHaveLength(0);
  expect(view.intervals()).toBe(0);
});

test("renaming, retyping and leaving out automatic accessories save overrides, and clearing a name restores the device's", async () => {
  const view = harness();
  const name = view.rows()[0]!.querySelector<Interactive>("input")!;
  name.value = "  Fountain  ";
  name.onchange();
  await Promise.resolve();
  expect(view.requests.at(-1)).toEqual({ path: `/api/bridges/sample-bridge/members/${encodeURIComponent(relayKey)}`, method: "PUT",
    body: { revision: 3, mappings: [], accessories: { binarySwitch: { name: "Fountain" } } } });

  const type = view.rows()[0]!.querySelector<Interactive>("select")!;
  type.value = "Outlet";
  type.onchange();
  await Promise.resolve();
  expect(view.requests.at(-1)!.body.accessories).toEqual({ binarySwitch: { profile: "Outlet" } });

  await view.buttonNamed("Leave out", view.rows()[1]!).onclick();
  expect(view.requests.at(-1)!.body.accessories).toEqual({ "sensor-battery": { hidden: true } });
});

test("an existing name override is dropped when the field is cleared and the last visible accessory cannot be left out", async () => {
  const members = [{ element: relayKey, mappings: [], accessories: { binarySwitch: { name: "Fountain" }, "sensor-battery": { hidden: true as const }, gone: { name: "Old role" } } }];
  const item = relayItem({ name: "Fountain" });
  item.accessories[1]!.hidden = true;
  const view = harness({ members, items: [item] });
  const [first, second] = view.rows();
  expect(view.buttonNamed("Leave out", first!).disabled).toBe(true);
  expect(second!.textContent).toContain("Left out");
  const name = first!.querySelector<Interactive>("input")!;
  name.value = "";
  name.onchange();
  await Promise.resolve();
  // The stale "gone" role is not written back.
  expect(view.requests.at(-1)!.body.accessories).toEqual({ "sensor-battery": { hidden: true } });
});

test("the add list hides shared items and their capabilities, and adds with automatic settings", async () => {
  const view = harness();
  const names = () => view.get("[data-candidates]").querySelectorAll(".row-name").map(n => n.textContent);
  expect(names()).toEqual(["Desk lamp"]);
  expect(view.get("[data-candidates]").textContent).toContain("Becomes Light");
  view.get("[data-add-all]").checked = true;
  view.get("[data-add-all]").onchange();
  expect(names()).toEqual(["Desk lamp", "Evening lights"]);
  expect(view.get("[data-candidates]").textContent).toContain("Needs a custom mapping");
  view.get("[data-add-search]").value = "study lamp";
  view.get("[data-add-search]").oninput();
  expect(names()).toEqual(["Desk lamp"]);
  await view.buttonNamed("Add", view.get("[data-candidates]")).onclick();
  expect(view.requests).toEqual([{ path: `/api/bridges/sample-bridge/members/${encodeURIComponent(lampKey)}`, method: "PUT", body: { revision: 3, mappings: [] } }]);
});

test("connection state follows the bridge stream and marks accessories without state", () => {
  const view = harness();
  expect(view.streams.map(s => s.url)).toEqual(["/api/bridges/sample-bridge/stream"]);
  expect(view.get("[data-status-text]").textContent).toBe("Paired with Apple Home · 2 of 2 accessories responding");
  view.streams[0]!.listeners.status!({ data: JSON.stringify({ running: true, paired: false, updatedAt: "2026-10-17T12:00:02Z", detail: "Ready", accessories: 2, reachable: 1, unreachable: ["relay-battery"], pairing: { code: "123-45-678", uri: "X-HM://sample" } }) });
  expect(view.get("[data-status-text]").textContent).toBe("Not paired yet · 1 of 2 accessories responding");
  expect(view.get("[data-pairing]").hidden).toBe(false);
  expect(view.get("[data-pairing]").querySelector(".bridge-code")!.textContent).toBe("123-45-678");
  const [first, second] = view.rows();
  expect(first!.dataset.availability).toBeUndefined();
  expect(second!.dataset.availability).toBe("offline");
  expect(second!.textContent).toContain("No response");
  view.streams[0]!.listeners.status!({ data: JSON.stringify({ running: false, paired: false, updatedAt: "2026-10-17T12:00:04Z", detail: "Bridge could not start (Error)", fault: "Bridge could not start (Error)", accessories: 0, reachable: 0 }) });
  expect(view.get("[data-status-text]").textContent).toBe("Stopped: Bridge could not start (Error)");
  expect(view.get("[data-pairing]").hidden).toBe(true);
});

test("a missing item says why and can still be removed", async () => {
  const view = harness({ items: [{ element: relayKey, name: relayKey, missing: true, problem: "An assigned element no longer exists", custom: false, accessories: [] }] });
  expect(view.get("[data-shared]").textContent).toContain("An assigned element no longer exists");
  await view.buttonNamed("Remove").onclick();
  expect(view.requests).toEqual([{ path: `/api/bridges/sample-bridge/members/${encodeURIComponent(relayKey)}`, method: "DELETE", body: { revision: 3 } }]);
});

const customButton = (mappings: AccessoryMapping[], protocol: BridgeProtocol = "homekit") => harness({
  protocol, element: buttonKey, members: [{ element: buttonKey, mappings }],
  items: [{ element: buttonKey, name: "Evening lights", missing: false, custom: true, accessories: mappings.map(m => ({ slot: m.id, id: m.id, name: m.name, automaticName: m.name, profile: m.profile, automaticProfile: m.profile, profiles: [m.profile], hidden: false })) }],
});

test("momentary mappings load and save a single button without operating it", async () => {
  const view = customButton([momentary()]);
  expect(view.requests).toHaveLength(0);
  expect(view.get("[data-mapping-editor]").hidden).toBe(false);
  expect(field(view.card(), "Button").value).toBe(buttonKey);
  expect(field(view.card(), "Button").querySelectorAll("option").map(option => option.textContent)).toEqual(["Choose a button", "Evening lights", "Reading lights"]);
  expect(view.card().querySelectorAll("fieldset")).toHaveLength(0);
  expect(view.card().textContent).toContain("Returning to Off sends nothing to the device.");
  field(view.card(), "Button").value = otherButton;
  await view.get("[data-save-mappings]").onclick();
  expect(view.requests).toEqual([{
    path: `/api/bridges/sample-bridge/members/${encodeURIComponent(buttonKey)}`, method: "PUT",
    body: { revision: 3, mappings: [{ ...momentary(), characteristics: { On: { trigger: { element: otherButton } } } }] },
  }]);
  expect(view.get("[data-shared-feedback]").textContent).toBe("Saved");
});

test("renaming a custom accessory from the shared table keeps its mapping", async () => {
  const view = customButton([momentary()]);
  const name = view.rows()[0]!.querySelector<Interactive>("input")!;
  name.value = "Movie time";
  name.onchange();
  await Promise.resolve();
  expect(view.requests.at(-1)!.body).toEqual({ revision: 3, mappings: [{ ...momentary(), name: "Movie time" }] });
  expect(view.buttonNamed("Leave out")).toBeUndefined();
});

test("changing accessory type clears trigger bindings and requires a new button selection", async () => {
  const view = customButton([momentary()]);
  field(view.card(), "Name in Apple Home").value = "Reading timer";
  const type = field(view.card(), "Accessory type");
  type.value = "Switch";
  type.onchange();
  expect(view.get("[data-mappings]").children).toHaveLength(1);
  expect(view.card().read()).toEqual({ id: "sample-trigger", name: "Reading timer", profile: "Switch", characteristics: { On: {} } });
  const nextType = field(view.card(), "Accessory type");
  nextType.value = "MomentarySwitch";
  nextType.onchange();
  expect(field(view.card(), "Button").value).toBe("");
  await view.get("[data-save-mappings]").onclick();
  expect(view.requests).toHaveLength(0);
  expect(view.get("[data-mapping-feedback]").textContent).toBe("Choose a button to run.");
});

test("programmable buttons retain event mapping and momentary buttons are HomeKit only", () => {
  const mapping: AccessoryMapping = {
    id: "sample-event", name: "Study button", profile: "StatelessProgrammableSwitch",
    characteristics: { ProgrammableSwitchEvent: { event: { element: buttonKey } } },
  };
  const events = customButton([mapping]);
  expect(field(events.card(), "Button events from").value).toBe(buttonKey);
  expect(events.card().read()).toEqual(mapping);
  expect(events.requests).toHaveLength(0);
  const matter = harness({ protocol: "matter" });
  expect(matter.get("[data-new-profile]").querySelectorAll("option").map(option => option.value)).not.toContain("MomentarySwitch");
});
