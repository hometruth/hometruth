import { spawn, type ChildProcess } from "node:child_process";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventLog, type EventFilter, type ServiceEventListener } from "../models/event-log";
import { Service, type ServiceStatus } from "../models/service";
import type { Site } from "../site";
import type { StateHub } from "../state/hub";
import type { DeviceEventLogs } from "../models/device-event-log";
import type { Button } from "../models/button";
import { elementKey } from "../tags/identity";
import type { Camera } from "../models/camera";
import { captureCameraSnapshot, cameraUriWithCredentials } from "../camera-media";
import { BridgeAdapter } from "./adapter";
import { BridgeStore } from "./store";
import { ACCESSORY_PROFILES } from "./profiles";
import { BridgeError, type BridgeDefinition, type BridgeStatus, type ExportAccessory } from "./model";

declare module "../models/device" { interface SiteServices { appleBridges?: BridgeService } }
interface Worker { child: ChildProcess; revision: string; status: BridgeStatus; lastSeen: number; exports: ExportAccessory[]; failures: number; }
const idle = (detail: string): BridgeStatus => ({ running: false, paired: false, updatedAt: new Date().toISOString(), detail, accessories: 0, reachable: 0 });

export class BridgeService extends Service {
  readonly store: BridgeStore;
  private adapterValue?: BridgeAdapter;
  private workers = new Map<string, Worker>();
  private errors = new Map<string, string>();
  private log = new EventLog(200);
  private running = false;
  private pending: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private releases: (() => void)[] = [];
  private watchers = new Map<string, Set<(status: BridgeStatus) => void>>();
  private published = new Map<string, string>();
  constructor(store = new BridgeStore(), private readonly storage = resolve(".hometruth/bridges")) {
    super("apple-bridges", "Apple Home bridges"); this.store = store;
  }
  configure(site: Site, hub: StateHub, logs?: DeviceEventLogs): void { this.adapterValue = new BridgeAdapter(site, hub, logs); }
  get adapter(): BridgeAdapter { if (!this.adapterValue) throw new BridgeError("Bridges are not ready", "unavailable"); return this.adapterValue; }
  override status(): ServiceStatus {
    const configured = this.store.list().filter(b => b.enabled);
    const active = configured.filter(b => this.state(b.id).running).length;
    return { availability: configured.length === active ? "online" : "degraded", detail: configured.length ? `${active}/${configured.length} bridges running` : "No bridges configured" };
  }
  override events(limit?: number, filter?: EventFilter) { return this.log.recent(limit, filter); }
  override subscribe(listener: ServiceEventListener, filter?: EventFilter) { return this.log.subscribe(listener, filter); }
  state(id: string): BridgeStatus {
    const bridge = this.store.get(id), worker = this.workers.get(id);
    if (!bridge.enabled) return idle("Disabled");
    if (!worker || !worker.child.connected) {
      const error = this.errors.get(id);
      return error ? { ...idle(error), fault: error } : idle("Starting bridge");
    }
    const unreachable = worker.exports.filter(accessory => {
      try { return !this.adapter.snapshot(accessory).reachable; } catch { return true; }
    }).map(accessory => accessory.id);
    return { ...worker.status, unreachable };
  }
  /** Follow one bridge's status; the listener hears only real changes, never the 2-second heartbeat. */
  watch(id: string, listener: (status: BridgeStatus) => void): () => void {
    const listeners = this.watchers.get(id) ?? new Set();
    listeners.add(listener); this.watchers.set(id, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) { this.watchers.delete(id); this.published.delete(id); } };
  }
  private notify(id: string): void {
    const listeners = this.watchers.get(id);
    if (!listeners?.size) return;
    let status: BridgeStatus;
    try { status = this.state(id); } catch { return; }
    const { updatedAt: _, ...comparable } = status;
    const signature = JSON.stringify(comparable);
    if (this.published.get(id) === signature) return;
    this.published.set(id, signature);
    for (const listener of listeners) listener(status);
  }
  private notifyAll(): void { for (const id of this.watchers.keys()) this.notify(id); }
  validate(bridge: BridgeDefinition): void { this.adapter.exports(bridge); }
  pair(id: string): void {
    const worker = this.workers.get(id);
    if (!worker?.child.connected || !worker.status.running) throw new BridgeError("The bridge is not running", "unavailable");
    if (worker.status.paired) throw new BridgeError("Share a paired bridge from Apple Home");
    worker.child.send({ type: "pair" });
  }
  start(): void {
    if (this.running) return; this.running = true;
    this.releases.push(this.store.onChange(() => this.schedule()));
    this.timer = setInterval(() => this.schedule(), 10000); this.timer.unref();
    for (const device of this.adapter.site.devices) {
      const button = device.capabilities.button as Button | undefined;
      if (button) this.releases.push(button.subscribe(options => {
        const source = elementKey("capability", device.id, "button");
        for (const [id, worker] of this.workers) {
          const current = this.store.list().find(b => b.id === id);
          if (!current?.enabled || !worker.child.connected) continue;
          for (const accessory of worker.exports) if (current.members.some(m => m.element === accessory.element)) {
            for (const [key, binding] of Object.entries(accessory.characteristics)) if (binding.event?.element === source) worker.child.send({ type: "event", accessory: accessory.id, key, value: options.durationMs ? 2 : 0 });
          }
        }
      }));
    }
    this.schedule();
  }
  private schedule(): void {
    this.pending = this.pending.then(() => this.reconcile()).catch(() => { this.log.record("apple_bridge", "Unable to reconcile Apple Home bridges", { level: "warn" }); })
      .finally(() => this.notifyAll());
  }
  private async reconcile(): Promise<void> {
    if (!this.running) return;
    const configured = this.store.list();
    for (const [id, worker] of this.workers) if (!configured.some(b => b.id === id && b.enabled)) { await this.stopWorker(worker); this.workers.delete(id); }
    for (const bridge of configured.filter(b => b.enabled)) {
      let exports: ExportAccessory[];
      try { exports = this.adapter.exports(bridge); } catch (error) {
        this.errors.set(bridge.id, error instanceof BridgeError ? error.message : "Unable to resolve bridge members");
        const worker = this.workers.get(bridge.id); if (worker) { await this.stopWorker(worker); this.workers.delete(bridge.id); }
        continue;
      }
      const revision = JSON.stringify([bridge.revision, exports]);
      const previous = this.workers.get(bridge.id);
      if (previous?.child.connected && previous.revision === revision && Date.now() - previous.lastSeen < 60000) continue;
      if (previous) await this.stopWorker(previous);
      if (!this.running) return;
      this.errors.delete(bridge.id);
      const child = spawn(process.env.HOMETRUTH_NODE_BINARY || "node", [fileURLToPath(new URL("./runtime/worker.mjs", import.meta.url))], {
        stdio: ["ignore", "ignore", "inherit", "ipc"], serialization: "json",
        env: { PATH: process.env.PATH, HOME: process.env.HOME,
          HOMETRUTH_HOMEKIT_IPV4_ONLY: process.env.HOMETRUTH_HOMEKIT_IPV4_ONLY,
          ...(process.env.HOMETRUTH_FFMPEG_BINARY ? { HOMETRUTH_FFMPEG_BINARY: process.env.HOMETRUTH_FFMPEG_BINARY } : {}) },
      });
      const worker: Worker = { child, revision, status: idle("Starting bridge"), lastSeen: Date.now(), exports, failures: 0 };
      this.workers.set(bridge.id, worker);
      child.on("message", message => { void this.message(bridge, worker, message); });
      child.once("error", () => { this.errors.set(bridge.id, "Bridge process could not start. Check the Node.js installation."); });
      child.once("exit", () => {
        if (this.running && this.workers.get(bridge.id) === worker) this.errors.set(bridge.id, this.errors.get(bridge.id) ?? "Bridge stopped; restarting");
        worker.status = idle(this.errors.get(bridge.id) ?? "Bridge stopped");
        this.notify(bridge.id);
      });
      child.send({ type: "init", bridge, storage: join(this.storage, bridge.id), accessories: exports, profiles: ACCESSORY_PROFILES });
      this.log.record("apple_bridge", `${bridge.name}: starting ${bridge.protocol} bridge`);
    }
  }
  private async message(bridge: BridgeDefinition, worker: Worker, message: unknown): Promise<void> {
    if (this.workers.get(bridge.id) !== worker || !message || typeof message !== "object") return;
    const m = message as Record<string, unknown>;
    if (m.type === "status") { worker.status = m.status as BridgeStatus; worker.lastSeen = Date.now(); this.notify(bridge.id); return; }
    if (m.type === "fault") { this.errors.set(bridge.id, String(m.detail)); worker.status = { ...worker.status, running: false, detail: String(m.detail), fault: String(m.detail) }; this.notify(bridge.id); return; }
    if (m.type !== "request" || typeof m.id !== "number") return;
    try {
      // Re-check current membership before any write; an old worker cannot act after removal.
      const current = this.store.get(bridge.id);
      if (!current.enabled || current.revision !== bridge.revision) throw new BridgeError("Bridge configuration changed", "unavailable");
      const accessory = worker.exports.find(a => a.id === m.accessory);
      let value: unknown;
      if (m.operation === "snapshots") value = worker.exports.map(a => this.adapter.snapshot(a));
      else {
        if (!accessory) throw new BridgeError("Accessory not assigned to this bridge");
        if (m.operation === "read") value = this.adapter.snapshot(accessory);
        else if (m.operation === "write") value = await this.adapter.write(accessory, String(m.key), m.value);
        else if (m.operation === "media" || m.operation === "snapshot") {
          if (!accessory.cameraDevice || !this.adapter.snapshot(accessory).reachable) throw new BridgeError("Camera unavailable");
          const camera = this.adapter.site.get(accessory.cameraDevice)?.capabilities.camera as Camera | undefined;
          const source = camera?.mediaSource?.();
          if (!source) throw new BridgeError("Camera media unavailable");
          if (m.operation === "media") {
            if (!source.streamUri) throw new BridgeError("This camera has snapshots only");
            value = cameraUriWithCredentials(source.streamUri, source.username, source.password);
          } else value = Buffer.from(await captureCameraSnapshot(source)).toString("base64");
        } else throw new BridgeError("Unknown bridge operation");
      }
      if (worker.child.connected) worker.child.send({ type: "reply", id: m.id, value });
    } catch { if (worker.child.connected) worker.child.send({ type: "reply", id: m.id, error: "HomeTruth could not complete this operation" }); }
  }
  private stopWorker(worker: Worker): Promise<void> {
    return new Promise(resolve => {
      if (!worker.child.pid || worker.child.exitCode !== null || worker.child.signalCode !== null) { resolve(); return; }
      const timer = setTimeout(() => { worker.child.kill("SIGKILL"); }, 4500); timer.unref();
      worker.child.once("exit", () => { clearTimeout(timer); resolve(); }); worker.child.kill("SIGTERM");
    });
  }
  override async stop(): Promise<void> {
    this.running = false; clearInterval(this.timer); for (const release of this.releases) release(); this.releases = [];
    await this.pending; await Promise.all([...this.workers.values()].map(worker => this.stopWorker(worker))); this.workers.clear();
  }
}
