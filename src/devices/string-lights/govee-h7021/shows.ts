import { CapabilityError } from "../../../models/capability";
import type { LightState } from "../../../models/light";
import type { LightPreset, LightScene, LightSceneState, LightShow, LightShows, LightShowState } from "../../../models/light-show";
import { scenePackets } from "../../../protocols/govee/effects";
import type { GoveeWholeStringLight } from ".";
import presets from "./govee-presets.json";
import { STATIC_SCENES } from "./static-scenes";

// Govee's SKU catalog (2026-09-12) calls every effect a "scene". HomeTruth
// calls only static arrangements scenes. Explicit speedInfo.supSpeed marks
// animations; missing speed controls do not establish that an effect is static.
const sequences: LightShow[] = [
  { id: "seaside", name: "Seaside", category: "HomeTruth", kind: "sequence", steps: ["wave", "deep-sea", "sea-bottom", "ripple"] },
  { id: "stargazing", name: "Stargazing", category: "HomeTruth", kind: "sequence", steps: ["twilight", "nebula", "aurora", "moonlight"] },
  { id: "enchanted-garden", name: "Enchanted garden", category: "HomeTruth", kind: "sequence", steps: ["forest", "firefly", "flower-field", "cherry-blossoms"] },
  { id: "four-seasons", name: "Four seasons", category: "HomeTruth", kind: "sequence", steps: ["spring", "summer", "fall", "winter"] },
  { id: "winter-holidays", name: "Winter holidays", category: "HomeTruth", kind: "sequence", steps: ["christmas", "christmas-tree", "sled", "christmas-gift"] },
  { id: "haunted-patio", name: "Haunted patio", category: "HomeTruth", kind: "sequence", steps: ["halloween", "halloween-b", "halloween-c", "night"] },
];
const catalog: readonly LightShow[] = [...sequences, ...presets.filter(preset => preset.motion === "animated").map(({ id, name, category }) => ({ id, name, category, kind: "animation" as const }))];

/** Controller animations and static arrangements share one serialized writer.
 * Submission is distinct from hardware observation: LAN has no effect ACK.
 */
