import { beforeEach, describe, expect, test } from "bun:test";
import type { BinarySwitch, Button, Light, StringLightDocument } from "../../schemas.ts";
import type { GroupSwitch, NodeRecord } from "../../state/protocol.ts";
import type { StateClient } from "../browser/state.ts";
import { installTestDom, type FakeElement, type FakeStateClient } from "../browser/test-dom.ts";
import { THEMES } from "./index.ts";

const dom = installTestDom();
/** Read through a call so the `delete` below does not narrow the property for the rest of the module. */
const currentClient = (): StateClient | undefined => dom.ht.state;
// An earlier test file may have left a fake client behind; the first entry must find nothing and install the page's client.
delete dom.ht.state;
const euclid = await import("./euclid/index.ts");
const installedByEuclid = currentClient();
const swiss = await import("./swiss/index.ts");
const brutal = await import("./brutal/index.ts");
const afterEveryEntry = currentClient();
const { BrutalSwitch } = await import("./brutal/switch.ts");
const { EuclidButton } = await import("./euclid/button.ts");
const { EuclidLight } = await import("./euclid/light.ts");
const { EuclidStatus } = await import("./euclid/status.ts");
const { EuclidSwitch } = await import("./euclid/switch.ts");
const { EuclidSwitchRow } = await import("./euclid/switch-row.ts");
const { define } = await import("../browser/dom.ts");

// `ht-switch` belongs to whichever entry ran first (Euclid here); the brutal expression gets a tag of its own for these tests.
define("brutal-switch", BrutalSwitch);

const AT = "2026-09-14T10:00:00.000Z";
const ACTIONS: BinarySwitch["actions"] = { turnOn: {}, turnOff: {}, toggle: {}, getState: {} };
const SWITCH_ON: BinarySwitch = { id: "relay", state: { availability: "online", value: "on", observedAt: AT }, actions: ACTIONS };
const SWITCH_OFF: BinarySwitch = { id: "relay", state: { availability: "online", value: "off", observedAt: AT }, actions: ACTIONS };
const PRESS: Button = { id: "candles", state: { availability: "unknown" }, actions: { press: {} } };
const HOLD: Button = { id: "candles", state: { availability: "unknown" }, actions: { press: { maximumDurationMs: 60_000 } } };
const HUE: Light = {
  id: "lamp",
  state: { availability: "online", on: true, brightnessPercent: 45, colorTemperatureKelvin: 2700, observedAt: AT },
  actions: { turnOn: {}, turnOff: {}, toggle: {}, setBrightness: { minimumPercent: 1, maximumPercent: 100, stepPercent: 1 }, setColorTemperature: { minimumKelvin: 2000, maximumKelvin: 6500 }, setColor: { formats: ["hex"] } },
};
const STRING: StringLightDocument = {
  id: "tree",
  state: { availability: "unknown", stateSource: "commanded", commandedAt: AT, on: true, brightnessPercent: 80, color: "#FF8800", layout: "linear", lightCount: 3, lights: [{ id: "1", name: "One", index: 0 }, { id: "2", name: "Two", index: 1 }, { id: "3", name: "Three", index: 2 }] },
  actions: { turnOn: {}, turnOff: {}, setBrightness: { minimumPercent: 0, maximumPercent: 100 }, setColorTemperature: { minimumKelvin: 2700, maximumKelvin: 2700 }, setColor: { formats: ["hex"] } },
};

function device(capabilities: Record<string, unknown>, status = "online", extra: Partial<NodeRecord> = {}): NodeRecord {
  return { node: "device/x", version: 1, updatedAt: AT, observedAt: AT, value: { schemaVersion: 1, id: "x", name: "X", status, capabilities }, ...extra };
}

function group(document: BinarySwitch, half: GroupSwitch["group"]): NodeRecord {
  const value: GroupSwitch = { id: "g", name: "G", status: "online", capabilities: { binarySwitch: document }, group: half };
  return { node: "group/g", version: 1, updatedAt: AT, observedAt: AT, value };
}

