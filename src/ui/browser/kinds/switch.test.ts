import { beforeEach, describe, expect, test } from "bun:test";
import type { BinarySwitch } from "../../../schemas.ts";
import type { GroupSwitch, NodeRecord } from "../../../state/protocol.ts";
import { fakeTranslate, installTestDom, type FakeElement, type FakeStateClient } from "../test-dom.ts";
import type { Translate } from "../view.ts";

const dom = installTestDom();
const { HtBinarySwitch, SWITCH_ACTIONS, switchGaps, switchView } = await import("./switch.ts");
const { define, template } = await import("../dom.ts");

const AT = "2026-09-14T10:00:00.000Z";
const t = fakeTranslate as Translate;
const time = (value: string | number | Date) => `time(${String(value)})`;
const ACTIONS: BinarySwitch["actions"] = { turnOn: {}, turnOff: {}, toggle: {}, getState: {} };

function doc(state: BinarySwitch["state"], actions: BinarySwitch["actions"] = ACTIONS): BinarySwitch {
  return { id: "relay", state, actions };
}

const online = (value: "on" | "off") => doc({ availability: "online", value, observedAt: AT });

describe("SWITCH_ACTIONS", () => {
  test("keeps the schema's order with getState last", () => {
    expect(SWITCH_ACTIONS).toEqual(["turnOn", "turnOff", "toggle", "getState"]);
  });
});

