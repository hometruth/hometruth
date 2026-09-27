import type { Device } from "../models/device";
import { Service } from "../models/service";
import { EventLog, type EventFilter, type ServiceEvent, type ServiceEventListener } from "../models/event-log";
import { eventType } from "../models/event-types";
import { validators } from "../validation";
import { DAY, ERROR_RECHECK_MS, ERROR_REPEAT_MS, HOUR, isProblem, type HealthCheck, type HealthKind, type HealthReporter } from "./model";
import { HealthStore, type HealthEntity, type HealthReport } from "./store";

declare module "../models/device" { interface SiteServices { health?: HealthService } }
interface Target { entity: HealthEntity; source: Device | Service; health: HealthCheck; observed: number; written: number; emitted: number; nextPoll: number; detach: (() => void)[] }
interface Options {
  store: HealthStore;
  devices: () => readonly Device[];
  services: () => readonly Service[];
  now?: () => number;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

/** One low-frequency checker, plus immediate self-reports and bounded reminders of ongoing errors. */
export class HealthService extends Service {
  private readonly log: EventLog;
  private readonly targets = new Map<string, Target>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly deadlines = new Map<string, () => void>();
  private readonly now: () => number;
  readonly pollIntervalMs: number;
  private running = false;
  private historyFailed = false;
  private timer?: ReturnType<typeof setInterval>;
  private polling: Promise<void> | undefined;

  constructor(private readonly options: Options) {
    super("health", "Health");
    this.now = options.now ?? Date.now;
    this.pollIntervalMs = options.pollIntervalMs ?? HOUR;
    this.log = new EventLog(1000, () => new Date(this.now()));
  }

  status() { return { availability: !this.running ? "offline" as const : this.historyFailed ? "degraded" as const : "online" as const, detail: this.historyFailed ? "Health history is unavailable" : this.running ? `Watching ${this.targets.size} devices and services; checking hourly` : "Health monitor stopped" }; }
  events(limit?: number, filter?: EventFilter) { return this.log.recent(limit, filter); }
  override subjects(): readonly string[] { return this.log.subjects(); }
  subscribe(listener: ServiceEventListener, filter?: EventFilter) { return this.log.subscribe(listener, filter); }

  start(schedule = true): void {
    if (this.running) return;
    this.running = true;
    this.options.store.begin(this.now());
    this.reconcile();
    if (schedule) {
      this.timer = setInterval(() => { this.safely(() => this.tick()); void this.poll(); }, 30_000).unref();
      void this.poll();
    }
  }

  /** Attach replacement instances after a configuration reload; retire every old subscription. */
  reconcile(): void {
    if (!this.running) return;
    const all: { entity: HealthEntity; source: Device | Service }[] = [
      ...this.options.devices().map(source => ({ source, entity: { key: `device:${source.id}`, kind: "device" as const, id: source.id, name: source.name } })),
      ...this.options.services().map(source => ({ source, entity: { key: `service:${source.id}`, kind: "service" as const, id: source.id, name: source.title } })),
    ];
    const keys = new Set(all.map(item => item.entity.key));
    for (const [key, target] of this.targets) if (!keys.has(key) || all.find(item => item.entity.key === key)?.source !== target.source) {
      target.detach.forEach(detach => detach()); this.targets.delete(key);
      this.deadlines.get(key)?.();
      this.deadlines.delete(key);
      this.pending.delete(key);
    }
    for (const { entity, source } of all) {
      if (this.targets.has(entity.key)) continue;
      const target: Target = { entity, source, health: { status: "unknown", detail: "Waiting for a health check", checkedAt: null }, observed: this.now(), written: -Infinity, emitted: -Infinity, nextPoll: 0, detach: [] };
      this.targets.set(entity.key, target);
      this.apply(target, target.health, "report");
      if (source !== this) target.detach.push(source.subscribeHealth(health => {
        if (!this.pending.has(entity.key)) this.safely(() => this.apply(target, health, "report"));
      }));
      // MQTT mirrors other sources. Inspect its own listener through checkHealth(),
      // rather than misattributing every mirrored error to the broker.
      if (source instanceof Service && source !== this && source.id !== "mqtt-broker") target.detach.push(source.subscribe(event => this.safely(() => this.acceptError(target, event))));
    }
    this.options.store.retain([...keys], this.now());
  }

  private acceptError(target: Target, event: ServiceEvent): void {
    if (this.disabled(target) || event.type === "health_checked" || event.type === "filter_matched" || event.level !== "error") return;
    const detail = `${eventType(event.type)?.label ?? "Operation"} failed; see the event log`;
    const result: HealthCheck = { status: "degraded", detail, checkedAt: new Date(this.now()).toISOString() };
    this.apply(target, result, "event");
    target.source.reportHealth({ status: result.status, detail });
    const subject = event.subject ? this.targets.get(`device:${event.subject}`) : undefined;
    if (subject && !this.disabled(subject)) {
      this.apply(subject, result, "event");
      subject.source.reportHealth({ status: result.status, detail });
    }
  }

  private safely(action: () => void): void {
    try { action(); }
    catch { this.historyFailure(); }
  }
  private historyFailure(): void {
    if (!this.historyFailed) console.warn(JSON.stringify({ event: "health_history_unavailable" }));
    this.historyFailed = true;
  }

  private disabled(target: Target): boolean {
    return target.entity.kind === "device" ? !(target.source as Device).enabled : target.source instanceof Service && target.source.switch?.enabled === false;
  }

