import { beforeEach, describe, expect, test } from "bun:test";
import type { Television } from "../../../schemas.ts";
import type { NodeRecord } from "../../../state/protocol.ts";
import { fakeTranslate, installTestDom, type FakeElement, type FakeStateClient } from "../test-dom.ts";
import type { Translate } from "../view.ts";

const dom = installTestDom();
const { HtTelevision, televisionView } = await import("./television.ts");
const { define, template } = await import("../dom.ts");

const AT = "2026-09-18T20:00:00.000Z";
const t = fakeTranslate as Translate;
const time = (value: string | number | Date) => `time(${String(value)})`;

const KEYS = ["up", "down", "left", "right", "select", "play", "pause"] as const;
const ACTIONS = {
  turnOn: {},
  turnOff: {},
  press: { keys: [...KEYS] },
  volumeUp: {},
  volumeDown: {},
  toggleMute: {},
  setArtMode: {},
  setInput: { inputs: [{ id: "hdmi1", name: "HDMI 1" }, { id: "hdmi2", name: "HDMI 2" }] },
  getState: {},
} as unknown as Television["actions"];

/** A plain set: no art mode and no input list, so both parts must disappear. */
const PLAIN_ACTIONS = { turnOn: {}, turnOff: {}, press: { keys: ["up", "select"] }, volumeUp: {}, volumeDown: {}, toggleMute: {}, getState: {} } as unknown as Television["actions"];

function doc(state: Television["state"], actions: Television["actions"] = ACTIONS): Television {
  return { id: "frame", state, actions };
}

const on = (artMode?: "on" | "off") => doc({ availability: "online", power: "on", observedAt: AT, ...(artMode ? { artMode } : {}) } as Television["state"]);
const standby = () => doc({ availability: "online", power: "standby", observedAt: AT } as Television["state"]);

describe("televisionView", () => {
  test.each([
    ["checking", { readiness: "checking", stale: false }, { phase: "checking", availability: "unknown", value: "", detail: "" }],
    ["gone", { readiness: "gone", stale: false, fault: { code: "unconfigured", message: "frame is not in devices.yml" } }, { phase: "gone", availability: "unknown", value: "state.gone", detail: "frame is not in devices.yml" }],
    ["offline by fault", { readiness: "offline", stale: false, document: on(), fault: { code: "unreachable", message: "no answer" }, observedAt: AT }, { phase: "offline", availability: "offline", detail: "no answer" }],
    ["offline by availability", { readiness: "offline", stale: false, document: doc({ availability: "offline" }) }, { phase: "offline", availability: "offline", detail: "status.notReachable" }],
    ["on", { readiness: "online", stale: false, document: on("off"), observedAt: AT }, { phase: "on", availability: "online", value: "", detail: `status.readAt{time=time(${AT})}` }],
    ["art mode is a phase of its own while the set is on", { readiness: "online", stale: false, document: on("on"), observedAt: AT }, { phase: "art", availability: "online", value: "tv.artMode" }],
    ["standby", { readiness: "online", stale: false, document: standby(), observedAt: AT }, { phase: "standby", availability: "online", value: "" }],
    ["stale says when it was last read", { readiness: "online", stale: true, document: on(), observedAt: AT }, { phase: "on", detail: `state.stale{time=time(${AT})}` }],
    ["a document with no power reading is unknown, not off", { readiness: "online", stale: false, document: doc({ availability: "online" }) }, { phase: "unknown", availability: "online" }],
  ] as const)("%s", (_name, input, expected) => {
    expect(televisionView(input as Parameters<typeof televisionView>[0], t, time)).toMatchObject(expected);
  });

  test("power reads on while art is showing, because art is something an on set does", () => {
    const view = televisionView({ readiness: "online", stale: false, document: on("on") }, t, time);
    expect(view.actions.map((action) => [action.id, action.state])).toEqual([["turnOn", "active"], ["turnOff", "inactive"], ["getState", "unknown"]]);
  });

  test("standby presses the off side", () => {
    const view = televisionView({ readiness: "online", stale: false, document: standby() }, t, time);
    expect(view.actions.map((action) => [action.id, action.state])).toEqual([["turnOn", "inactive"], ["turnOff", "active"], ["getState", "unknown"]]);
  });

  test("art mode is its own on/off pair, pressed on the side the set reports", () => {
    expect(televisionView({ readiness: "online", stale: false, document: on("on") }, t, time).art.map((a) => [a.id, a.label, a.state]))
      .toEqual([["artOn", "tv.showArt", "active"], ["artOff", "tv.leaveArt", "inactive"]]);
    expect(televisionView({ readiness: "online", stale: false, document: on("off") }, t, time).art.map((a) => a.state))
      .toEqual(["inactive", "active"]);
    // Art mode the set has not reported presses neither side rather than guessing.
    expect(televisionView({ readiness: "online", stale: false, document: on() }, t, time).art.map((a) => a.state))
      .toEqual(["unknown", "unknown"]);
  });

  test("a set with no art mode has no art buttons at all", () => {
    const view = televisionView({ readiness: "online", stale: false, document: doc({ availability: "online", power: "on", observedAt: AT } as Television["state"], PLAIN_ACTIONS) }, t, time);
    expect(view.art).toEqual([]);
    expect(view.inputs).toEqual([]);
    expect(view.keys).toEqual(["up", "select"]);
  });

  test("only the keys the set declares are offered", () => {
    expect(televisionView({ readiness: "online", stale: false, document: on() }, t, time).keys).toEqual([...KEYS]);
  });

  test("the input list comes from the document, with the current one marked", () => {
    const document = doc({ availability: "online", power: "on", observedAt: AT, input: { id: "hdmi2" } } as Television["state"]);
    expect(televisionView({ readiness: "online", stale: false, document }, t, time).inputs).toEqual([
      { id: "hdmi1", label: "HDMI 1", current: false },
      { id: "hdmi2", label: "HDMI 2", current: true },
    ]);
  });

  test("a power command in flight updates both power buttons and leaves art alone", () => {
    const view = televisionView({ readiness: "online", stale: false, document: on("off"), pending: "turnOff" }, t, time);
    expect(view.actions.filter((a) => a.id !== "getState").map((a) => a.state)).toEqual(["updating", "updating"]);
    expect(view.art.map((a) => a.state)).toEqual(["inactive", "active"]);
    expect(view.busy).toBe(true);
  });

  test("an art failure colours only the art pair, and its sentence is the feedback", () => {
    const view = televisionView({ readiness: "online", stale: false, document: on("off"), error: "Television refused the request", errorControl: "setArtMode" }, t, time);
    expect(view.art.map((a) => a.state)).toEqual(["failure", "failure"]);
    expect(view.actions.map((a) => a.state)).toEqual(["active", "inactive", "unknown"]);
    expect(view.feedback).toEqual({ message: "Television refused the request", tone: "bad" });
  });

  test("volume and mute read as plain commands, not as a pair whose side is unknown", () => {
    const view = televisionView({ readiness: "online", stale: false, document: on() }, t, time);
    expect(view.volume.map((a) => [a.id, a.state])).toEqual([["volumeDown", "inactive"], ["toggleMute", "inactive"], ["volumeUp", "inactive"]]);
    const failed = televisionView({ readiness: "online", stale: false, document: on(), error: "no", errorControl: "toggleMute" }, t, time);
    expect(failed.volume.map((a) => a.state)).toEqual(["inactive", "failure", "inactive"]);
    const pending = televisionView({ readiness: "online", stale: false, document: on(), pending: "volumeUp" }, t, time);
    expect(pending.volume.map((a) => a.state)).toEqual(["inactive", "inactive", "updating"]);
  });
});