let client: FakeStateClient;

function mount<T>(tag: string, attributes: Record<string, string> = { node: "device/x" }): T & FakeElement {
  const element = dom.document.createElement(tag) as unknown as T & FakeElement;
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  dom.document.body.append(element as unknown as FakeElement);
  return element;
}

const part = (element: FakeElement, name: string) => element.shadowRoot!.querySelector(`[part~="${name}"]`);
const button = (element: FakeElement, action: string) => element.shadowRoot!.querySelector(`[data-action="${action}"]`)!;
const primaries = (element: FakeElement) => element.shadowRoot!.querySelectorAll(".btn-primary");
const shown = (element: FakeElement) => element.shadowRoot!.querySelectorAll("[data-action]").filter((item) => !item.hidden).map((item) => [item.getAttribute("data-action"), item.textContent]);
const fire = (element: FakeElement, type: string) => { element.dispatchEvent(new Event(type, { bubbles: true })); };
const tick = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

beforeEach(() => {
  client = dom.reset();
});

describe("theme entries", () => {
  test("the first entry installs the page's state client; later entries keep it", () => {
    expect(installedByEuclid).toBeDefined();
    expect(installedByEuclid?.connection).toBe("connecting");
    expect(typeof installedByEuclid?.subscribe).toBe("function");
    expect(typeof installedByEuclid?.invoke).toBe("function");
    expect(afterEveryEntry).toBe(installedByEuclid);
  });

  test("each entry defines exactly the tags its theme lists, and the registry holds the first definition", () => {
    expect(Object.keys(euclid.ELEMENTS)).toEqual([...THEMES.euclid.components]);
    expect(Object.keys(swiss.ELEMENTS)).toEqual([...THEMES.swiss.components]);
    expect(Object.keys(brutal.ELEMENTS)).toEqual([...THEMES.brutal.components]);
    for (const [tag, cls] of Object.entries(euclid.ELEMENTS)) expect(customElements.get(tag)).toBe(cls);
  });

  test("Swiss reuses Euclid's elements; Brutal replaces only the switch", () => {
    expect(swiss.ELEMENTS).toBe(euclid.ELEMENTS);
    expect(brutal.ELEMENTS["ht-switch"]).toBe(BrutalSwitch);
    expect(brutal.ELEMENTS["ht-switch-row"]).toBe(EuclidSwitchRow);
    expect(brutal.ELEMENTS["ht-button"]).toBe(EuclidButton);
    expect(brutal.ELEMENTS["ht-light"]).toBe(EuclidLight);
    expect(brutal.ELEMENTS["ht-status"]).toBe(EuclidStatus);
    expect(euclid.ELEMENTS["ht-switch"]).toBe(EuclidSwitch);
  });

  test("templates hold structure only: an unconnected element has no text before its first render", () => {
    for (const tag of ["ht-switch", "ht-switch-row", "ht-button", "ht-light", "ht-status", "brutal-switch"]) {
      const element = dom.document.createElement(tag);
      expect(`${tag}: ${element.shadowRoot!.textContent.trim()}`).toBe(`${tag}: `);
      expect(element.shadowRoot!.adoptedStyleSheets).toHaveLength(2);
    }
  });
});

