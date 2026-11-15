import { expect, test } from "bun:test";
import { Light, type LightState } from "../models/light";
import { Device, type DeviceModel } from "../models/device";
import { LightGroupCapability } from "../devices/composites/light-group";
import { deviceRuntime } from "./device-runtime";
import { validateWorkflowTargets, workflowCatalog } from "./catalog";
import { definition, end } from "../../tests/fixtures/workflow";
import { dinnerBellWav } from "./sounds";
class MemoryLight extends Light {
  constructor(id: string, public state: LightState) { super(id); }
  async turnOn() { this.state.on = true; }
  async turnOff() { this.state.on = false; }
  async toggle() { this.state.on = !this.state.on; }
  async setBrightness(value: number) { this.state.brightnessPercent = value; }
  async setColorTemperature(value: number) { this.state.colorTemperatureKelvin = value; }
  override async setColor(value: string) { this.state.color = value; }
  override supportsColor() { return true; }
  async getState() { return structuredClone(this.state); }
}
class Target extends Device {
  readonly model = { id: "test-light", capabilities: ["light"] } as unknown as DeviceModel;
  readonly capabilities;
  constructor(id: string, light: Light) { super(id, id, {}); this.capabilities = { light }; }
  async probe() { return {}; }
}
const flash = { target: "group", operation: "light.flash", input: { colors: ["#ff0000", "#ffff00"], count: 2, onMs: 100, offMs: 100, brightnessPercent: 75 } };
test("cancelling a group flash restores every member's own color, brightness and power", async () => {
  const a = new MemoryLight("a", { on: false, brightnessPercent: 20, color: "#0000ff" });
  const b = new MemoryLight("b", { on: true, brightnessPercent: 60, color: "#00ff00" });
  const original = [await a.getState(), await b.getState()];
  const target = new Target("group", new LightGroupCapability("group", [a, b]));
  const runtime = deviceRuntime(new Map([[target.id, target]]));
  const abort = new AbortController(); const timer = setTimeout(() => abort.abort(new Error("cancelled")), 20);
  await expect(runtime.action(flash, abort.signal)).rejects.toThrow("cancelled"); clearTimeout(timer);
  expect([a.state, b.state]).toEqual(original);
});
test("target validation rejects unsupported operations, wrong input types, and imported confirmation", () => {
  const target = new Target("group", new MemoryLight("a", { on: true, brightnessPercent: 20, color: "#0000ff" }));
  const workflow = definition([{ id: "flash", type: "action", action: structuredClone(flash), next: "done", onError: "failed" }, end(), end("failed", "failure")]);
  validateWorkflowTargets(workflow, [target]); expect(workflowCatalog([target])[0]!.operations[0]!.id).toBe("light.flash");
  const node = workflow.graph.nodes[0]!; if (node.type !== "action") throw new Error();
  node.action.input.confirmed = true; expect(() => validateWorkflowTargets(workflow, [target])).toThrow("additional properties");
  delete node.action.input.confirmed; node.action.input.count = "two"; expect(() => validateWorkflowTargets(workflow, [target])).toThrow();
  node.action.operation = "unknown"; expect(() => validateWorkflowTargets(workflow, [target])).toThrow("does not support");
});
test("built-in dinner bell is a bounded, deterministic PCM WAV", () => {
  const bytes = dinnerBellWav(); const view = new DataView(bytes.buffer);
  expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF"); expect(view.getUint32(24, true)).toBe(24000);
  expect(view.getUint32(40, true)).toBe(24000 * 3 * 2); expect(bytes.length).toBe(144044);
});

import { Speaker, type SpeakerState } from "../models/speaker";
class MemorySpeaker extends Speaker {
  state: SpeakerState = { playback: "stopped", volumePercent: 15, muted: true, group: { coordinatorHost: "speaker", isCoordinator: true, memberHosts: ["speaker"] } };
  calls: string[] = [];
  async getState() { return structuredClone(this.state); }
  async play() { this.state.playback = "playing"; }
  async pause() { this.state.playback = "paused"; }
  async stop() { this.calls.push("stop"); this.state.playback = "stopped"; }
  async setVolume(v: number) { this.state.volumePercent = v; }
  async setMute(v: boolean) { this.state.muted = v; }
  async playUri() {}
  async joinGroup() {}
  async leaveGroup() {}
  override supportsSounds() { return true; }
  override async playSound() { this.calls.push("bell"); this.state.playback = "playing"; }
}
class SpeakerTarget extends Device {
  readonly model = { id: "test-speaker", capabilities: ["speaker"] } as unknown as DeviceModel;
  readonly capabilities;
  constructor(speaker: MemorySpeaker) { super("speaker", "Example speaker", {}); this.capabilities = { speaker }; }
  async probe() { return {}; }
}
test("cancelling a sound restores volume and mute; grouped or playing speakers are untouched", async () => {
  const speaker = new MemorySpeaker("speaker"); const device = new SpeakerTarget(speaker);
  const runtime = deviceRuntime(new Map([["speaker", device]])); const sound = { target: "speaker", operation: "speaker.playSound", input: { sound: "dinnerBell", volumePercent: 50 } };
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(new Error("cancelled")), 20);
  await expect(runtime.action(sound, controller.signal)).rejects.toThrow("cancelled"); clearTimeout(timer);
  expect(speaker.state).toMatchObject({ playback: "stopped", volumePercent: 15, muted: true }); expect(speaker.calls).toEqual(["bell", "stop"]);
  speaker.calls = []; speaker.state.group.memberHosts = ["speaker", "other"];
  await expect(runtime.action(sound, new AbortController().signal)).rejects.toThrow("ungrouped"); expect(speaker.calls).toEqual([]);
});