class TestTelevision extends HtTelevision {
  constructor() {
    super([], TEMPLATE, "live");
  }
}

const keyButton = (key: string) => `<button data-action="key" data-key="${key}"></button>`;
const TEMPLATE = template(`<div part="state"><span part="value"></span><span part="detail"></span></div>
  <div part="actions"><button data-action="turnOn"></button><button data-action="turnOff"></button><button data-action="getState"></button></div>
  <div part="art"><button data-action="artOn"></button><button data-action="artOff"></button></div>
  <div part="input-field"><label part="input-label"></label><select part="input"></select></div>
  <div part="keys">${["up", "down", "left", "right", "select", "play", "pause", "home"].map(keyButton).join("")}</div>
  <div part="volume"><button data-action="volumeDown"></button><button data-action="toggleMute"></button><button data-action="volumeUp"></button></div>
  <p part="feedback"></p>`);

define("test-television", TestTelevision);

function record(state: Television["state"], actions: Television["actions"] = ACTIONS, extra: Partial<NodeRecord> = {}): NodeRecord {
  return {
    node: "device/frame",
    version: 1,
    updatedAt: AT,
    ...(state.observedAt ? { observedAt: state.observedAt } : {}),
    value: { schemaVersion: 1, id: "frame", name: "Frame", status: state.availability, capabilities: { television: doc(state, actions) } },
    ...extra,
  };
}

let client: FakeStateClient;

function mount(node = "device/frame"): TestTelevision & FakeElement {
  const element = dom.document.createElement("test-television") as unknown as TestTelevision & FakeElement;
  element.setAttribute("node", node);
  dom.document.body.append(element as unknown as FakeElement);
  return element;
}

const part = (element: FakeElement, name: string) => element.shadowRoot!.querySelector(`[part~="${name}"]`)!;
const button = (element: FakeElement, action: string) => element.shadowRoot!.querySelector(`[data-action="${action}"]`)!;
const keyEl = (element: FakeElement, key: string) => element.shadowRoot!.querySelector(`[data-key="${key}"]`)!;
const tick = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });
/** Click, let the command reach the client, then let the client answer it — a second click is ignored until it does. */
async function send(target: unknown, settle: () => void): Promise<void> {
  (target as { click: () => void }).click();
  await tick();
  settle();
  await tick();
}