  private apply(target: Target, result: HealthCheck, source: "poll" | "report" | "event"): void {
    if (!this.running || this.targets.get(target.entity.key) !== target) return;
    const now = this.now();
    if (!validators.healthCheck(result)) result = { status: "unhealthy", detail: "Invalid health report", checkedAt: new Date(now).toISOString() };
    const health = this.disabled(target) ? { status: "disabled" as const, detail: "Disabled in HomeTruth", checkedAt: new Date(now).toISOString() } : result;
    const changed = target.health.status !== health.status || target.health.detail !== health.detail;
    target.health = health;
    target.observed = now;
    // Confirm recovery promptly without treating a cached online reading as proof.
    // Repeated error reports must not keep postponing the next active check.
    if (isProblem(health.status)) target.nextPoll = Math.min(target.nextPoll, now + ERROR_RECHECK_MS);
    if (changed || now - target.written >= 60_000 || source === "poll") {
      this.options.store.observe(target.entity, health, now); target.written = now;
    }
    if (changed || source === "poll" && now - target.emitted >= ERROR_REPEAT_MS) this.emit(target, source);
  }

  private emit(target: Target, source: "poll" | "report" | "event" | "repeat"): void {
    target.emitted = this.now();
    if (isProblem(target.health.status)) this.options.store.problem(target.entity, target.health.detail, this.now());
    this.log.record("health_checked", `${target.entity.name}: ${target.health.detail}`, {
      level: isProblem(target.health.status) ? "error" : "info",
      ...(target.entity.kind === "device" ? { subject: target.entity.id } : {}),
      data: { kind: target.entity.kind, id: target.entity.id, ...target.health, source },
    });
  }

  tick(): void {
    if (!this.running) return;
    this.reconcile();
    const now = this.now();
    this.options.store.heartbeat(now);
    this.historyFailed = false;
    for (const target of this.targets.values()) {
      if (this.disabled(target) && target.health.status !== "disabled") this.apply(target, { status: "disabled", detail: "Disabled in HomeTruth", checkedAt: new Date(now).toISOString() }, "report");
      else if (!this.disabled(target) && target.health.status === "disabled") {
        target.nextPoll = 0;
        this.apply(target, { status: "unknown", detail: "Waiting for a health check", checkedAt: null }, "report");
      } else if (target.health.status !== "disabled" && now - target.observed > 2 * this.pollIntervalMs) {
        this.apply(target, { status: "unknown", detail: "Health observation is stale", checkedAt: null }, "report");
      }
      if (isProblem(target.health.status) && now - target.emitted >= ERROR_REPEAT_MS) this.emit(target, "repeat");
    }
  }

  poll(): Promise<void> {
    if (!this.running) return Promise.resolve();
    return this.polling ??= (async () => {
      const queue = [...this.targets.values()].filter(target => target.nextPoll <= this.now());
      await Promise.all(Array.from({ length: 4 }, async () => {
        for (let target; this.running && (target = queue.shift());) await this.check(target.entity.kind, target.entity.id);
      }));
    })().catch(() => { this.historyFailure(); }).finally(() => { this.polling = undefined; });
  }

  async check(kind: HealthKind, id: string): Promise<HealthCheck | undefined> {
    const target = this.targets.get(`${kind}:${id}`);
    if (!this.running || !target) return undefined;
    if (this.disabled(target)) {
      this.apply(target, { status: "disabled", detail: "Disabled in HomeTruth", checkedAt: new Date(this.now()).toISOString() }, "poll");
      target.nextPoll = this.now() + this.pollIntervalMs;
      return target.health;
    }
    if (this.pending.has(target.entity.key)) return target.health;
    target.nextPoll = this.now() + this.pollIntervalMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = Promise.resolve().then(() => (target.source as HealthReporter).checkHealth());
    const settled = work.then(() => undefined, () => undefined).finally(() => {
      if (this.pending.get(target.entity.key) === settled) this.pending.delete(target.entity.key);
    });
    this.pending.set(target.entity.key, settled);
    const failed = (detail: string): HealthCheck => ({ status: "unhealthy", detail, checkedAt: new Date(this.now()).toISOString() });
    try {
      const result = await Promise.race([
        work.catch(() => failed("Health check failed")),
        new Promise<HealthCheck>(resolve => {
          const cancel = () => resolve(failed("Health check interrupted"));
          this.deadlines.set(target.entity.key, cancel);
          timer = setTimeout(() => resolve(failed("Health check timed out")), this.options.timeoutMs ?? 15_000);
        }),
      ]);
      const valid = validators.healthCheck(result);
      this.apply(target, valid ? result : failed("Device or service returned an invalid health answer"), "poll");
      return target.health;
    } finally {
      clearTimeout(timer);
      if (this.targets.get(target.entity.key) === target) this.deadlines.delete(target.entity.key);
    }
  }

  report(periodMs = DAY): HealthReport {
    if (this.running) this.options.store.heartbeat(this.now());
    return this.options.store.report(this.now() - periodMs, this.now(), this.pollIntervalMs);
  }

  override async stop(): Promise<void> {
    if (!this.running) { this.options.store.close(); return; }
    this.running = false; clearInterval(this.timer);
    for (const cancel of this.deadlines.values()) cancel();
    for (const target of this.targets.values()) target.detach.forEach(detach => detach());
    this.options.store.end(this.now());
    this.options.store.close();
  }
}
