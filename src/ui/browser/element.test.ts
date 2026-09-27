import { beforeEach, describe, expect, test } from "bun:test";
import type { NodeRecord } from "../../state/protocol.ts";
import { installTestDom, type FakeElement, type FakeShadowRoot, type FakeStateClient } from "./test-dom.ts";

const dom = installTestDom();
const { HtElement } = await import("./element.ts");
const { define, sheet, template, vocabularySheet } = await import("./dom.ts");

interface SwitchDoc { state: { availability: string; value?: string } }

const TEMPLATE = template(`<div part="state"><span part="mark"></span><span part="value"></span></div>
  <div part="actions"><button data-action="turnOn">on</button><button data-action="toggle">toggle</button><span data-action="getState">refresh</span></div>
  <p part="feedback"></p>`);
const STYLES = sheet(":host { display: block }");

class TestElement extends HtElement<SwitchDoc> {
  renders = 0;
  actions: string[] = [];

  constructor() {
    super([STYLES], TEMPLATE, "live");
  }

  protected get defaultCapability(): string {
    return "binarySwitch";
  }

  protected render(): void {
    this.renders++;
    const value = this.partNamed("value");
    if (value) value.textContent = `${this.readiness}:${this.document?.state.value ?? ""}`;
  }

  protected override onAction(action: string): void {
    this.actions.push(action);
    void this.invoke(action);
  }

  run(controlId: string, value?: unknown): Promise<boolean> {
    return this.invoke(controlId, value);
  }

  say(message: string, tone?: "ok" | "bad"): void {
    this.announce(message, tone);
  }

  keptNotice(): unknown {
    return this.notice;
  }
}

define("test-element", TestElement);
define("test-element", TestElement);

const AT = "2026-09-14T10:00:00.000Z";

function device(value: string | undefined, availability = "online"): NodeRecord {
  return { node: "device/a", version: 1, updatedAt: AT, observedAt: AT, value: { id: "a", status: availability, capabilities: { binarySwitch: { state: { availability, ...(value ? { value } : {}) } }, light: { state: { availability, on: true } } } } };
}

let client: FakeStateClient;

function mount(attributes: Record<string, string> = { node: "device/a" }): TestElement & FakeElement {
  const element = dom.document.createElement("test-element") as unknown as TestElement & FakeElement;
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  element.append(dom.document.createTextNode("Checking…"));
  dom.document.body.append(element as unknown as FakeElement);
  return element;
}

const tick = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });
/** The element's shadow root as the fake, so queries return fake elements (`click()`, `hidden`, …). */
const shadow = (element: FakeElement): FakeShadowRoot => element.shadowRoot!;

beforeEach(() => {
  client = dom.reset();
});

describe("HtElement construction", () => {
  test("the constructor attaches an open, focus-delegating shadow root with the sheets and the template, and leaves the light DOM alone", () => {
    const element = mount();
    const root = shadow(element);
    expect(root.mode).toBe("open");
    expect(root.delegatesFocus).toBe(true);
    expect(root.adoptedStyleSheets as unknown[]).toEqual([STYLES]);
    expect(root.querySelector('[part~="value"]')).not.toBeNull();
    expect(root.querySelectorAll("[data-action]")).toHaveLength(3);
    expect(element.childNodes).toHaveLength(1);
    expect(element.textContent).toBe("Checking…");
    expect(TEMPLATE.content.childNodes.length).toBeGreaterThan(0);
  });

  test("define() is idempotent and vocabularySheet() reads #ht-css once", () => {
    const style = dom.document.createElement("style");
    style.setAttribute("id", "ht-css");
    style.textContent = ".mark { color: red }";
    dom.document.head.append(style);
    const first = vocabularySheet();
    expect((first as unknown as { cssText: string }).cssText).toBe(".mark { color: red }");
    expect(vocabularySheet()).toBe(first);
  });
});

