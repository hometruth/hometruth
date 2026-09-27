import { Service } from "../models/service";
import { EventLog, type EventFilter, type ServiceEventListener } from "../models/event-log";
import { DEFAULT_DOG_CONFIG, parseDogConfig, type DogConfig, type DogConfigStore } from "./dog-config";
import type { DogDetection } from "./dog-frame-detector";

export interface DogDependencies {
  store: DogConfigStore;
  detect(cameraId: string, signal: AbortSignal): Promise<DogDetection>;
  stream?(cameraId: string, signal: AbortSignal): Promise<Response>;
  release?(): void;
  speak(speakerId: string, text: string): Promise<void>;
  validate(config: DogConfig): void;
  now?: () => number;
}

type FailureSource = "settings" | "detection" | "speech";
const RECOVERY_MESSAGE: Record<FailureSource, string> = {
  settings: "Automation settings are ready",
  detection: "Frigate detection recovered — processing fresh camera frames",
  speech: "Speaker announcements recovered",
};

/** Fresh JPEG detections from Frigate → one announcement at most every five seconds. */
export class DogAnnouncer extends Service {
  private config = structuredClone(DEFAULT_DOG_CONFIG);
  private readonly log = new EventLog();
  private timer?: ReturnType<typeof setInterval>;
  private running: Promise<DogDetection | undefined> | undefined;
  private stopped = false;
  private controller?: AbortController;
  private revision = 0;
  private readonly failures = new Map<FailureSource, string>();
  private last: (DogDetection & { at: string }) | undefined;
  private lastAnnouncement = -Infinity;
  private announcing: Promise<void> | undefined;
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly deps: DogDependencies) {
    super("dog-announcer", "Kitchen dog announcer");
  }
  override get switch() { return { enabled: this.config.enabled, setEnabled: (enabled: boolean) => this.setEnabled(enabled) }; }
  override events(limit?: number, filter?: EventFilter) { return this.log.recent(limit, filter); }
  override subscribe(listener: ServiceEventListener, filter?: EventFilter) { return this.log.subscribe(listener, filter); }
  override subjects() { return [this.config.cameraId, this.config.speakerId].filter(Boolean); }
  override status() {
    return { availability: this.failures.size ? "degraded" as const : "online" as const,
      detail: this.failures.size ? [...this.failures.values()].join("; ") : (this.config.enabled ? "Watching for any dog through Frigate" : "Paused — dog announcements are off") };
  }
  view() { return { config: structuredClone(this.config), status: this.status(), busy: !!this.running, last: this.last ?? null }; }
  async stream(cameraId: string, signal: AbortSignal): Promise<Response> {
    if (!this.deps.stream) throw new Error("Camera preview is unavailable");
    return this.deps.stream(cameraId, signal);
  }
  async start(): Promise<void> {
    try {
      this.config = await this.deps.store.load();
      if (this.config.enabled) this.deps.validate(this.config);
      this.schedule();
    } catch (error) { this.fail(error, "settings"); }
  }
  configure(input: unknown): Promise<void> {
    const next = parseDogConfig(input);
    return this.updateConfig(() => next);
  }
  setEnabled(enabled: unknown): Promise<void> {
    if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
    // Read inside the save queue so toggles preserve settings saved just before them.
    return this.updateConfig(() => parseDogConfig({ ...this.config, enabled }));
  }
  private updateConfig(nextConfig: () => DogConfig): Promise<void> {
    const update = this.saving.then(async () => {
      const next = nextConfig();
      if (next.enabled) this.deps.validate(next);
      await this.deps.store.save(next);
      this.revision++;
      this.controller?.abort();
      this.deps.release?.();
      this.config = next;
      this.failures.clear();
      this.last = undefined;
      this.log.record(next.enabled ? "started" : "stopped", next.enabled ? "Dog announcements enabled" : "Dog announcements paused");
      this.schedule();
    });
    this.saving = update.catch(() => undefined);
    return update;
  }
  private schedule() {
    clearInterval(this.timer);
    if (this.stopped || !this.config.enabled) return;
    // Fixed cadence: slow checks skip ticks, without overlap or catch-up bursts.
    this.timer = setInterval(() => { void this.check(); }, this.config.intervalMs);
    this.timer.unref();
  }
  private fail(error: unknown, source: FailureSource = "detection") {
    const message = error instanceof Error ? error.message : String(error);
    const ongoing = this.failures.has(source);
    this.failures.set(source, message);
    // Retry every five seconds, but keep one outage from filling the event log.
    // The current status still reflects the latest failure detail.
    if (!ongoing) this.log.record("automation_error", message.slice(0, 400), { subject: this.config.cameraId, level: "error" });
  }
  private recover(source: FailureSource) {
    if (!this.failures.delete(source)) return;
    this.log.record("automation_recovered", RECOVERY_MESSAGE[source], { subject: this.config.cameraId });
  }
  async check(): Promise<DogDetection | undefined> {
    if (this.running || this.stopped || !this.config.enabled) return undefined;
    const revision = this.revision, config = structuredClone(this.config);
    const controller = this.controller = new AbortController();
    this.running = (async () => {
      try {
        const result = await this.deps.detect(config.cameraId, controller.signal);
        if (this.stopped || revision !== this.revision) return undefined;
        this.recover("detection");
        this.last = { ...result, at: new Date().toISOString() };
        if (!result.dog) return result;
        this.recordDogs("detected", config, result);
        const now = this.deps.now?.() ?? performance.now();
        if (!this.announcing && now - this.lastAnnouncement >= config.cooldownMs) {
          this.lastAnnouncement = now; // Failed attempts also respect the limit.
          // Speaker latency must not hold up the next frame detection.
          this.announcing = this.announce(config, result, revision).finally(() => {
            // Variable speaker latency must not compress the gap between spoken phrases.
            this.lastAnnouncement = this.deps.now?.() ?? performance.now();
            this.announcing = undefined;
          });
        }
        return result;
      } catch (error) { if (revision === this.revision && !this.stopped) this.fail(error); return undefined; }
    })();
    try { return await this.running; } finally { this.running = undefined; }
  }
  private recordDogs(action: "detected" | "announced", config: DogConfig, result: DogDetection) {
    this.log.record(`dog_${action}`, action === "announced" ? `Said “${config.text}”` : "Frigate detected a dog", {
      subject: config.cameraId,
      data: { source: "frigate", camera: result.camera,
        ...(action === "announced" ? { speakerId: config.speakerId, text: config.text } : {}) },
    });
  }
  private async announce(config: DogConfig, result: DogDetection, revision: number): Promise<void> {
    try {
      await this.deps.speak(config.speakerId, config.text);
      if (revision !== this.revision || this.stopped) return;
      this.recover("speech");
      this.recordDogs("announced", config, result);
    } catch (error) { if (revision === this.revision && !this.stopped) this.fail(error, "speech"); }
  }
  /** Preview is silent and does not emit detection events or affect speech timing. */
  async preview(input: unknown): Promise<DogDetection> {
    if (this.running) throw new Error("A camera check is already running; try again shortly");
    const config = parseDogConfig(input);
    this.deps.validate(config);
    const controller = this.controller = new AbortController();
    this.running = (async () => this.deps.detect(config.cameraId, controller.signal))();
    try { return (await this.running)!; } finally { this.running = undefined; }
  }
  override async stop(): Promise<void> {
    this.stopped = true;
    this.revision++;
    clearInterval(this.timer);
    this.controller?.abort();
    this.deps.release?.();
    await this.running?.catch(() => undefined);
    await this.announcing;
  }
}

declare module "../models/device" { interface SiteServices { dogAnnouncer?: DogAnnouncer } }
