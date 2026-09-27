import { beforeEach, describe, expect, test } from "bun:test";
import type { Button } from "../../../schemas.ts";
import type { NodeRecord } from "../../../state/protocol.ts";
import { fakeTranslate, installTestDom, type FakeElement, type FakeStateClient } from "../test-dom.ts";
import type { Translate } from "../view.ts";

const dom = installTestDom();
const { HtButton, buttonView } = await import("./button.ts");
const { define, template } = await import("../dom.ts");

const AT = "2026-09-14T10:00:00.000Z";
const t = fakeTranslate as Translate;
const time = (value: string | number | Date) => `time(${String(value)})`;
const PRESS: Button = { id: "candles", state: { availability: "unknown" }, actions: { press: {} } };
const HOLD: Button = { id: "candles", state: { availability: "unknown" }, actions: { press: { maximumDurationMs: 60_000 } } };

describe("buttonView", () => {
  test.each([
    ["checking", { readiness: "checking", stale: false, pending: false }, { phase: "checking", availability: "unknown", value: "", actions: [], detail: "" }],
    ["gone", { readiness: "gone", stale: false, pending: false, fault: { code: "unconfigured", message: "gone" } }, { phase: "gone", value: "state.gone", detail: "gone", actions: [] }],
    ["offline by fault keeps the press but disabled", { readiness: "offline", stale: false, pending: false, document: PRESS, fault: { code: "unreachable", message: "no answer" } }, { phase: "offline", value: "status.offline", detail: "no answer", actions: [{ id: "press", label: "button.press", primary: true, enabled: false, state: "unknown" }] }],
    ["offline by status", { readiness: "offline", stale: false, pending: false, document: PRESS }, { phase: "offline", detail: "status.notReachable" }],
    ["degraded still presses", { readiness: "degraded", stale: false, pending: false, document: PRESS, observedAt: AT }, { phase: "degraded", value: "status.degraded", availability: "degraded", actions: [{ id: "press", label: "button.press", primary: true, enabled: true, state: "unknown" }] }],
    ["ready", { readiness: "online", stale: false, pending: false, document: PRESS, observedAt: AT }, { phase: "ready", availability: "online", value: "", detail: `status.readAt{time=time(${AT})}` }],
    ["ready with unknown status", { readiness: "unknown", stale: false, pending: false, document: PRESS }, { phase: "ready", availability: "unknown", value: "" }],
    ["stale", { readiness: "online", stale: true, pending: false, document: PRESS, observedAt: AT }, { phase: "ready", detail: `state.stale{time=time(${AT})}` }],
  ] as const)("%s", (_name, input, expected) => {
    expect(buttonView(input as Parameters<typeof buttonView>[0], t, time)).toMatchObject(expected);
  });

  test("hold is offered iff the document bounds a duration", () => {
    expect(buttonView({ readiness: "online", stale: false, pending: false, document: PRESS }, t, time).hold).toBeUndefined();
    expect(buttonView({ readiness: "online", stale: false, pending: false, document: HOLD }, t, time).hold).toEqual({ maximumSeconds: 60 });
  });

  test("checking beats a pending or failed press for the button's own state", () => {
    expect(buttonView({ readiness: "checking", stale: false, pending: true, document: PRESS }, t, time).actions[0]).toMatchObject({ state: "checking" });
  });

  test("pending puts the press in updating and disables it", () => {
    expect(buttonView({ readiness: "online", stale: false, pending: true, document: PRESS }, t, time)).toMatchObject({ busy: true, feedback: { message: "" }, actions: [{ enabled: false, state: "updating" }] });
  });

  test("an error puts the press in failure and keeps a kept notice as the feedback otherwise", () => {
    expect(buttonView({ readiness: "online", stale: false, pending: false, document: PRESS, error: "The press failed" }, t, time)).toMatchObject({ feedback: { message: "The press failed", tone: "bad" }, actions: [{ state: "failure" }] });
    expect(buttonView({ readiness: "online", stale: false, pending: false, document: PRESS, notice: { message: "kept", tone: "ok" } }, t, time)).toMatchObject({ feedback: { message: "kept", tone: "ok" }, actions: [{ state: "unknown" }] });
    expect(buttonView({ readiness: "online", stale: false, pending: false, document: PRESS, error: "x", notice: { message: "kept" } }, t, time).feedback.message).toBe("x");
  });
});