describe("HtElement subscription", () => {
  test("connecting subscribes with the node and tier, rendering unknown immediately when no frame exists", () => {
    const element = mount();
    expect(client.subscriptions).toHaveLength(1);
    expect(client.subscriptions[0]).toMatchObject({ node: "device/a", tier: "live" });
    expect(element.renders).toBe(1);
    expect(element.readiness).toBe("unknown");
    expect(element.shadowRoot!.querySelector('[part~="value"]')!.textContent).toBe("unknown:");
    expect(element.frame).toBeUndefined();
  });

  test("a cached record is delivered on connect; a later frame re-renders and emits ht:frame on the host", () => {
    client.push(device("on"));
    const frames: unknown[] = [];
    dom.document.addEventListener("ht:frame", (event) => { frames.push((event as CustomEvent).detail); });
    const element = mount();
    expect(element.readiness).toBe("online");
    expect(element.shadowRoot!.querySelector('[part~="value"]')!.textContent).toBe("online:on");
    expect(frames).toHaveLength(1);
    client.push(device("off"));
    expect(element.shadowRoot!.querySelector('[part~="value"]')!.textContent).toBe("online:off");
    expect(frames).toHaveLength(2);
    expect(frames[1]).toMatchObject({ node: "device/a", stale: false });
  });

  test("disconnecting releases the subscription; reconnecting subscribes again", () => {
    const element = mount();
    element.remove();
    expect(client.subscriptions[0]?.released).toBe(true);
    dom.document.body.append(element as unknown as FakeElement);
    expect(client.subscriptions).toHaveLength(2);
    expect(client.subscriptions[1]?.released).toBe(false);
  });

  test("changing the node attribute resubscribes and forgets the old frame", () => {
    client.push(device("on"));
    const element = mount();
    element.setAttribute("node", "device/b");
    expect(client.subscriptions[0]?.released).toBe(true);
    expect(client.subscriptions[1]).toMatchObject({ node: "device/b", released: false });
    expect(element.frame).toBeUndefined();
    expect(element.readiness).toBe("unknown");
  });

  test("an attribute that is not a node id leaves the element unbound", () => {
    const element = mount({ node: "shelly" });
    expect(element.node).toBeUndefined();
    expect(client.subscriptions).toHaveLength(0);
    expect(element.readiness).toBe("unknown");
  });

  test("the capability attribute picks another capability from the same object", () => {
    client.push(device("on"));
    const element = mount({ node: "device/a", capability: "light" });
    expect(element.capability).toBe("light");
    expect(element.document as unknown).toEqual({ state: { availability: "online", on: true } });
  });

  test("a group node reads the group switch's binarySwitch", () => {
    client.push({ node: "group/g", version: 1, updatedAt: AT, value: { id: "g", name: "G", status: "degraded", capabilities: { binarySwitch: { state: { availability: "degraded" } } }, group: { mixed: true, canSwitch: true, members: [] } } });
    const element = mount({ node: "group/g" });
    expect(element.document).toEqual({ state: { availability: "degraded" } });
    expect(element.readiness).toBe("degraded");
  });
});

describe("HtElement readiness", () => {
  test.each([
    ["no value and no fault", { node: "device/a", version: 0, updatedAt: AT }, "unknown"],
    ["fault unconfigured", { node: "device/a", version: 1, updatedAt: AT, fault: { code: "unconfigured", message: "gone" } }, "gone"],
    ["fault unreachable with a last value", { ...device("on"), fault: { code: "unreachable", message: "no answer" } }, "offline"],
    ["fault timeout", { node: "device/a", version: 1, updatedAt: AT, fault: { code: "timeout", message: "slow" } }, "offline"],
    ["document availability", device("on", "degraded"), "degraded"],
    ["object status when the capability is missing", { node: "device/a", version: 1, updatedAt: AT, value: { id: "a", status: "offline", capabilities: {} } }, "offline"],
    ["nothing known", { node: "device/a", version: 1, updatedAt: AT, value: { id: "a", capabilities: {} } }, "unknown"],
  ] as const)("%s → %s", (_name, record, expected) => {
    client.push(record as NodeRecord);
    const element = mount();
    expect(element.readiness).toBe(expected);
  });
});