describe("EuclidSwitch", () => {
  test("connecting subscribes live and renders checking with every action hidden", () => {
    const element = mount<InstanceType<typeof EuclidSwitch>>("ht-switch");
    expect(client.subscriptions).toEqual([expect.objectContaining({ node: "device/x", tier: "live" })]);
    expect(part(element, "value")!.hidden).toBe(true);
    expect(part(element, "detail")!.hidden).toBe(true);
    expect(part(element, "gaps")!.hidden).toBe(true);
    expect(shown(element)).toEqual([]);
  });

  test("a frame with value on renders no word (the buttons say it), On active, and no feedback", () => {
    client.push(device({ binarySwitch: SWITCH_ON }));
    const element = mount<InstanceType<typeof EuclidSwitch>>("ht-switch");
    expect(part(element, "value")!.hidden).toBe(true);
    expect(part(element, "state")!.getAttribute("data-phase")).toBe("on");
    expect(part(element, "detail")!.textContent).toBe(`status.readAt{time=time(${AT})}`);
    expect(part(element, "detail")!.hidden).toBe(false);
    expect(shown(element)).toEqual([["turnOn", "action.on"], ["turnOff", "action.off"], ["toggle", "action.toggle"], ["getState", "action.refresh"]]);
    expect(button(element, "turnOn").getAttribute("aria-pressed")).toBe("true");
    expect(button(element, "turnOn").dataset.state).toBe("active");
    expect(button(element, "turnOff").getAttribute("aria-pressed")).toBe("false");
    expect(button(element, "turnOff").dataset.state).toBe("inactive");
  });

  test("no button is statically primary; Off reads as pressed when the value is off, and Refresh is last", () => {
    client.push(device({ binarySwitch: SWITCH_OFF }));
    const element = mount<InstanceType<typeof EuclidSwitch>>("ht-switch");
    expect(primaries(element)).toHaveLength(0);
    expect(button(element, "turnOn").getAttribute("aria-pressed")).toBe("false");
    expect(button(element, "turnOff").getAttribute("aria-pressed")).toBe("true");
    expect(shown(element).at(-1)).toEqual(["getState", "action.refresh"]);
  });

  test("a fault frame shows no word but the fault's sentence, both power buttons unknown, keeping the last document's actions", () => {
    client.push(device({ binarySwitch: SWITCH_ON }, "online", { fault: { code: "unreachable", message: "Relay did not answer at 10.77.0.5 (timeout)." } }));
    const element = mount<InstanceType<typeof EuclidSwitch>>("ht-switch");
    expect(part(element, "value")!.hidden).toBe(true);
    expect(part(element, "state")!.getAttribute("data-phase")).toBe("offline");
    expect(part(element, "detail")!.textContent).toBe("Relay did not answer at 10.77.0.5 (timeout).");
    expect(shown(element).map(([id]) => id)).toEqual(["turnOn", "turnOff", "toggle", "getState"]);
    expect(button(element, "turnOn").dataset.state).toBe("unknown");
  });

  test("clicking Off invokes turnOff on the node, marks the host busy, shows updating, and clears when the command settles", async () => {
    client.push(device({ binarySwitch: SWITCH_ON }));
    const element = mount<InstanceType<typeof EuclidSwitch>>("ht-switch");
    button(element, "turnOff").click();
    expect(client.invocations).toEqual([{ node: "device/x", capability: "binarySwitch", controlId: "turnOff", value: undefined }]);
    expect(element.getAttribute("aria-busy")).toBe("true");
    // turnOn/turnOff/toggle share the power property and all go to updating; getState reads a different question and stays usable.
    for (const id of ["turnOn", "turnOff", "toggle"]) expect(button(element, id).getAttribute("aria-disabled")).toBe("true");
    expect(button(element, "getState").hasAttribute("aria-disabled")).toBe(false);
    expect(button(element, "turnOff").dataset.state).toBe("updating");
    client.settle();
    await tick();
    expect(element.hasAttribute("aria-busy")).toBe(false);
    expect(button(element, "turnOff").hasAttribute("aria-disabled")).toBe(false);
    // Settling only clears the pending command; the switch is still "on" until a fresh frame says otherwise.
    expect(button(element, "turnOff").dataset.state).toBe("inactive");
  });

  test("a refused command puts the power buttons in failure with the message in the button's title", async () => {
    client.push(device({ binarySwitch: SWITCH_ON }));
    const element = mount<InstanceType<typeof EuclidSwitch>>("ht-switch");
    button(element, "toggle").click();
    client.fail("Relay refused the command");
    await tick();
    expect(button(element, "toggle").dataset.state).toBe("failure");
    expect(button(element, "toggle").getAttribute("title")).toBe("Relay refused the command");
    expect(part(element, "value")!.hidden).toBe(true);
  });

  test("a group value renders the gaps line and disables the power actions it cannot share", () => {
    client.push(group({ id: "g", state: { availability: "online" }, actions: ACTIONS }, {
      mixed: true,
      canSwitch: false,
      members: [
        { id: "lamp", name: "Lamp", availability: "online", properties: {} },
        { id: "fan", name: "Fan", availability: "online", properties: {}, missingForSwitch: ["power.toggle"] },
      ],
    }));
    const element = mount<InstanceType<typeof EuclidSwitch>>("ht-switch", { node: "group/g" });
    expect(part(element, "value")!.hidden).toBe(false);
    expect(part(element, "value")!.textContent).toBe("grouping.mixed");
    expect(part(element, "state")!.getAttribute("data-phase")).toBe("mixed");
    expect(part(element, "gaps")!.hidden).toBe(false);
    expect(part(element, "gaps")!.textContent).toBe("switch.notSharedBy{controls=action.toggle,count=1,total=2}");
    expect(button(element, "turnOn").getAttribute("aria-disabled")).toBe("true");
    expect(button(element, "toggle").getAttribute("aria-disabled")).toBe("true");
    expect(button(element, "getState").hasAttribute("aria-disabled")).toBe(false);
  });
});

