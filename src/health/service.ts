import type { Device } from "../models/device";
import { Service } from "../models/service";
import { EventLog, type EventFilter, type ServiceEvent, type ServiceEventListener } from "../models/event-log";
import { eventType } from "../models/event-types";
import { validators } from "../validation";
import { DAY, ERROR_RECHECK_MS, ERROR_REPEAT_MS, HOUR, isProblem, isUnreachableError, type HealthCheck, type HealthKind, type HealthReporter } from "./model";
import { HealthStore, type HealthEntity, type HealthReport } from "./store";
import { diagnoseHealth } from "./diagnostics";
import { investigationSummary, type HealthInvestigation, type InvestigationSummary } from "./investigation";
import type { HealthAdvisor } from "./advisor";

declare module "../models/device" { interface SiteServices { health?: HealthService } }
interface Target { entity: HealthEntity; source: Device | Service; health: HealthCheck; observation: HealthCheck; actionFailure: HealthCheck | undefined; failureRevision: number; observed: number; written: number; emitted: number; nextPoll: number; detach: (() => void)[] }
interface Options {
  store: HealthStore;
  devices: () => readonly Device[];
  services: () => readonly Service[];
  now?: () => number;
  pollIntervalMs?: number;
  timeoutMs?: number;
  /** Claude review after the read-only checks; absent without an Anthropic API key. */
  advisor?: HealthAdvisor;
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
  private readonly investigationListeners = new Set<(items: InvestigationSummary[]) => void>();
  private readonly investigationQueue = new Set<string>();
  private investigating = 0;
  private investigationTimer: ReturnType<typeof setTimeout> | undefined;

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
    for (const item of this.options.store.pendingInvestigations()) this.queueInvestigation(item.id);
    if (schedule) {
      this.timer = setInterval(() => { this.safely(() => this.tick()); void this.poll(); }, 30_000).unref();
      void this.poll();
    }
  }

  investigations(): InvestigationSummary[] { return this.options.store.investigations().map(investigationSummary); }
  investigation(id: string): HealthInvestigation | undefined { return this.options.store.investigation(id); }
  investigationFor(kind: HealthKind, id: string): HealthInvestigation | undefined { return this.options.store.openInvestigation(`${kind}:${id}`); }
  subscribeInvestigations(listener: (items: InvestigationSummary[]) => void): () => void {
    this.investigationListeners.add(listener);
    return () => { this.investigationListeners.delete(listener); };
  }

  private publishInvestigation(value: HealthInvestigation): void {
    this.options.store.saveInvestigation(value);
    const items = this.investigations();
    for (const listener of this.investigationListeners) {
      try { listener(items); } catch { /* A disconnected viewer cannot stop an investigation. */ }
    }
  }

  private beginInvestigation(target: Target, trigger: HealthCheck): void {
    if (this.options.store.openInvestigation(target.entity.key)) return;
    const id = crypto.randomUUID(), now = new Date(this.now()).toISOString();
    this.publishInvestigation({
      id, title: `${target.entity.name} failure`, href: `/health/investigations/${id}`, entity: { ...target.entity },
      status: "starting", createdAt: now, updatedAt: now, trigger: { ...trigger },
      progress: "Waiting to start read-only checks", observations: [], summary: "", likelyCause: "", steps: [],
    });
    this.queueInvestigation(id);
  }

  /** Save and publish first. Never hold a failed control response open for a probe. */
  private queueInvestigation(id: string): void {
    this.investigationQueue.add(id);
    if (this.investigationTimer || !this.running) return;
    this.investigationTimer = setTimeout(() => {
      this.investigationTimer = undefined;
      while (this.running && this.investigating < 2 && this.investigationQueue.size) {
        const next = this.investigationQueue.values().next().value!;
        this.investigationQueue.delete(next); this.investigating++;
        void this.runInvestigation(next).catch(() => { this.historyFailure(); }).finally(() => {
          this.investigating--;
          const queued = this.investigationQueue.values().next().value;
          if (queued && this.running) this.queueInvestigation(queued);
        });
      }
    }, 0);
  }

  private async runInvestigation(id: string): Promise<void> {
    const value = this.options.store.investigation(id);
    if (!value || !this.running) return;
    const update = (change: Partial<HealthInvestigation>) => {
      Object.assign(value, change, { updatedAt: new Date(this.now()).toISOString() });
      if (this.running) this.publishInvestigation(value);
    };
    try {
      update({ status: "checking", progress: "Checking the affected element" });
      const target = this.targets.get(value.entity.key);
      if (!target) throw new Error("Element removed");
      const inspect = async (item: Target): Promise<void> => {
        const busy = this.pending.has(item.entity.key);
        const observation = busy ? undefined : await this.check(item.entity.kind, item.entity.id, false);
        if (!this.running) return;
        value.observations.push({ entity: { ...item.entity }, health: busy
          ? { status: "unknown", detail: "Another health check is still running; a fresh result is not yet available", checkedAt: null }
          : { ...(observation ?? item.observation) } });
      };
      await inspect(target);
      if (!this.running) return;
      const parentId = value.entity.kind === "device" ? (target.source as Device).parent?.id : undefined;
      const parent = parentId ? this.targets.get(`device:${parentId}`) : undefined;
      if (parent && parent !== target) {
        update({ progress: `Checking parent device: ${parent.entity.name}` });
        await inspect(parent);
        if (!this.running) return;
      }
      const rows = value.observations.map(({ entity, health }) => ({ ...entity, health, healthySince: null,
        uptimePercent: null, observedMs: 0, unknownMs: 0, disabledMs: 0, expectedOfflineMs: 0, unreachableIsUnhealthy: true }));
      const diagnosis = diagnoseHealth(rows, [], parent ? new Map([[target.entity.key, parent.entity.key]]) : new Map()).find(item => item.key === target.entity.key);
      const responding = value.observations[0]?.health.status === "healthy";
      update({ status: "complete", progress: "Read-only checks complete", summary: diagnosis?.summary ?? (responding ? "The element responds now; the failed action has not been retried." : "The element is not currently being checked."),
        likelyCause: diagnosis?.likelyCause ?? (responding ? "The failure may have been temporary or limited to the requested action. A successful health check does not prove that action will succeed." : "The element is disabled or does not provide an active health result. This does not confirm recovery."),
        steps: diagnosis?.steps ?? ["Open the element and its event log to inspect the failed action and current settings.", "Retry the intended action when appropriate and verify its result."],
        ...(this.options.advisor ? { status: "checking", progress: "Claude is reviewing the evidence" } : {}) });
      if (this.options.advisor) {
        const advice = await this.options.advisor.advise({
          investigationId: value.id, entity: value.entity,
          evidence: { trigger: value.trigger, parent: parent?.entity, observations: value.observations, ruleBasedDiagnosis: diagnosis ?? null },
          events: key => this.eventsFor(key), overview: () => this.overview(),
        });
        if (!this.running) return;
        update({ status: "complete", progress: "Read-only checks complete", advice });
      }
    } catch {
      if (this.running) update({ status: "interrupted", progress: "Investigation could not finish", summary: "Some checks could not be completed.",
        likelyCause: "The element may have been removed or the health monitor could not collect its observations.",
        steps: ["Open the element and its event log, then use Check again to inspect its current health."] });
    }
  }

  advisorBudget() { return this.options.advisor?.budget(); }

  /** Oldest first, across every service that reports about the element. */
  private eventsFor(key: string): ServiceEvent[] | undefined {
    const target = this.targets.get(key);
    if (!target) return undefined;
    const events = target.entity.kind === "service" ? [...(target.source as Service).events(200)]
      : this.options.services().flatMap(service => service.events(200, { subject: target.entity.id }));
    return events.sort((a, b) => a.at.localeCompare(b.at));
  }

  private overview() {
    const report = this.report();
    return {
      elements: report.entities.filter(row => row.health.status !== "healthy" && row.health.status !== "disabled")
        .map(({ key, name, health }) => ({ key, name, health })),
      openIncidents: report.problems.filter(problem => problem.resolvedAt === null)
        .map(({ key, detail, startedAt, occurrences }) => ({ key, detail, startedAt, occurrences })),
    };
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
      const initial: HealthCheck = { status: "unknown", detail: "Waiting for a health check", checkedAt: null };
      const target: Target = { entity, source, health: initial, observation: initial, actionFailure: this.options.store.actionFailure(entity.key), failureRevision: 0, observed: this.now(), written: -Infinity, emitted: -Infinity, nextPoll: 0, detach: [] };
      this.targets.set(entity.key, target);
      this.apply(target, target.health, "report");
      if (target.actionFailure) this.beginInvestigation(target, target.actionFailure);
      if (source !== this) target.detach.push(source.subscribeHealth(health => {
        if (health.reason === "operation_failed" || !this.pending.has(entity.key)) this.safely(() => this.apply(target, health, "report"));
      }));
      // MQTT mirrors other sources. Inspect its own listener through checkHealth(),
      // rather than misattributing every mirrored error to the broker.
      if (source instanceof Service && source !== this && source.id !== "mqtt-broker") target.detach.push(source.subscribe(event => this.safely(() => this.acceptError(target, event))));
    }
    this.options.store.retain([...keys], this.now());
  }

  reportAction(kind: HealthKind, id: string, succeeded: boolean): void {
    const target = this.targets.get(`${kind}:${id}`);
    if (!this.running || !target) return;
    this.safely(() => {
      if (!succeeded) this.apply(target, { status: "unhealthy", reason: "operation_failed", detail: "A requested action failed; see the event log", checkedAt: new Date(this.now()).toISOString() }, "event");
      else if (target.actionFailure) { this.clearActionFailure(target); this.apply(target, target.observation, "report"); }
    });
  }

  setUnreachableIsUnhealthy(kind: HealthKind, id: string, value: boolean): boolean {
    const target = this.targets.get(`${kind}:${id}`);
    if (!this.running || !target) return false;
    this.options.store.setUnreachableIsUnhealthy(target.entity.key, value);
    this.apply(target, target.observation, "report");
    // Notify the dashboard even when only the setting changed.
    this.emit(target, "report");
    return true;
  }

  private clearActionFailure(target: Target): void {
    target.actionFailure = undefined;
    this.options.store.clearActionFailure(target.entity.key);
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

  private apply(target: Target, result: HealthCheck, source: "poll" | "report" | "event", recoverAction = false): void {
    if (!this.running || this.targets.get(target.entity.key) !== target) return;
    const now = this.now();
    if (!validators.healthCheck(result)) result = { status: "unhealthy", detail: "Invalid health report", checkedAt: new Date(now).toISOString() };
    if (result.reason === "operation_failed") {
      target.failureRevision++;
      target.actionFailure = { ...result, status: "unhealthy", checkedAt: result.checkedAt ?? new Date(now).toISOString() };
      this.options.store.recordActionFailure(target.entity.key, target.actionFailure);
      this.beginInvestigation(target, target.actionFailure);
    } else {
      target.observation = result;
      if (recoverAction && result.status === "healthy") this.clearActionFailure(target);
    }
    const health: HealthCheck = target.actionFailure ?? (this.disabled(target)
      ? { status: "disabled", detail: "Disabled in HomeTruth", checkedAt: new Date(now).toISOString() }
      : result.reason === "unreachable" && result.status === "unhealthy" && !this.options.store.unreachableIsUnhealthy(target.entity.key)
        ? { status: "expected_offline", reason: "unreachable", detail: "Unreachable; offline periods are allowed", checkedAt: result.checkedAt! }
        : result);
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

  async check(kind: HealthKind, id: string, recoverAction = true): Promise<HealthCheck | undefined> {
    const target = this.targets.get(`${kind}:${id}`);
    if (!this.running || !target) return undefined;
    if (this.disabled(target)) {
      const observation: HealthCheck = { status: "disabled", detail: "Disabled in HomeTruth", checkedAt: new Date(this.now()).toISOString() };
      this.apply(target, observation, "poll");
      target.nextPoll = this.now() + this.pollIntervalMs;
      return recoverAction ? target.health : observation;
    }
    if (this.pending.has(target.entity.key)) return target.health;
    target.nextPoll = this.now() + this.pollIntervalMs;
    const failureRevision = target.failureRevision;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = Promise.resolve().then(() => (target.source as HealthReporter).checkHealth());
    const settled = work.then(() => undefined, () => undefined).finally(() => {
      if (this.pending.get(target.entity.key) === settled) this.pending.delete(target.entity.key);
    });
    this.pending.set(target.entity.key, settled);
    const failed = (detail: string): HealthCheck => ({ status: "unhealthy", detail, checkedAt: new Date(this.now()).toISOString() });
    try {
      const result = await Promise.race([
        work.catch(error => ({ ...failed("Health check failed"), ...(isUnreachableError(error) ? { reason: "unreachable" as const } : {}) })),
        new Promise<HealthCheck>(resolve => {
          const cancel = () => resolve(failed("Health check interrupted"));
          this.deadlines.set(target.entity.key, cancel);
          timer = setTimeout(() => resolve({ ...failed("Health check timed out"), reason: "unreachable" }), this.options.timeoutMs ?? 15_000);
        }),
      ]);
      const valid = validators.healthCheck(result);
      const observation = valid ? result : failed("Device or service returned an invalid health answer");
      this.apply(target, observation, "poll", recoverAction && failureRevision === target.failureRevision);
      return recoverAction ? target.health : observation;
    } finally {
      clearTimeout(timer);
      if (this.targets.get(target.entity.key) === target) this.deadlines.delete(target.entity.key);
    }
  }

  report(periodMs = DAY): HealthReport {
    if (this.running) this.options.store.heartbeat(this.now());
    const parents = new Map(this.options.devices().flatMap(device => device.parent ? [[`device:${device.id}`, `device:${device.parent.id}`] as const] : []));
    return this.options.store.report(this.now() - periodMs, this.now(), this.pollIntervalMs, parents);
  }

  override async stop(): Promise<void> {
    if (!this.running) { this.options.store.close(); return; }
    this.running = false; clearInterval(this.timer);
    clearTimeout(this.investigationTimer); this.investigationQueue.clear(); this.investigationListeners.clear();
    for (const cancel of this.deadlines.values()) cancel();
    for (const target of this.targets.values()) target.detach.forEach(detach => detach());
    this.options.store.end(this.now());
    this.options.store.close();
  }
}
