import { describe, expect, test } from "bun:test";
import { Button, type ButtonPressOptions } from "../models/button";
import { BinarySwitch, type BinarySwitchState } from "../models/binary-switch";
import { Device, type DeviceIdentity, type DeviceModel } from "../models/device";
import { binarySwitchSchema, buttonSchema } from "../schemas";
import { Site } from "../site";
import { validators } from "../validation";
import { createApp } from "./app";
import { WORKFLOW_BUTTON, WorkflowButtonDevice } from "../devices/composites/workflow-button";
import type { DeviceConfigWriter } from "../config/device-writer";

class MemoryButton extends Button {
  readonly presses: ButtonPressOptions[] = [];
  protected override maximumDurationMs() { return 2_000; }
  protected async performPress(options: ButtonPressOptions) { this.presses.push(options); }
}

const MODEL = {
  id: "test-button", title: "Test button", manufacturer: "Test", product: "Button", capabilities: ["button"], connectionTypes: ["direct-local"],
  configSchema: { $id: "test", type: "object" }, objectSchemaId: buttonSchema.$id,
} as unknown as DeviceModel;

class ButtonDevice extends Device {
  readonly model = MODEL;
  readonly capabilities;
  constructor(readonly button: MemoryButton) { super("candles-on", "Candles on", {}); this.capabilities = { button }; }
  async probe(): Promise<DeviceIdentity> { return {}; }
}

const SWITCH_MODEL = {
  id: "test-switch", title: "Test switch", manufacturer: "Test", product: "Switch", capabilities: ["binarySwitch"], connectionTypes: ["direct-local"],
  configSchema: { $id: "test-switch", type: "object" }, objectSchemaId: binarySwitchSchema.$id,
} as unknown as DeviceModel;

class MemorySwitch extends BinarySwitch {
  constructor(override readonly id: string, private state: BinarySwitchState = "off") { super(id); }
  async turnOn(): Promise<void> { this.state = "on"; }
  async turnOff(): Promise<void> { this.state = "off"; }
  async toggle(): Promise<void> { this.state = this.state === "on" ? "off" : "on"; }
  async getState(): Promise<BinarySwitchState> { return this.state; }
}

class SwitchDevice extends Device {
  readonly model = SWITCH_MODEL;
  readonly capabilities;
  constructor(readonly relay: MemorySwitch) { super("relay", "Relay", {}); this.capabilities = { binarySwitch: relay }; }
  async probe(): Promise<DeviceIdentity> { return {}; }
}

function workflowSite(): { site: Site; relay: SwitchDevice; writer: DeviceConfigWriter; saved: { workflow?: unknown; added: unknown[] } } {
  const relay = new SwitchDevice(new MemorySwitch("relay"));
  const workflow = new WorkflowButtonDevice({ id: "cycle", name: "Cycle" }, { workflow: {
    start: "on",
    nodes: [
      { id: "on", type: "action", device: "relay", control: "turnOn", next: "wait" },
      { id: "wait", type: "delay", durationMs: 0, next: "off" },
      { id: "off", type: "action", device: "relay", control: "turnOff", next: "done" },
      { id: "done", type: "end" },
    ],
  } }, {}, { device: (id) => id === relay.id ? relay : (() => { throw new Error(`Unknown ${id}`); })() });
  const saved: { workflow?: unknown; added: unknown[] } = { added: [] };
  const writer: DeviceConfigWriter = {
    add: async (entry) => { saved.added.push(entry); },
    addAll: async () => undefined,
    rename: async () => undefined,
    setWorkflow: async (_id, workflowDefinition) => { saved.workflow = workflowDefinition; },
  };
  return { site: new Site([relay, workflow], [SWITCH_MODEL, WORKFLOW_BUTTON]), relay, writer, saved };
}

describe("button routes", () => {
  test("renders the Button page and supports momentary or duration-aware presses", async () => {
    const button = new MemoryButton("candles-on");
    const app = createApp(undefined, new Site([new ButtonDevice(button)], [MODEL]));
    const page = await app.request("/buttons/candles-on");
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<ht-button node="device/candles-on">');
    expect(html).toContain("Checking…");
    expect(html).not.toContain('id="press"');

    const document = await app.request("/api/buttons/candles-on");
    expect(document.status).toBe(200);
    expect(validators.button(await document.json())).toBe(true);
    expect(button.presses).toEqual([]);

    for (const body of [{}, { durationMs: 1_500 }]) {
      const response = await app.request("/api/buttons/candles-on/press", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
    }
    expect(button.presses).toEqual([{}, { durationMs: 1_500 }]);

    const invalid = await app.request("/api/buttons/candles-on/press", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ durationMs: 2_001 }),
    });
    expect(invalid.status).toBe(400);
  });

  test("creates, edits, runs, and reports a Workflow Button as a stateless Button", async () => {
    const { site, relay, writer, saved } = workflowSite();
    const app = createApp(undefined, site, undefined, undefined, undefined, undefined, undefined, writer);

    const page = await app.request("/buttons/cycle");
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("data-steps-editor");
    expect(html).toContain("Edit as state machine");
    expect(await (await app.request("/buttons")).text()).toContain("Create Workflow Button");

    const document = await app.request("/api/buttons/cycle/workflow");
    expect(document.status).toBe(200);
    expect((await document.json()).workflow.start).toBe("on");

    const pressed = await app.request("/api/buttons/cycle/press", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(pressed.status).toBe(200);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(await relay.relay.getState()).toBe("off");
    expect((await (await app.request("/api/buttons/cycle/workflow")).json()).run.status).toBe("complete");

    const invalid = await app.request("/api/buttons/cycle/workflow", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ workflow: { start: "missing", nodes: [{ id: "done", type: "end" }] } }),
    });
    expect(invalid.status).toBe(400);
    expect(saved.workflow).toBeUndefined();

    const updated = { start: "done", nodes: [{ id: "done", type: "end" as const }] };
    const edited = await app.request("/api/buttons/cycle/workflow", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ workflow: updated }),
    });
    expect(edited.status).toBe(200);
    expect(saved.workflow).toEqual(updated);

    const duplicate = await app.request("/api/buttons", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "cycle", name: "Another" }),
    });
    expect(duplicate.status).toBe(409);

    const created = await app.request("/api/buttons", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "new-button", name: "New Button" }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ id: "new-button", page: "/buttons/new-button" });
    expect(saved.added).toEqual([{ id: "new-button", name: "New Button", model: "workflow-button", config: { workflow: { start: "start", nodes: [{ id: "start", type: "end", label: "Complete" }] } } }]);
  });
});