class TestButton extends HtButton {
  constructor() {
    super([], TEMPLATE, "live");
  }
}

const TEMPLATE = template(`<div part="state"><span part="value"></span><span part="detail"></span></div>
  <div part="actions"><button data-action="press"></button></div>
  <label part="hold-field"><input part="hold" type="number" min="0" step="0.1" value="0"></label>`);

define("test-button", TestButton);

function record(document: Button, status = "online", extra: Partial<NodeRecord> = {}): NodeRecord {
  return { node: "device/candles", version: 1, updatedAt: AT, observedAt: AT, value: { schemaVersion: 1, id: "candles", name: "Candles", status, capabilities: { button: document } }, ...extra };
}

let client: FakeStateClient;

function mount(): TestButton & FakeElement {
  const element = dom.document.createElement("test-button") as unknown as TestButton & FakeElement;
  element.setAttribute("node", "device/candles");
  dom.document.body.append(element as unknown as FakeElement);
  return element;
}

const part = (element: FakeElement, name: string) => element.shadowRoot!.querySelector(`[part~="${name}"]`)!;
const press = (element: FakeElement) => element.shadowRoot!.querySelector('[data-action="press"]')!;
const tick = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

beforeEach(() => {
  client = dom.reset();
});

describe("HtButton", () => {
  test("renders ready with the hold field hidden for a momentary button", () => {
    client.push(record(PRESS));
    const element = mount();
    expect(element.getAttribute("data-phase")).toBe("ready");
    expect(part(element, "value").hidden).toBe(true);
    expect(press(element).textContent).toBe("button.press");
    expect(press(element).dataset.state).toBe("unknown");
    expect(press(element).hidden).toBe(false);
    expect(part(element, "hold-field").hidden).toBe(true);
  });

  test("a press sends no value, shows updating, then settles back to unknown", async () => {
    client.push(record(PRESS));
    const element = mount();
    press(element).click();
    expect(client.invocations).toEqual([{ node: "device/candles", capability: "button", controlId: "press", value: undefined }]);
    expect(press(element).dataset.state).toBe("updating");
    expect(press(element).getAttribute("aria-disabled")).toBe("true");
    client.settle();
    await tick();
    expect(press(element).dataset.state).toBe("unknown");
    expect(press(element).hasAttribute("aria-disabled")).toBe(false);
  });

  test("a hold button shows the field with the document's maximum and sends { durationMs }", () => {
    client.push(record(HOLD));
    const element = mount();
    expect(part(element, "hold-field").hidden).toBe(false);
    expect(part(element, "hold").getAttribute("max")).toBe("60");
    (part(element, "hold") as unknown as { value: string }).value = "2.5";
    press(element).click();
    expect(client.invocations[0]).toMatchObject({ controlId: "press", value: { durationMs: 2500 } });
  });

  test("press(durationMs) is the typed path", async () => {
    client.push(record(HOLD));
    const element = mount();
    const promise = element.press(500);
    expect(client.invocations[0]).toMatchObject({ value: { durationMs: 500 } });
    client.settle();
    expect(await promise).toBe(true);
    void element.press();
    expect(client.invocations[1]?.value).toBeUndefined();
    client.settle();
  });

  test("a failed press puts the button in failure with the message in its title and keeps the phase", async () => {
    client.push(record(PRESS));
    const element = mount();
    void element.press();
    client.fail("The press failed");
    await tick();
    expect(press(element).dataset.state).toBe("failure");
    expect(press(element).getAttribute("title")).toBe("The press failed");
    expect(element.getAttribute("data-phase")).toBe("ready");
  });

  test("an offline device keeps the button visible but disabled, with the fault's sentence", () => {
    client.push(record(PRESS, "online", { fault: { code: "unreachable", message: "Candles did not answer" } }));
    const element = mount();
    expect(element.getAttribute("data-phase")).toBe("offline");
    expect(part(element, "detail").textContent).toBe("Candles did not answer");
    expect(press(element).hidden).toBe(false);
    expect(press(element).getAttribute("aria-disabled")).toBe("true");
  });
});