export class GoveeShows implements LightShows {
  private state: LightShowState = { status: "idle" };
  private sceneState: LightSceneState = { status: "idle" };
  private baseline: { light: LightState; scene?: LightScene } | undefined;
  private cancelTimer: (() => void) | undefined;
  private generation = 0;
  constructor(private readonly whole: GoveeWholeStringLight, private readonly schedule: (fn: () => void, ms: number) => () => void = (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return () => clearTimeout(timer); }) {}
  getShows(): readonly LightShow[] { return catalog.map(show => ({ ...show, ...(show.steps ? { steps: [...show.steps] } : {}) })); }
  getShowState(): LightShowState { return { ...this.state }; }
  getScenes(): readonly LightScene[] { return STATIC_SCENES.map(scene => ({ ...scene, colors: [...scene.colors] })); }
  getSceneState(): LightSceneState { return { ...this.sceneState }; }
  getPresets(): readonly LightPreset[] { return presets.filter(preset => preset.motion === "unknown").map(({ id, name, category }) => ({ id, name, category })); }
  /** Called inside the controller queue before a manual color/power command. */
  cancel(): void {
    this.generation++;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.state = { status: "idle" };
    this.sceneState = { status: "idle" };
    this.baseline = undefined;
  }
  async applyScene(value: unknown): Promise<void> {
    const scene = STATIC_SCENES.find(candidate => candidate.id === value);
    if (!scene) throw new CapabilityError("applyScene takes a static scene ID from getScenes", "invalid_value");
    await this.whole.runExclusive(async () => {
      const light = await this.whole.readState();
      this.cancel();
      try {
        if (!light.on) await this.whole.sendVerified("turn", { value: 1 }, state => state.onOff === 1);
        await this.whole.writeArrangement(scene.colors);
        this.sceneState = { status: "submitted", sceneId: scene.id, appliedAt: new Date().toISOString() };
      } catch (error) {
        this.sceneState = { status: "error", detail: this.errorText(error) };
        throw error;
      }
    });
  }
  async playShow(value: unknown): Promise<void> {
    const input = typeof value === "string" ? { id: value } : value;
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new CapabilityError("playShow takes a show ID or { id, stepSeconds }", "invalid_value");
    const { id, stepSeconds = 45 } = input as { id?: unknown; stepSeconds?: unknown };
    const show = catalog.find(candidate => candidate.id === id);
    if (!show || Object.keys(input).some(key => key !== "id" && key !== "stepSeconds") || typeof stepSeconds !== "number" || !Number.isInteger(stepSeconds) || stepSeconds < 10 || stepSeconds > 600) throw new CapabilityError("Choose a known animated show and 10–600 seconds per step", "invalid_value");
    await this.play(show, stepSeconds);
  }
  async applyPreset(value: unknown): Promise<void> {
    const preset = this.getPresets().find(candidate => candidate.id === value);
    if (!preset) throw new CapabilityError("applyPreset takes a Govee preset ID from getPresets", "invalid_value");
    await this.play({ ...preset, kind: "animation" }, 45, true);
  }
  private async play(show: LightShow, stepSeconds: number, unclassified = false): Promise<void> {
    await this.whole.runExclusive(async () => {
      const previousScene = STATIC_SCENES.find(scene => this.sceneState.status === "submitted" && scene.id === this.sceneState.sceneId);
      const baseline = this.baseline ?? { light: await this.whole.readState(), ...(previousScene ? { scene: previousScene } : {}) };
      this.cancel();
      this.whole.clearBulbState();
      this.baseline = baseline;
      const generation = this.generation;
      this.state = { status: "submitted", ...(unclassified ? { presetId: show.id } : { showId: show.id }), startedAt: new Date().toISOString(), ...(show.kind === "sequence" ? { stepSeconds } : {}) };
      try {
        if (!baseline.light.on) await this.whole.sendVerified("turn", { value: 1 }, state => state.onOff === 1);
        await this.step(show, 0, stepSeconds, generation);
      } catch (error) { this.failed(error); throw error; }
    });
  }
  private errorText(error: unknown): string { return (error instanceof Error ? error.message : "Light command failed").slice(0, 500); }
  private failed(error: unknown): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.state = { ...this.state, status: "error", detail: this.errorText(error) };
  }
  private async step(show: LightShow, index: number, seconds: number, generation: number): Promise<void> {
    if (generation !== this.generation) return;
    const id = show.steps ? show.steps[index % show.steps.length]! : show.id;
    const effect = presets.find(candidate => candidate.id === id)!;
    await this.whole.readState(); // Reachability check, not a playback acknowledgment.
    await this.whole.transport.send(this.whole.config.host, "ptReal", { command: scenePackets(effect.code, effect.parameters) });
    this.state = { ...this.state, status: show.kind === "sequence" ? "running" : "submitted", effectId: id };
    if (show.kind === "sequence") {
      this.cancelTimer = this.schedule(() => {
        void this.whole.runExclusive(async () => {
          if (generation !== this.generation) return;
          try { await this.step(show, index + 1, seconds, generation); } catch (error) { this.failed(error); }
        });
      }, seconds * 1000);
    }
  }
  async stopShow(): Promise<void> {
    await this.whole.runExclusive(async () => {
      const baseline = this.baseline;
      const previous = this.state;
      // A redundant stop must not erase the identity of a static scene.
      if (!baseline && this.state.status === "idle") return;
      this.cancel();
      this.whole.clearBulbState();
      if (!baseline) return;
      try {
        await this.whole.restoreState(baseline.light);
        if (baseline.scene) {
          await this.whole.writeArrangement(baseline.scene.colors);
          this.sceneState = { status: "submitted", sceneId: baseline.scene.id, appliedAt: new Date().toISOString() };
        }
      } catch (error) { this.baseline = baseline; this.state = previous; this.failed(error); throw error; }
    });
  }
  async close(): Promise<void> { await this.stopShow(); }
}