describe("EuclidSwitchRow", () => {
  test("subscribes at the glance tier with no primary, no detail, no gaps, and no Refresh", () => {
    client.push(device({ binarySwitch: SWITCH_OFF }));
    const element = mount<InstanceType<typeof EuclidSwitchRow>>("ht-switch-row");
    expect(client.subscriptions[0]).toMatchObject({ node: "device/x", tier: "glance" });
    expect(primaries(element)).toHaveLength(0);
    expect(part(element, "detail")).toBeNull();
    expect(part(element, "gaps")).toBeNull();
    expect(shown(element)).toEqual([["turnOn", "action.on"], ["turnOff", "action.off"], ["toggle", "action.toggle"]]);
    for (const item of element.shadowRoot!.querySelectorAll("[data-action]")) expect(item.className).toBe("btn btn-small");
    expect(part(element, "value")!.hidden).toBe(true);
    expect(part(element, "value")!.classList.contains("num")).toBe(true);
    expect(button(element, "turnOff").dataset.state).toBe("active");
  });

  test("a failed command puts the power buttons in failure; the next command clears it", async () => {
    client.push(device({ binarySwitch: SWITCH_OFF }));
    const element = mount<InstanceType<typeof EuclidSwitchRow>>("ht-switch-row");
    button(element, "turnOn").click();
    expect(button(element, "turnOn").dataset.state).toBe("updating");
    client.fail("Relay did not answer");
    await tick();
    expect(button(element, "turnOn").dataset.state).toBe("failure");
    expect(button(element, "turnOn").getAttribute("title")).toBe("Relay did not answer");
    button(element, "toggle").click();
    client.settle();
    await tick();
    expect(button(element, "turnOff").dataset.state).toBe("active");
    expect(button(element, "turnOff").hasAttribute("title")).toBe(false);
  });
});

