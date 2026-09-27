import { beforeEach, describe, expect, test } from "bun:test";
import type { Light, StringLightDocument } from "../../../schemas.ts";
import type { NodeRecord } from "../../../state/protocol.ts";
import { fakeTranslate, installTestDom, type FakeElement, type FakeStateClient } from "../test-dom.ts";
import type { Translate } from "../view.ts";

const dom = installTestDom();
const { HtLight, lightView } = await import("./light.ts");
const { define, template } = await import("../dom.ts");

const AT = "2026-09-14T10:00:00.000Z";
const t = fakeTranslate as Translate;
const time = (value: string | number | Date) => `time(${String(value)})`;
const number = (value: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat("en", options).format(value);

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

const base = { capability: "light" as const, readiness: "online" as const, stale: false, observedAt: AT };

describe("lightView", () => {
  test.each([
    ["checking", { capability: "light", readiness: "checking", stale: false }, { phase: "checking", value: "", actions: [], detail: "" }],
    ["gone", { capability: "light", readiness: "gone", stale: false, fault: { code: "unconfigured", message: "gone" } }, { phase: "gone", value: "state.gone", detail: "gone" }],
    ["offline by fault", { ...base, readiness: "offline", document: HUE, fault: { code: "unreachable", message: "no answer" } }, { phase: "offline", value: "", detail: "no answer" }],
    ["offline by availability", { ...base, readiness: "offline", document: { ...HUE, state: { availability: "offline" } } }, { phase: "offline", detail: "status.notReachable" }],
    ["degraded", { ...base, readiness: "degraded", document: { ...HUE, state: { availability: "degraded", on: true } } }, { phase: "degraded", value: "" }],
    ["on", { ...base, document: HUE }, { phase: "on", availability: "online", value: "", detail: `status.readAt{time=time(${AT})}`, swatch: { on: true } }],
    ["off", { ...base, document: { ...HUE, state: { ...HUE.state, on: false } } }, { phase: "off", value: "", swatch: { on: false } }],
    ["unknown power", { ...base, document: { ...HUE, state: { availability: "online" } } }, { phase: "unknown", value: "" }],
    ["stale", { ...base, stale: true, document: HUE }, { phase: "on", detail: `state.stale{time=time(${AT})}` }],
    ["commanded state wins over availability and says when it was commanded", { capability: "stringLight", readiness: "unknown", stale: false, document: STRING }, { phase: "on", value: "", detail: `light.commanded{time=time(${AT})}`, swatch: { on: true, color: "#FF8800" } }],
    ["a fault outranks the commanded sentence", { capability: "stringLight", readiness: "offline", stale: false, document: STRING, fault: { code: "unreachable", message: "Tree did not answer" } }, { phase: "offline", value: "", detail: "Tree did not answer" }],
    ["a state detail shows when nothing else does", { ...base, observedAt: undefined, document: { ...HUE, state: { availability: "online", on: true, detail: "Bridge says hello" } } }, { detail: "Bridge says hello" }],
  ] as const)("%s", (_name, input, expected) => {
    expect(lightView(input as Parameters<typeof lightView>[0], t, time, number)).toMatchObject(expected);
  });

  test("bounds come from the actions: brightness, temperature range, colour iff setColor", () => {
    const view = lightView({ ...base, document: HUE }, t, time, number);
    expect(view.brightness).toEqual({ min: 1, max: 100, step: 1, value: 45, text: "45%" });
    expect(view.temperature).toEqual({ min: 2000, max: 6500, value: 2700, text: "light.kelvin{kelvin=2,700}" });
    expect(view.white).toBeUndefined();
    expect(view.color).toEqual({});
    expect(view.actions.map((action) => action.id)).toEqual(["turnOn", "turnOff", "toggle"]);
    const bare = lightView({ ...base, document: { id: "plain", state: { availability: "online", on: true }, actions: { turnOn: {}, turnOff: {} } } }, t, time, number);
    expect(bare.brightness).toBeUndefined();
    expect(bare.temperature).toBeUndefined();
    expect(bare.color).toBeUndefined();
    expect(bare.actions.map((action) => action.id)).toEqual(["turnOn", "turnOff"]);
  });

  test("a temperature range of one value is fixed white, with the string's own label and note", () => {
    const view = lightView({ capability: "stringLight", readiness: "unknown", stale: false, document: STRING }, t, time, number);
    expect(view.temperature).toBeUndefined();
    expect(view.white).toEqual({ kelvin: 2700, label: "stringLight.warmWhite{kelvin=light.kelvin{kelvin=2,700}}", help: "stringLight.warmWhiteHelp" });
    expect(view.color).toEqual({ value: "#FF8800" });
    expect(view.brightness).toEqual({ min: 0, max: 100, value: 80, text: "80%" });
    const single = lightView({ ...base, document: { ...HUE, actions: { ...HUE.actions, setColorTemperature: { minimumKelvin: 2700, maximumKelvin: 2700 } } } }, t, time, number);
    expect(single.white?.label).toBe("light.warmWhite{kelvin=light.kelvin{kelvin=2,700}}");
    expect(single.white?.help).toBe("");
  });

  test("a temperature range without a reading names the colour mode", () => {
    const view = lightView({ ...base, document: { ...HUE, state: { availability: "online", on: true, color: "#00FF00" } } }, t, time, number);
    expect(view.temperature?.text).toBe("light.colorMode");
    expect(view.brightness?.text).toBe("");
    expect(view.swatch).toEqual({ on: true, color: "#00FF00" });
  });

  test("a power command in flight puts every power button in updating; a non-power one leaves them alone", () => {
    const brightnessPending = lightView({ ...base, document: HUE, pending: "setBrightness" }, t, time, number);
    expect(brightnessPending.busy).toBe(true);
    expect(brightnessPending.actions.every((action) => action.state !== "updating")).toBe(true);
    const powerPending = lightView({ ...base, document: HUE, pending: "turnOff" }, t, time, number);
    expect(powerPending.actions.filter((action) => action.id !== "getState").every((action) => action.state === "updating")).toBe(true);
  });

  test("an error puts the power buttons in failure and keeps the phase", () => {
    const view = lightView({ ...base, document: HUE, error: "Bridge refused", errorControl: "turnOff" }, t, time, number);
    expect(view.phase).toBe("on");
    expect(view.feedback).toEqual({ message: "Bridge refused", tone: "bad" });
    expect(view.actions.filter((action) => action.id !== "getState").every((action) => action.state === "failure")).toBe(true);
  });

  test("a non-power error leaves the power buttons alone", () => {
    const view = lightView({ ...base, document: HUE, error: "Bridge refused", errorControl: "setBrightness" }, t, time, number);
    expect(view.actions.every((action) => action.state !== "failure")).toBe(true);
  });
});

class TestLight extends HtLight {
  constructor() {
    super([], TEMPLATE, "live");
  }
}

const TEMPLATE = template(`<div part="state"><svg part="swatch"></svg><span part="value"></span><span part="detail"></span></div>
  <div part="actions"><button data-action="turnOn"></button><button data-action="turnOff"></button><button data-action="toggle"></button><button data-action="getState"></button></div>
  <div part="brightness-field"><output part="brightness-value"></output><input part="brightness" type="range"></div>
  <div part="temperature-field"><output part="temperature-value"></output><input part="temperature" type="range"></div>
  <button part="white" data-action="white"></button><p part="white-help"></p>
  <div part="color-field"><output part="color-value"></output><input part="color" type="color" value="#ffffff"></div>`);

define("test-light", TestLight);

function record(capability: "light" | "stringLight", document: Light | StringLightDocument, extra: Partial<NodeRecord> = {}): NodeRecord {
  return { node: "device/lamp", version: 1, updatedAt: AT, observedAt: AT, value: { schemaVersion: 1, id: "lamp", name: "Lamp", status: document.state.availability, capabilities: { [capability]: document } }, ...extra };
}

let client: FakeStateClient;

function mount(capability?: "stringLight"): TestLight & FakeElement {
  const element = dom.document.createElement("test-light") as unknown as TestLight & FakeElement;
  element.setAttribute("node", "device/lamp");
  if (capability) element.setAttribute("capability", capability);
  dom.document.body.append(element as unknown as FakeElement);
  return element;
}

const part = (element: FakeElement, name: string) => element.shadowRoot!.querySelector(`[part~="${name}"]`)!;
const button = (element: FakeElement, action: string) => element.shadowRoot!.querySelector(`[data-action="${action}"]`)!;
const fire = (element: FakeElement, type: string) => { element.dispatchEvent(new Event(type, { bubbles: true })); };
const tick = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

beforeEach(() => {
  client = dom.reset();
});

describe("HtLight", () => {
  test("renders power, bounds, and the swatch from the document", () => {
    client.push(record("light", HUE));
    const element = mount();
    expect(element.getAttribute("data-phase")).toBe("on");
    expect(part(element, "value").hidden).toBe(true);
    expect(button(element, "turnOn").dataset.state).toBe("active");
    expect(part(element, "brightness").getAttribute("min")).toBe("1");
    expect(part(element, "brightness").getAttribute("max")).toBe("100");
    expect((part(element, "brightness") as unknown as { value: string }).value).toBe("45");
    expect(part(element, "brightness-value").textContent).toBe("45%");
    expect(part(element, "temperature-field").hidden).toBe(false);
    expect(part(element, "temperature-value").textContent).toBe("light.kelvin{kelvin=2,700}");
    expect(part(element, "white").hidden).toBe(true);
    expect(part(element, "white-help").hidden).toBe(true);
    expect(part(element, "color-field").hidden).toBe(false);
    expect(part(element, "swatch").getAttribute("data-on")).toBe("true");
    expect(part(element, "swatch").hasAttribute("fill")).toBe(false);
    expect(button(element, "getState").hidden).toBe(true);
    expect(button(element, "toggle").hidden).toBe(false);
  });

  test("a range change sends the typed value; input only previews the text", async () => {
    client.push(record("light", HUE));
    const element = mount();
    const brightness = part(element, "brightness") as unknown as FakeElement & { value: string };
    brightness.value = "60";
    fire(brightness, "input");
    expect(part(element, "brightness-value").textContent).toBe("60%");
    expect(client.invocations).toEqual([]);
    fire(brightness, "change");
    expect(client.invocations).toEqual([{ node: "device/lamp", capability: "light", controlId: "setBrightness", value: 60 }]);
    const temperature = part(element, "temperature") as unknown as FakeElement & { value: string };
    temperature.value = "3000";
    fire(temperature, "change");
    expect(client.invocations).toHaveLength(1);
    client.settle();
    await tick();
    expect(temperature.value).toBe("2700");
    temperature.value = "3000";
    fire(temperature, "change");
    expect(client.invocations[1]).toMatchObject({ controlId: "setColorTemperature", value: 3000 });
    client.settle();
    await tick();
    const color = part(element, "color") as unknown as FakeElement & { value: string };
    color.value = "#112233";
    fire(color, "change");
    expect(client.invocations[2]).toMatchObject({ controlId: "setColor", value: "#112233" });
  });

  test("a string light reads capabilities.stringLight, offers fixed white, and paints the swatch", () => {
    client.push(record("stringLight", STRING));
    const element = mount("stringLight");
    expect(element.lightCapability).toBe("stringLight");
    expect(element.getAttribute("data-phase")).toBe("on");
    expect(part(element, "detail").textContent).toBe(`light.commanded{time=time(${AT})}`);
    expect(part(element, "temperature-field").hidden).toBe(true);
    expect(part(element, "white").hidden).toBe(false);
    expect(part(element, "white").textContent).toBe("stringLight.warmWhite{kelvin=light.kelvin{kelvin=2,700}}");
    expect(part(element, "white-help").textContent).toBe("stringLight.warmWhiteHelp");
    expect(part(element, "swatch").getAttribute("fill")).toBe("#FF8800");
    expect(part(element, "swatch").getAttribute("data-color")).toBe("#FF8800");
    expect((part(element, "color") as unknown as { value: string }).value).toBe("#FF8800");
    button(element, "white").click();
    expect(client.invocations[0]).toEqual({ node: "device/lamp", capability: "stringLight", controlId: "setColorTemperature", value: 2700 });
    expect(button(element, "white").getAttribute("aria-disabled")).toBe("true");
  });

  test("power buttons invoke their controls on the right capability", () => {
    client.push(record("light", HUE));
    const element = mount();
    button(element, "turnOff").click();
    expect(client.invocations[0]).toMatchObject({ capability: "light", controlId: "turnOff" });
    expect(button(element, "turnOff").dataset.state).toBe("updating");
  });

  test("a refused power command keeps the phase and puts the power buttons in failure", async () => {
    client.push(record("light", HUE));
    const element = mount();
    void element.turnOff();
    client.fail("Bridge refused");
    await tick();
    expect(element.getAttribute("data-phase")).toBe("on");
    expect(button(element, "turnOn").dataset.state).toBe("failure");
    expect(button(element, "turnOn").getAttribute("title")).toBe("Bridge refused");
  });

  test("a refused range command keeps the value and does not touch the power buttons", async () => {
    client.push(record("light", HUE));
    const element = mount();
    void element.setBrightness(10);
    client.fail("Bridge refused");
    await tick();
    expect(element.getAttribute("data-phase")).toBe("on");
    expect(button(element, "turnOn").dataset.state).toBe("active");
    expect((part(element, "brightness") as unknown as { value: string }).value).toBe("45");
  });

  test("a fault renders offline with the sentence and hides nothing the document declares", () => {
    client.push(record("light", HUE, { fault: { code: "timeout", message: "Lamp did not answer" } }));
    const element = mount();
    expect(element.getAttribute("data-phase")).toBe("offline");
    expect(part(element, "detail").textContent).toBe("Lamp did not answer");
    expect(button(element, "turnOn").hidden).toBe(false);
    expect(part(element, "brightness-field").hidden).toBe(false);
  });
});
