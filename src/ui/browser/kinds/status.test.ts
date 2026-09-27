import { beforeEach, describe, expect, test } from "bun:test";
import type { NodeRecord } from "../../../state/protocol.ts";
import type { SummaryInput } from "./status.ts";
import { fakeTranslate, installTestDom, type FakeElement, type FakeStateClient } from "../test-dom.ts";
import type { Translate } from "../view.ts";

const dom = installTestDom();
const { HtStatus, statusView, summaryOf } = await import("./status.ts");
const { define, template } = await import("../dom.ts");

const AT = "2026-09-14T10:00:00.000Z";
const t = fakeTranslate as Translate;
const number = (value: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat("en", options).format(value);

function object(capabilities: Record<string, unknown>, extra: Record<string, unknown> = {}): SummaryInput {
  return { capabilities, ...extra } as unknown as SummaryInput;
}

const reading = (name: string, value: number | undefined, unit: string, availability = "online") => ({ id: name.toLowerCase(), name, quantity: name, unit, availability, ...(value === undefined ? {} : { value, observedAt: AT }) });
const sensor = (name: string, value: number | undefined, unit: string, availability = "online", detail?: string) => ({ id: name.toLowerCase(), name, schemaId: "x", kind: name.toLowerCase(), unit, state: { availability, ...(value === undefined ? {} : { value, observedAt: AT }), ...(detail ? { detail } : {}) } });

describe("summaryOf", () => {
  test.each([
    ["switch on", object({ binarySwitch: { state: { availability: "online", value: "on" } } }), "action.on"],
    ["switch off", object({ binarySwitch: { state: { availability: "online", value: "off" } } }), "action.off"],
    ["switch without a value", object({ binarySwitch: { state: { availability: "offline" } } }), "status.notReachable"],
    ["group switch document", object({ binarySwitch: { state: { availability: "online", value: "on" } } }, { status: "online", group: { mixed: false } }), "action.on"],
    ["string light on", object({ stringLight: { state: { availability: "unknown", on: true, lightCount: 3 } } }), "summary.lights{count=3} · action.on"],
    ["string light unknown", object({ stringLight: { state: { availability: "unknown", lightCount: 1 } } }), "summary.lights{count=1} · status.unknown"],
    ["light on with brightness and temperature", object({ light: { state: { availability: "online", on: true, brightnessPercent: 45, colorTemperatureKelvin: 2700 } } }), "action.on · 45% · light.kelvin{kelvin=2,700}"],
    ["light on without readings", object({ light: { state: { availability: "online", on: true } } }), "action.on"],
    ["light off", object({ light: { state: { availability: "online", on: false, brightnessPercent: 45 } } }), "action.off"],
    ["light unreachable", object({ light: { state: { availability: "offline" } } }), "status.notReachable"],
    ["camera online with model and firmware", object({ camera: { state: { availability: "online" } } }, { status: "online", model: "Pet 3T", firmwareVersion: "1.2.3" }), "Pet 3T, camera.firmware{version=1.2.3}"],
    ["camera online with nothing else", object({ camera: { state: { availability: "online" } } }, { status: "online" }), "summary.discovered"],
    ["camera offline", object({ camera: { state: { availability: "offline" } } }, { status: "offline" }), "status.notReachable"],
    ["treat camera offline", object({ camera: { state: { availability: "offline" } }, treatDispenser: {} }, { status: "offline" }), "summary.notDiscovered"],
    ["blaster online", object({ infraredBlaster: {} }, { status: "online" }), "summary.ready"],
    ["rf blaster offline", object({ radioFrequencyBlaster: {} }, { status: "offline" }), "status.notReachable"],
    ["receiver", object({ radioFrequencyReceiver: { state: { availability: "online" } } }), "summary.readyToListen"],
    ["receiver offline", object({ radioFrequencyReceiver: { state: { availability: "offline" } } }), "status.notReachable"],
    ["speaker playing", object({ speaker: { state: { availability: "online", playback: "playing", volumePercent: 30 } } }), "speaker.playing · 30%"],
    ["speaker paused without volume", object({ speaker: { state: { availability: "online", playback: "paused" } } }), "speaker.paused"],
    ["speaker unknown playback", object({ speaker: { state: { availability: "online", playback: "unknown", volumePercent: 5 } } }), "status.unknown · 5%"],
    ["speaker bonded", object({ speaker: { state: { availability: "online", playback: "playing", group: { isCoordinator: false, coordinatorHost: "10.77.0.40" } } } }), "summary.bondedTo{host=10.77.0.40}"],
    ["speaker unreachable", object({ speaker: { state: { availability: "offline" } } }), "status.notReachable"],
    ["button", object({ button: { actions: { press: {} } } }), "summary.button"],
    ["device sensors preview up to three with one decimal", object({}, { status: "online", sensors: [sensor("Temperature", 21.26, "°C"), sensor("Humidity", 40, "%"), sensor("Battery", 88.44, "%"), sensor("Extra", 1, "x")] }), "summary.reading{name=Temperature,value=21.3,unit=°C} · summary.reading{name=Humidity,value=40,unit=%} · summary.reading{name=Battery,value=88.4,unit=%}"],
    ["device sensors degraded", object({}, { status: "degraded", sensors: [sensor("Temperature", 21, "°C"), sensor("Humidity", undefined, "%", "offline")] }), "summary.reading{name=Temperature,value=21,unit=°C} · summary.someUnavailable"],
    ["device sensors without readings use the first detail", object({}, { status: "unknown", sensors: [sensor("Temperature", undefined, "°C", "unknown"), sensor("Humidity", undefined, "%", "unknown", "Waiting")] }), "Waiting"],
    ["device sensors without readings or detail", object({}, { status: "unknown", sensors: [sensor("Temperature", undefined, "°C", "unknown")] }), "sensor.unavailable"],
    ["sensor collection", object({ sensor: { state: { availability: "online", sensors: [reading("PM2.5", 3.14159, "µg/m³"), reading("CO2", 612, "ppm")] } } }), "summary.reading{name=PM2.5,value=3.1,unit=µg/m³} · summary.reading{name=CO2,value=612,unit=ppm}"],
    ["sensor collection degraded", object({ sensor: { state: { availability: "degraded", sensors: [reading("CO2", 612, "ppm"), reading("NOx", undefined, "", "offline")] } } }), "summary.reading{name=CO2,value=612,unit=ppm} · summary.someUnavailable"],
    ["sensor collection offline with detail", object({ sensor: { state: { availability: "offline", detail: "Sleeping", sensors: [] } } }), "Sleeping"],
    ["sensor collection offline", object({ sensor: { state: { availability: "offline", sensors: [] } } }), "status.notReachable"],
    ["sensor collection empty", object({ sensor: { state: { availability: "online", sensors: [] } } }), "sensor.unavailable"],
    ["occupancy occupied", object({ occupancySensor: { state: { availability: "online", occupied: true } } }), "sensor.occupied"],
    ["occupancy clear", object({ occupancySensor: { state: { availability: "online", occupied: false } } }), "sensor.clear"],
    ["occupancy unknown", object({ occupancySensor: { state: { availability: "unknown" } } }), "sensor.unavailable"],
    ["occupancy detail wins", object({ occupancySensor: { state: { availability: "online", occupied: true, detail: "Zone 2" } } }), "Zone 2"],
    ["contact open with battery", object({ contactSensor: { state: { availability: "online", open: true, batteryPercent: 88 } } }), "sensor.open · summary.battery{percent=88%}"],
    ["contact closed", object({ contactSensor: { state: { availability: "online", open: false } } }), "sensor.closed"],
    ["contact unknown", object({ contactSensor: { state: { availability: "unknown" } } }), "sensor.unavailable"],
    ["hub with accessories", object({ hub: { state: { availability: "online", accessories: [{ id: "a", name: "A" }, { id: "b", name: "B" }] } } }), "summary.accessories{count=2}"],
    ["hub without accessories", object({ hub: { state: { availability: "online" } } }), "summary.accessories{count=0}"],
    ["hub detail wins", object({ hub: { state: { availability: "online", detail: "Pairing" } } }), "Pairing"],
  ] as const)("%s", (_name, input, expected) => {
    expect(summaryOf(input, t, number)).toBe(expected);
  });

  test("an object that carries nothing summarises to undefined", () => {
    expect(summaryOf(object({ cooktop: {} }), t, number)).toBeUndefined();
    expect(summaryOf(object({}), t, number)).toBeUndefined();
  });
});

describe("statusView", () => {
  test.each([
    ["checking", { readiness: "checking", stale: false }, { availability: "unknown", summary: "" }],
    ["gone", { readiness: "gone", stale: false, fault: { code: "unconfigured", message: "gone" } }, { availability: "unknown", summary: "gone" }],
    ["fault outranks the last value", { readiness: "offline", stale: false, fault: { code: "unreachable", message: "no answer" }, object: object({ binarySwitch: { state: { availability: "online", value: "on" } } }) }, { availability: "offline", summary: "no answer" }],
    ["online with a summary", { readiness: "online", stale: true, object: object({ binarySwitch: { state: { availability: "online", value: "on" } } }) }, { availability: "online", summary: "action.on", stale: true }],
    ["degraded sensors", { readiness: "degraded", stale: false, object: object({}, { status: "degraded", sensors: [sensor("Temperature", 21, "°C")] }) }, { availability: "degraded", summary: "summary.reading{name=Temperature,value=21,unit=°C} · summary.someUnavailable" }],
  ] as const)("%s", (_name, input, expected) => {
    expect(statusView(input as Parameters<typeof statusView>[0], t, number)).toMatchObject(expected);
  });
});

class TestStatus extends HtStatus {
  constructor() {
    super([], TEMPLATE, "glance");
  }
}

const TEMPLATE = template(`<span part="state"><span part="summary"></span></span>`);

define("test-status", TestStatus);

let client: FakeStateClient;

function mount(node = "device/lamp"): TestStatus & FakeElement {
  const element = dom.document.createElement("test-status") as unknown as TestStatus & FakeElement;
  element.setAttribute("node", node);
  dom.document.body.append(element as unknown as FakeElement);
  return element;
}

const part = (element: FakeElement, name: string) => element.shadowRoot!.querySelector(`[part~="${name}"]`)!;

function record(value: unknown, extra: Partial<NodeRecord> = {}): NodeRecord {
  return { node: "device/lamp", version: 1, updatedAt: AT, observedAt: AT, value, ...extra };
}

beforeEach(() => {
  client = dom.reset();
});

describe("HtStatus", () => {
  test("subscribes at glance and renders checking first, with nothing to say yet", () => {
    const element = mount();
    expect(client.subscriptions[0]).toMatchObject({ node: "device/lamp", tier: "glance" });
    expect(part(element, "summary").hidden).toBe(true);
    expect(element.getAttribute("data-availability")).toBe("unknown");
  });

  test("renders availability on the host and the summary from the whole object; no dot, no word", () => {
    client.push(record({ schemaVersion: 1, id: "lamp", name: "Lamp", status: "online", capabilities: { light: { state: { availability: "online", on: true, brightnessPercent: 45, colorTemperatureKelvin: 2700 } } } }));
    const element = mount();
    expect(element.getAttribute("data-availability")).toBe("online");
    expect(part(element, "summary").textContent).toBe("action.on · 45% · light.kelvin{kelvin=2,700}");
    expect(part(element, "summary").hidden).toBe(false);
    expect(element.hasAttribute("data-stale")).toBe(false);
  });

  test("a stale frame marks the host; a fault turns the host offline and shows the sentence instead of the last value", () => {
    client.push(record({ schemaVersion: 1, id: "lamp", name: "Lamp", status: "online", capabilities: { binarySwitch: { state: { availability: "online", value: "on" } } } }), true);
    const element = mount();
    expect(element.getAttribute("data-stale")).toBe("true");
    expect(part(element, "state").getAttribute("data-stale")).toBe("true");
    client.push(record({ schemaVersion: 1, id: "lamp", name: "Lamp", status: "online", capabilities: { binarySwitch: { state: { availability: "online", value: "on" } } } }, { fault: { code: "unreachable", message: "Lamp did not answer" } }));
    expect(element.getAttribute("data-availability")).toBe("offline");
    expect(part(element, "summary").textContent).toBe("Lamp did not answer");
    expect(element.hasAttribute("data-stale")).toBe(false);
  });

  test("a group node summarises its switch document", () => {
    client.push({ node: "group/g", version: 1, updatedAt: AT, value: { id: "g", name: "G", status: "degraded", capabilities: { binarySwitch: { state: { availability: "degraded" } } }, group: { mixed: true, canSwitch: true, members: [] } } });
    const element = mount("group/g");
    expect(element.getAttribute("data-availability")).toBe("degraded");
    expect(part(element, "summary").textContent).toBe("status.notReachable");
  });

  test("a gone node says so in the summary", () => {
    client.push({ node: "device/lamp", version: 2, updatedAt: AT, fault: { code: "unconfigured", message: "lamp is not in devices.yml" } });
    const element = mount();
    expect(element.getAttribute("data-availability")).toBe("unknown");
    expect(part(element, "summary").textContent).toBe("lamp is not in devices.yml");
  });
});