describe("EuclidButton", () => {
  test("a momentary button hides the hold field and offers Press as the one primary", () => {
    client.push(device({ button: PRESS }));
    const element = mount<InstanceType<typeof EuclidButton>>("ht-button");
    expect(part(element, "value")!.hidden).toBe(true);
    expect(part(element, "hold-field")!.hidden).toBe(true);
    expect(shown(element)).toEqual([["press", "button.press"]]);
    expect(button(element, "press").dataset.state).toBe("unknown");
    expect(primaries(element)).toHaveLength(1);
    expect(primaries(element)[0]!.getAttribute("data-action")).toBe("press");
  });

  test("a bounded hold shows the field with its label and the maximum in seconds", () => {
    client.push(device({ button: HOLD }));
    const element = mount<InstanceType<typeof EuclidButton>>("ht-button");
    expect(part(element, "hold-field")!.hidden).toBe(false);
    expect(part(element, "hold-label")!.textContent).toBe("button.hold");
    const hold = part(element, "hold")!;
    expect(hold.getAttribute("type")).toBe("number");
    expect(hold.getAttribute("step")).toBe("0.1");
    expect(hold.max).toBe("60");
  });

  test("Press sends the entered hold as durationMs, shows updating, then settles back", async () => {
    client.push(device({ button: HOLD }));
    const element = mount<InstanceType<typeof EuclidButton>>("ht-button");
    part(element, "hold")!.value = "1.5";
    button(element, "press").click();
    expect(client.invocations).toEqual([{ node: "device/x", capability: "button", controlId: "press", value: { durationMs: 1500 } }]);
    expect(button(element, "press").dataset.state).toBe("updating");
    client.settle();
    await tick();
    expect(button(element, "press").dataset.state).toBe("unknown");
  });

  test("without a hold the press carries no value", async () => {
    client.push(device({ button: PRESS }));
    const element = mount<InstanceType<typeof EuclidButton>>("ht-button");
    button(element, "press").click();
    expect(client.invocations[0]).toMatchObject({ controlId: "press", value: undefined });
    client.settle();
    await tick();
  });
});