describe("switchView", () => {
  test.each([
    ["checking", { readiness: "checking", stale: false }, { phase: "checking", availability: "unknown", value: "", detail: "", actions: [] }],
    ["gone", { readiness: "gone", stale: false, fault: { code: "unconfigured", message: "relay is not in devices.yml" } }, { phase: "gone", availability: "unknown", value: "state.gone", detail: "relay is not in devices.yml", actions: [] }],
    ["offline by fault keeps the last document's actions", { readiness: "offline", stale: false, document: online("on"), fault: { code: "unreachable", message: "no answer" }, observedAt: AT }, { phase: "offline", availability: "offline", value: "", detail: "no answer" }],
    ["offline by availability", { readiness: "offline", stale: false, document: doc({ availability: "offline" }) }, { phase: "offline", availability: "offline", value: "", detail: "status.notReachable" }],
    ["offline and stale says when it was last read", { readiness: "offline", stale: true, document: doc({ availability: "offline" }), observedAt: AT }, { phase: "offline", detail: `state.stale{time=time(${AT})}` }],
    ["degraded", { readiness: "degraded", stale: false, document: doc({ availability: "degraded" }), observedAt: AT }, { phase: "degraded", availability: "degraded", value: "", detail: `status.readAt{time=time(${AT})}` }],
    ["mixed group", { readiness: "online", stale: false, document: doc({ availability: "online" }), group: { mixed: true, canSwitch: true, members: [] }, observedAt: AT }, { phase: "mixed", availability: "online", value: "grouping.mixed" }],
    ["degraded outranks mixed", { readiness: "degraded", stale: false, document: doc({ availability: "degraded" }), group: { mixed: true, canSwitch: true, members: [] } }, { phase: "degraded" }],
    ["on", { readiness: "online", stale: false, document: online("on"), observedAt: AT }, { phase: "on", availability: "online", value: "", detail: `status.readAt{time=time(${AT})}` }],
    ["off", { readiness: "online", stale: false, document: online("off"), observedAt: AT }, { phase: "off", value: "" }],
    ["on but stale", { readiness: "online", stale: true, document: online("on"), observedAt: AT }, { phase: "on", detail: `state.stale{time=time(${AT})}` }],
    ["unknown value", { readiness: "online", stale: false, document: doc({ availability: "online" }) }, { phase: "unknown", availability: "online", value: "", detail: "" }],
    ["unknown availability", { readiness: "unknown", stale: false, document: doc({ availability: "unknown" }) }, { phase: "unknown", availability: "unknown", value: "" }],
  ] as const)("%s", (_name, input, expected) => {
    expect(switchView(input as Parameters<typeof switchView>[0], t, time)).toMatchObject(expected);
  });

  test("actions render in schema order only when the document declares them, turnOn primary", () => {
    const full = switchView({ readiness: "online", stale: false, document: online("on") }, t, time);
    expect(full.actions.map((action) => [action.id, action.label, action.primary, action.enabled, action.state])).toEqual([
      ["turnOn", "action.on", true, true, "active"],
      ["turnOff", "action.off", false, true, "inactive"],
      ["toggle", "action.toggle", false, true, "unknown"],
      ["getState", "action.refresh", false, true, "unknown"],
    ]);
    const partial = switchView({ readiness: "online", stale: false, document: doc({ availability: "online", value: "on", observedAt: AT }, { toggle: {}, turnOn: {} } as unknown as BinarySwitch["actions"]) }, t, time);
    expect(partial.actions.map((action) => action.id)).toEqual(["turnOn", "toggle"]);
    expect(full.hasOnOffButtons).toBe(true);
    expect(partial.hasOnOffButtons).toBe(false);
  });

  test("a power command in flight puts every power button in updating, but leaves getState alone", () => {
    const view = switchView({ readiness: "online", stale: false, document: online("off"), pending: "turnOn" }, t, time);
    expect(view.busy).toBe(true);
    expect(view.phase).toBe("off");
    expect(view.actions.filter((action) => action.id !== "getState").every((action) => action.state === "updating" && !action.enabled)).toBe(true);
    expect(view.actions.find((action) => action.id === "getState")).toMatchObject({ state: "unknown", enabled: true });
  });

  test("getState in flight only affects getState's own state", () => {
    const view = switchView({ readiness: "online", stale: false, document: online("off"), pending: "getState" }, t, time);
    expect(view.actions.find((action) => action.id === "getState")).toMatchObject({ state: "updating", enabled: false });
    expect(view.actions.find((action) => action.id === "turnOff")).toMatchObject({ state: "active", enabled: true });
  });

  test("an error puts the power buttons in failure and keeps the phase", () => {
    const view = switchView({ readiness: "online", stale: false, document: online("on"), error: "Shelly did not answer", errorControl: "turnOff" }, t, time);
    expect(view.phase).toBe("on");
    expect(view.feedback).toEqual({ message: "Shelly did not answer", tone: "bad" });
    expect(view.actions.filter((action) => action.id !== "getState").every((action) => action.state === "failure")).toBe(true);
    expect(view.actions.every((action) => action.enabled)).toBe(true);
  });

  test("a non-power error leaves the power buttons alone", () => {
    const view = switchView({ readiness: "online", stale: false, document: online("on"), error: "Shelly did not answer", errorControl: "getState" }, t, time);
    expect(view.actions.filter((action) => action.id !== "getState").every((action) => action.state !== "failure")).toBe(true);
    expect(view.actions.find((action) => action.id === "getState")?.state).toBe("failure");
  });

  test("a group that cannot switch disables the power actions, keeps Refresh, and names the gaps", () => {
    const group: GroupSwitch["group"] = {
      mixed: false,
      canSwitch: false,
      members: [
        { id: "lamp", name: "Lamp", availability: "online", properties: {} },
        { id: "fan", name: "Fan", availability: "online", properties: {}, missingForSwitch: ["power.toggle", "power.on"] },
        { id: "tv", name: "TV", availability: "online", properties: {}, missingForSwitch: ["power.toggle"] },
      ],
    };
    const view = switchView({ readiness: "online", stale: false, document: doc({ availability: "online" }), group }, t, time);
    expect(view.actions.map((action) => [action.id, action.enabled])).toEqual([["turnOn", false], ["turnOff", false], ["toggle", false], ["getState", true]]);
    expect(view.gaps).toBe("switch.notSharedBy{controls=switch.powerState and action.toggle,count=2,total=3}");
    expect(switchGaps({ mixed: false, canSwitch: true, members: [] }, t, "en")).toBe("");
  });
});

class TestSwitch extends HtBinarySwitch {
  constructor() {
    super([], TEMPLATE, "live");
  }
}

const TEMPLATE = template(`<div part="state"><span part="value"></span><span part="detail"></span></div>
  <p part="gaps"></p>
  <div part="actions"><button data-action="turnOn"></button><button data-action="turnOff"></button><button data-action="toggle"></button><button data-action="getState"></button></div>`);

define("test-switch", TestSwitch);

function record(state: BinarySwitch["state"], extra: Partial<NodeRecord> = {}): NodeRecord {
  return { node: "device/relay", version: 1, updatedAt: AT, ...(state.observedAt ? { observedAt: state.observedAt } : {}), value: { schemaVersion: 1, id: "relay", name: "Relay", status: state.availability, capabilities: { binarySwitch: doc(state) } }, ...extra };
}

let client: FakeStateClient;