describe("HtElement invoke", () => {
  test("marks the host busy and the action buttons disabled, ignores re-entry, and clears on settle", async () => {
    client.push(device("off"));
    const element = mount();
    const renders = element.renders;
    const first = element.run("turnOn");
    expect(element.pending).toBe(true);
    expect(element.pendingControl).toBe("turnOn");
    expect(element.getAttribute("aria-busy")).toBe("true");
    for (const button of element.shadowRoot!.querySelectorAll("[data-action]")) expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(element.renders).toBe(renders + 1);
    expect(await element.run("toggle")).toBe(false);
    expect(client.invocations).toEqual([{ node: "device/a", capability: "binarySwitch", controlId: "turnOn", value: undefined }]);
    client.settle();
    expect(await first).toBe(true);
    expect(element.pending).toBe(false);
    expect(element.hasAttribute("aria-busy")).toBe(false);
    for (const button of element.shadowRoot!.querySelectorAll("[data-action]")) expect(button.hasAttribute("aria-disabled")).toBe(false);
    expect(element.error).toBeUndefined();
    expect(element.renders).toBe(renders + 2);
  });

  test("a value travels with the control", async () => {
    client.push(device("off"));
    const element = mount();
    const promise = element.run("setBrightness", 40);
    client.settle();
    await promise;
    expect(client.invocations[0]).toMatchObject({ controlId: "setBrightness", value: 40 });
  });

  test("a rejected command keeps the frame, records the error, and clears busy", async () => {
    client.push(device("on"));
    const element = mount();
    const promise = element.run("turnOff");
    client.fail("Shelly did not answer");
    expect(await promise).toBe(false);
    expect(element.error).toBe("Shelly did not answer");
    expect(element.readiness).toBe("online");
    expect(element.document?.state.value).toBe("on");
    expect(element.hasAttribute("aria-busy")).toBe(false);
    const next = element.run("turnOn");
    expect(element.error).toBeUndefined();
    client.settle();
    await next;
  });

  test("without a node or a client nothing is sent", async () => {
    const unbound = mount({ node: "nope" });
    expect(await unbound.run("turnOn")).toBe(false);
    delete dom.window.ht.state;
    const element = mount();
    expect(await element.run("turnOn")).toBe(false);
    expect(client.invocations).toEqual([]);
  });
});

describe("HtElement actions and feedback", () => {
  test("a click on [data-action] inside the shadow root reaches onAction; clicks are ignored while pending", async () => {
    client.push(device("off"));
    const element = mount();
    const on = shadow(element).querySelector('[data-action="turnOn"]')!;
    on.click();
    expect(element.actions).toEqual(["turnOn"]);
    expect(element.pending).toBe(true);
    shadow(element).querySelector('[data-action="toggle"]')!.click();
    expect(element.actions).toEqual(["turnOn"]);
    client.settle();
    await tick();
    shadow(element).querySelector('[data-action="toggle"]')!.click();
    expect(element.actions).toEqual(["turnOn", "toggle"]);
    client.settle();
    await tick();
    shadow(element).querySelector('[part~="value"]')!.click();
    expect(element.actions).toEqual(["turnOn", "toggle"]);
    // A control the view disabled (a group that cannot switch) is not sent either.
    const toggle = shadow(element).querySelector('[data-action="toggle"]')!;
    toggle.setAttribute("aria-disabled", "true");
    toggle.click();
    expect(element.actions).toEqual(["turnOn", "toggle"]);
  });

  test("announce writes the feedback part with its tone and keeps the notice until the next command", async () => {
    client.push(device("off"));
    const element = mount();
    element.say("Pressed", "ok");
    const feedback = element.shadowRoot!.querySelector('[part~="feedback"]')!;
    expect(feedback.textContent).toBe("Pressed");
    expect(feedback.getAttribute("data-tone")).toBe("ok");
    expect(element.keptNotice()).toEqual({ message: "Pressed", tone: "ok" });
    element.say("");
    expect(feedback.textContent).toBe("");
    expect(feedback.hasAttribute("data-tone")).toBe(false);
    expect(element.keptNotice()).toBeUndefined();
    element.say("Kept");
    const promise = element.run("turnOn");
    expect(element.keptNotice()).toBeUndefined();
    client.settle();
    await promise;
  });
});