describe("EuclidLight", () => {
  test("ranges take their bounds and value from the document's actions and state, with catalog labels", () => {
    client.push(device({ light: HUE }));
    const element = mount<InstanceType<typeof EuclidLight>>("ht-light");
    expect(part(element, "value")!.hidden).toBe(true);
    expect(button(element, "turnOn").dataset.state).toBe("active");
    expect(part(element, "brightness-field")!.hidden).toBe(false);
    expect(part(element, "brightness-label")!.textContent).toBe("light.brightness");
    const brightness = part(element, "brightness")!;
    expect([brightness.min, brightness.max, brightness.step, brightness.value]).toEqual(["1", "100", "1", "45"]);
    expect(part(element, "brightness-value")!.textContent).toBe("45%");
    expect(part(element, "temperature-field")!.hidden).toBe(false);
    expect(part(element, "temperature-label")!.textContent).toBe("light.colorTemperature");
    const temperature = part(element, "temperature")!;
    expect([temperature.min, temperature.max, temperature.value]).toEqual(["2000", "6500", "2700"]);
    expect(part(element, "temperature-value")!.textContent).toBe("light.kelvin{kelvin=2,700}");
    expect(part(element, "white-field")!.hidden).toBe(true);
    expect(part(element, "color-field")!.hidden).toBe(false);
    expect(part(element, "color-label")!.textContent).toBe("light.color");
    expect(shown(element)).toEqual([["turnOn", "action.on"], ["turnOff", "action.off"], ["toggle", "action.toggle"]]);
    expect(primaries(element)).toHaveLength(1);
    expect(primaries(element)[0]!.getAttribute("data-action")).toBe("turnOn");
  });

  test("the colour field is hidden without setColor", () => {
    const { setColor: _color, ...actions } = HUE.actions ?? {};
    client.push(device({ light: { ...HUE, actions } }));
    const element = mount<InstanceType<typeof EuclidLight>>("ht-light");
    expect(part(element, "color-field")!.hidden).toBe(true);
    expect(part(element, "brightness-field")!.hidden).toBe(false);
  });

  test("the swatch carries the reported colour as its fill while on, and nothing when off", () => {
    client.push(device({ light: { ...HUE, state: { availability: "online", on: true, color: "#00FF00" } } }));
    const element = mount<InstanceType<typeof EuclidLight>>("ht-light");
    const swatch = part(element, "swatch")!;
    expect(swatch.localName).toBe("svg");
    expect(swatch.getAttribute("aria-hidden")).toBe("true");
    expect(swatch.getAttribute("data-on")).toBe("true");
    expect(swatch.getAttribute("data-color")).toBe("#00FF00");
    expect(swatch.getAttribute("fill")).toBe("#00FF00");
    client.push(device({ light: { ...HUE, state: { availability: "online", on: false, color: "#00FF00" } } }));
    expect(swatch.getAttribute("data-on")).toBe("false");
    expect(swatch.hasAttribute("data-color")).toBe(false);
    expect(swatch.hasAttribute("fill")).toBe(false);
    expect(button(element, "turnOff").dataset.state).toBe("active");
  });

  test("a string light with one temperature shows the fixed-white button and its note instead of the range", () => {
    client.push(device({ stringLight: STRING }, "unknown"));
    const element = mount<InstanceType<typeof EuclidLight>>("ht-light", { node: "device/x", capability: "stringLight" });
    expect(part(element, "temperature-field")!.hidden).toBe(true);
    expect(part(element, "white-field")!.hidden).toBe(false);
    expect(button(element, "white").hidden).toBe(false);
    expect(button(element, "white").textContent).toBe("stringLight.warmWhite{kelvin=light.kelvin{kelvin=2,700}}");
    expect(part(element, "white-help")!.textContent).toBe("stringLight.warmWhiteHelp");
    expect(part(element, "color")!.value).toBe("#FF8800");
    expect(part(element, "detail")!.textContent).toBe(`light.commanded{time=time(${AT})}`);
  });

  test("changing a range sends the value through the light capability", async () => {
    client.push(device({ light: HUE }));
    const element = mount<InstanceType<typeof EuclidLight>>("ht-light");
    const brightness = part(element, "brightness")!;
    brightness.value = "60";
    fire(brightness, "change");
    expect(client.invocations).toEqual([{ node: "device/x", capability: "light", controlId: "setBrightness", value: 60 }]);
    client.settle();
    await tick();
  });

  test("a sent value stays in the slider through pending re-renders until a newer frame speaks", async () => {
    client.push(device({ light: HUE }));
    const element = mount<InstanceType<typeof EuclidLight>>("ht-light");
    const brightness = part(element, "brightness")!;
    brightness.value = "60";
    fire(brightness, "input");
    fire(brightness, "change");
    // The pending render and a heartbeat frame carrying the old reading must not snap the slider back.
    expect(brightness.value).toBe("60");
    expect(part(element, "brightness-value")!.textContent).toBe("60%");
    client.push(device({ light: HUE }));
    expect(brightness.value).toBe("60");
    client.settle();
    await tick();
    expect(brightness.value).toBe("60");
    // A newer frame has the last word.
    client.push(device({ light: { ...HUE, state: { ...HUE.state, brightnessPercent: 80 } } }, "online", { version: 2 }));
    expect(brightness.value).toBe("80");
    expect(part(element, "brightness-value")!.textContent).toBe("80%");
  });

  test("a refused command drops the held value and shows the reading again", async () => {
    client.push(device({ light: HUE }));
    const element = mount<InstanceType<typeof EuclidLight>>("ht-light");
    const brightness = part(element, "brightness")!;
    brightness.value = "60";
    fire(brightness, "change");
    client.fail("Lamp refused");
    await tick();
    expect(brightness.value).toBe("45");
    // setBrightness is not a power action: the power buttons are untouched by its failure.
    expect(button(element, "turnOn").dataset.state).toBe("active");
  });
});