function mount(node = "device/relay"): TestSwitch & FakeElement {
  const element = dom.document.createElement("test-switch") as unknown as TestSwitch & FakeElement;
  element.setAttribute("node", node);
  dom.document.body.append(element as unknown as FakeElement);
  return element;
}

const part = (element: FakeElement, name: string) => element.shadowRoot!.querySelector(`[part~="${name}"]`)!;
const button = (element: FakeElement, action: string) => element.shadowRoot!.querySelector(`[data-action="${action}"]`)!;
const tick = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

beforeEach(() => {
  client = dom.reset();
});

describe("HtBinarySwitch", () => {
  test("renders unknown immediately when no controls have been observed", () => {
    const element = mount();
    expect(part(element, "value").textContent).toBe("");
    expect(element.getAttribute("data-phase")).toBe("unknown");
    for (const id of SWITCH_ACTIONS) expect(button(element, id).hidden).toBe(true);
    expect(part(element, "detail").hidden).toBe(true);
  });

  test("renders an online switch: read time, labelled buttons, On active", () => {
    client.push(record({ availability: "online", value: "on", observedAt: AT }));
    const element = mount();
    expect(element.getAttribute("data-phase")).toBe("on");
    expect(part(element, "value").hidden).toBe(true);
    expect(part(element, "detail").textContent).toBe(`status.readAt{time=time(${AT})}`);
    expect(button(element, "turnOn").textContent).toBe("action.on");
    expect(button(element, "turnOn").dataset.state).toBe("active");
    expect(button(element, "turnOff").dataset.state).toBe("inactive");
    expect(button(element, "getState").textContent).toBe("action.refresh");
    for (const id of SWITCH_ACTIONS) expect(button(element, id).hidden).toBe(false);
    expect(part(element, "gaps").hidden).toBe(true);
  });

  test("a stale frame reads as last read, and still shows the reading", () => {
    // A page seed: not confirmed by the stream yet, but seconds old.
    const justNow = new Date(Date.now() - 5_000).toISOString();
    client.push(record({ availability: "online", value: "off", observedAt: justNow }), true);
    const element = mount();
    expect(button(element, "turnOff").dataset.state).toBe("active");
    expect(part(element, "detail").textContent).toBe(`state.stale{time=time(${justNow})}`);
  });

  test("a stale frame keeps its last known value and timestamp", () => {
    // A restored reading remains visible; its Last read timestamp identifies it as stale.
    client.push(record({ availability: "online", value: "off", observedAt: AT }), true);
    const element = mount();
    expect(element.getAttribute("data-phase")).toBe("off");
    expect(button(element, "turnOff").dataset.state).toBe("active");
    expect(part(element, "detail").textContent).toBe(`state.stale{time=time(${AT})}`);
  });

  test("a fault renders offline with its sentence, both power buttons unknown, and still offers the last document's actions", () => {
    client.push(record({ availability: "online", value: "on", observedAt: AT }, { fault: { code: "timeout", message: "Relay did not answer at 10.77.0.228" } }));
    const element = mount();
    expect(element.getAttribute("data-phase")).toBe("offline");
    expect(part(element, "detail").textContent).toBe("Relay did not answer at 10.77.0.228");
    expect(button(element, "turnOn").hidden).toBe(false);
    expect(button(element, "turnOn").dataset.state).toBe("unknown");
    expect(button(element, "turnOn").hasAttribute("aria-disabled")).toBe(false);
  });

  test("clicking On invokes turnOn on the node's binarySwitch, shows updating, then settles to active", async () => {
    client.push(record({ availability: "online", value: "off", observedAt: AT }));
    const element = mount();
    button(element, "turnOn").click();
    expect(client.invocations).toEqual([{ node: "device/relay", capability: "binarySwitch", controlId: "turnOn", value: undefined }]);
    expect(button(element, "turnOn").dataset.state).toBe("updating");
    expect(button(element, "toggle").dataset.state).toBe("updating");
    expect(element.getAttribute("aria-busy")).toBe("true");
    expect(button(element, "toggle").getAttribute("aria-disabled")).toBe("true");
    client.push(record({ availability: "online", value: "on", observedAt: AT }));
    client.settle();
    await tick();
    expect(button(element, "turnOn").dataset.state).toBe("active");
    expect(element.hasAttribute("aria-busy")).toBe(false);
    expect(button(element, "toggle").hasAttribute("aria-disabled")).toBe(false);
  });

  test("Refresh invokes getState and shows updating only on itself", () => {
    client.push(record({ availability: "online", value: "off", observedAt: AT }));
    const element = mount();
    button(element, "getState").click();
    expect(client.invocations[0]?.controlId).toBe("getState");
    expect(button(element, "getState").dataset.state).toBe("updating");
    expect(button(element, "turnOff").dataset.state).toBe("active");
  });

  test("a refused command keeps the phase and puts the power buttons in failure with the message in the button's title", async () => {
    client.push(record({ availability: "online", value: "on", observedAt: AT }));
    const element = mount();
    void element.turnOff();
    client.fail("Relay refused");
    await tick();
    expect(element.getAttribute("data-phase")).toBe("on");
    expect(button(element, "turnOn").dataset.state).toBe("failure");
    expect(button(element, "turnOn").getAttribute("title")).toBe("Relay refused");
    expect(element.hasAttribute("aria-busy")).toBe(false);
  });

  test("a group node renders mixed, names the gaps, and disables the power buttons when it cannot switch", () => {
    const value: GroupSwitch = {
      id: "living", name: "Living room", status: "online",
      capabilities: { binarySwitch: doc({ availability: "online" }) },
      group: { mixed: true, canSwitch: false, members: [{ id: "lamp", name: "Lamp", availability: "online", properties: {} }, { id: "fan", name: "Fan", availability: "online", properties: {}, missingForSwitch: ["power.toggle"] }] },
    };
    client.push({ node: "group/living", version: 1, updatedAt: AT, value });
    const element = mount("group/living");
    expect(element.getAttribute("data-phase")).toBe("mixed");
    expect(part(element, "value").hidden).toBe(false);
    expect(part(element, "value").textContent).toBe("grouping.mixed");
    expect(part(element, "gaps").hidden).toBe(false);
    expect(part(element, "gaps").textContent).toBe("switch.notSharedBy{controls=action.toggle,count=1,total=2}");
    expect(button(element, "turnOn").getAttribute("aria-disabled")).toBe("true");
    expect(button(element, "getState").hasAttribute("aria-disabled")).toBe(false);
    // A power control the group cannot share is disabled and stays unsent; Refresh still reads.
    button(element, "toggle").click();
    expect(client.invocations).toEqual([]);
    button(element, "getState").click();
    expect(client.invocations[0]).toMatchObject({ node: "group/living", capability: "binarySwitch", controlId: "getState" });
  });

  test("a gone node renders the state.gone word and hides the actions", () => {
    client.push({ node: "device/relay", version: 3, updatedAt: AT, fault: { code: "unconfigured", message: "relay is not in devices.yml" } });
    const element = mount();
    expect(part(element, "value").hidden).toBe(false);
    expect(part(element, "value").textContent).toBe("state.gone");
    expect(part(element, "detail").textContent).toBe("relay is not in devices.yml");
    for (const id of SWITCH_ACTIONS) expect(button(element, id).hidden).toBe(true);
  });

  test("On/Off read as pressed on the current side, and the word stays hidden since the buttons already say it", () => {
    client.push(record({ availability: "online", value: "on", observedAt: AT }));
    const element = mount();
    expect(button(element, "turnOn").getAttribute("aria-pressed")).toBe("true");
    expect(button(element, "turnOff").getAttribute("aria-pressed")).toBe("false");
    expect(part(element, "value").hidden).toBe(true);

    client.push(record({ availability: "online", value: "off", observedAt: AT }));
    expect(button(element, "turnOn").getAttribute("aria-pressed")).toBe("false");
    expect(button(element, "turnOff").getAttribute("aria-pressed")).toBe("true");
    expect(part(element, "value").hidden).toBe(true);
  });

  test("neither On nor Off is pressed when the value is unknown, still hiding the word", () => {
    client.push(record({ availability: "online" }));
    const element = mount();
    expect(button(element, "turnOn").getAttribute("aria-pressed")).toBe("false");
    expect(button(element, "turnOff").getAttribute("aria-pressed")).toBe("false");
    expect(button(element, "turnOn").dataset.state).toBe("unknown");
    expect(part(element, "value").hidden).toBe(true);
  });

  test("a gone node keeps the word visible since there are no On/Off buttons to say it", () => {
    client.push({ node: "device/relay", version: 3, updatedAt: AT, fault: { code: "unconfigured", message: "relay is not in devices.yml" } });
    const element = mount();
    expect(part(element, "value").hidden).toBe(false);
  });
});