beforeEach(() => {
  client = dom.reset();
});

describe("HtTelevision", () => {
  test("hides every control until the first frame says which exist", () => {
    const element = mount();
    expect(element.getAttribute("data-phase")).toBe("unknown");
    for (const id of ["turnOn", "turnOff", "getState", "artOn", "artOff", "volumeUp"]) expect(button(element, id).hidden).toBe(true);
    expect(keyEl(element, "up").hidden).toBe(true);
    expect(part(element, "detail").hidden).toBe(true);
  });

  test("renders a Frame showing art: the word, the read time, and art pressed on", () => {
    client.push(record({ availability: "online", power: "on", artMode: "on", observedAt: AT } as Television["state"]));
    const element = mount();
    expect(element.getAttribute("data-phase")).toBe("art");
    expect(part(element, "value").textContent).toBe("tv.artMode");
    expect(part(element, "detail").textContent).toBe(`status.readAt{time=time(${AT})}`);
    expect(button(element, "artOn").getAttribute("aria-pressed")).toBe("true");
    expect(button(element, "artOff").getAttribute("aria-pressed")).toBe("false");
    expect(button(element, "turnOn").getAttribute("aria-pressed")).toBe("true");
    expect(part(element, "art").hidden).toBe(false);
  });

  test("a set with no art mode hides the whole art part and the input field", () => {
    client.push(record({ availability: "online", power: "on", observedAt: AT } as Television["state"], PLAIN_ACTIONS));
    const element = mount();
    expect(part(element, "art").hidden).toBe(true);
    expect(part(element, "input-field").hidden).toBe(true);
    expect(keyEl(element, "select").hidden).toBe(false);
    expect(keyEl(element, "play").hidden).toBe(true);
  });

  test("only declared keys are shown, and each is labelled from the catalog", () => {
    client.push(record({ availability: "online", power: "on", observedAt: AT } as Television["state"]));
    const element = mount();
    expect(keyEl(element, "select").hidden).toBe(false);
    expect(keyEl(element, "select").textContent).toBe("tv.key.select");
    // `home` is in the template but not in this set's declared keys.
    expect(keyEl(element, "home").hidden).toBe(true);
  });

  test("the input select is filled from the document and preselects the current input", () => {
    client.push(record({ availability: "online", power: "on", observedAt: AT, input: { id: "hdmi2" } } as Television["state"]));
    const element = mount();
    const select = part(element, "input") as unknown as { children: { value: string; textContent: string }[]; value: string };
    expect(part(element, "input-field").hidden).toBe(false);
    expect(part(element, "input-label").textContent).toBe("tv.input");
    expect(select.children.map((option) => [option.value, option.textContent])).toEqual([["hdmi1", "HDMI 1"], ["hdmi2", "HDMI 2"]]);
    expect(select.value).toBe("hdmi2");
  });

  test("clicking a key sends press with that key; art buttons send setArtMode with a boolean", async () => {
    client.push(record({ availability: "online", power: "on", artMode: "off", observedAt: AT } as Television["state"]));
    const element = mount();
    await send(keyEl(element, "select"), () => client.settle());
    expect(client.invocations.at(-1)).toMatchObject({ capability: "television", controlId: "press", value: "select" });
    await send(button(element, "artOn"), () => client.settle());
    expect(client.invocations.at(-1)).toMatchObject({ controlId: "setArtMode", value: true });
    await send(button(element, "artOff"), () => client.settle());
    expect(client.invocations.at(-1)).toMatchObject({ controlId: "setArtMode", value: false });
    await send(button(element, "volumeUp"), () => client.settle());
    expect(client.invocations.at(-1)).toMatchObject({ controlId: "volumeUp" });
  });

  test("a refused command fails only its own pair and puts the reason in the feedback", async () => {
    client.push(record({ availability: "online", power: "on", artMode: "off", observedAt: AT } as Television["state"]));
    const element = mount();
    await send(button(element, "artOn"), () => client.fail("Television refused the set_artmode_status art request"));
    expect(part(element, "feedback").textContent).toBe("Television refused the set_artmode_status art request");
    expect(button(element, "artOn").dataset.state).toBe("failure");
    expect(button(element, "artOff").dataset.state).toBe("failure");
    // The power pair answers a different question and keeps its own reading.
    expect(button(element, "turnOn").dataset.state).toBe("active");
  });

  test("an offline set keeps its buttons but claims no power state", () => {
    client.push(record({ availability: "offline" } as Television["state"]));
    const element = mount();
    expect(element.getAttribute("data-phase")).toBe("offline");
    expect(element.getAttribute("data-availability")).toBe("offline");
    expect(part(element, "detail").textContent).toBe("status.notReachable");
    expect(button(element, "turnOn").getAttribute("aria-pressed")).toBe("false");
    expect(button(element, "turnOff").getAttribute("aria-pressed")).toBe("false");
  });
});