describe("EuclidStatus", () => {
  test("renders availability on the host, with no dot and no word — just the summary", () => {
    client.push(device({ binarySwitch: SWITCH_ON }));
    const element = mount<InstanceType<typeof EuclidStatus>>("ht-status");
    expect(client.subscriptions[0]).toMatchObject({ node: "device/x", tier: "glance" });
    expect(element.getAttribute("data-availability")).toBe("online");
    expect(part(element, "summary")!.textContent).toBe("action.on");
    expect(part(element, "summary")!.hidden).toBe(false);
    expect(part(element, "state")!.getAttribute("data-availability")).toBe("online");
  });

  test("a fault turns the host offline and shows its sentence as the summary; checking shows no summary", () => {
    const element = mount<InstanceType<typeof EuclidStatus>>("ht-status");
    expect(element.getAttribute("data-availability")).toBe("unknown");
    expect(part(element, "summary")!.hidden).toBe(true);
    client.push(device({ binarySwitch: SWITCH_ON }, "online", { fault: { code: "unreachable", message: "Relay did not answer" } }));
    expect(element.getAttribute("data-availability")).toBe("offline");
    expect(part(element, "state")!.getAttribute("data-availability")).toBe("offline");
    expect(part(element, "summary")!.textContent).toBe("Relay did not answer");
  });
});

describe("BrutalSwitch", () => {
  test("renders the same parts as Euclid's switch, with Toggle as the one primary and a rocker of On / Off", () => {
    client.push(device({ binarySwitch: SWITCH_ON }));
    const element = mount<InstanceType<typeof BrutalSwitch>>("brutal-switch");
    for (const name of ["state", "value", "detail", "gaps", "rocker", "actions"]) expect(part(element, name)).not.toBeNull();
    expect(part(element, "value")!.hidden).toBe(true);
    expect(part(element, "state")!.getAttribute("data-phase")).toBe("on");
    expect(part(element, "detail")!.textContent).toBe(`status.readAt{time=time(${AT})}`);
    expect(shown(element)).toEqual([["turnOn", "action.on"], ["turnOff", "action.off"], ["toggle", "action.toggle"], ["getState", "action.refresh"]]);
    expect(primaries(element)).toHaveLength(1);
    expect(primaries(element)[0]!.getAttribute("data-action")).toBe("toggle");
    expect(part(element, "rocker")!.querySelectorAll("[data-action]").map((item) => item.getAttribute("data-action"))).toEqual(["turnOn", "turnOff"]);
  });

  test("the observed side of the rocker is pressed; mixed and offline press neither", () => {
    client.push(device({ binarySwitch: SWITCH_ON }));
    const element = mount<InstanceType<typeof BrutalSwitch>>("brutal-switch");
    expect(button(element, "turnOn").getAttribute("aria-pressed")).toBe("true");
    expect(button(element, "turnOff").getAttribute("aria-pressed")).toBe("false");
    client.push(device({ binarySwitch: SWITCH_OFF }));
    expect(button(element, "turnOn").getAttribute("aria-pressed")).toBe("false");
    expect(button(element, "turnOff").getAttribute("aria-pressed")).toBe("true");
    client.push(device({ binarySwitch: SWITCH_ON }, "online", { fault: { code: "timeout", message: "slow" } }));
    expect(button(element, "turnOn").getAttribute("aria-pressed")).toBe("false");
    expect(button(element, "turnOff").getAttribute("aria-pressed")).toBe("false");
    expect(part(element, "state")!.getAttribute("data-phase")).toBe("offline");
  });

  test("clicking a rocker side invokes the control like Euclid's switch", async () => {
    client.push(device({ binarySwitch: SWITCH_OFF }));
    const element = mount<InstanceType<typeof BrutalSwitch>>("brutal-switch");
    button(element, "turnOn").click();
    expect(client.invocations).toEqual([{ node: "device/x", capability: "binarySwitch", controlId: "turnOn", value: undefined }]);
    expect(element.getAttribute("aria-busy")).toBe("true");
    client.settle();
    await tick();
    expect(element.hasAttribute("aria-busy")).toBe(false);
  });
});
