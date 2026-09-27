/**
 * The observer reads the nodes somebody is watching and publishes what it
 * finds into the graph. Only retained nodes are read; a page asks `live`
 * (5 s) and a list `glance` (20 s), each model has a floor per capability
 * kind, and the next read is scheduled from the completion of the last one
 * with a little jitter so a home full of switches does not poll in lockstep.
 * A device that stops answering is polled less and less; one read at a time
 * per node, a handful per process. Every read captures the device instance
 * first and drops its result if the site swapped it out meanwhile, so a
 * config reload never publishes a stale instance's answer.
 */
import type { CapabilityKind } from "../models/capability";
import type { Device } from "../models/device";
import type { HomeTruthObject } from "../schemas";
import type { Site } from "../site";
import { Graph, unconfiguredFault, type Result } from "./graph";
import { automationNode, deviceNode, groupNode, parseNode, type AutomationSwitch, type Fault, type GroupSwitch, type NodeId, type NodeRecord, type Tier } from "./protocol";

export interface ObserverBinding {
  /** The live site proxy: every read looks the device up again. */
  readonly site: Site;
  /** The app's bounded reader (the 3 s race plus availability bookkeeping), without its publish hook: the observer publishes what it reads itself. */
  readonly describe: (device: Device) => Promise<HomeTruthObject>;
  /** The group switch document, or undefined when no such group switch is configured. */
  readonly describeGroup: (groupId: string) => Promise<GroupSwitch | undefined>;
  /** The automation switch document, or undefined when no such automation is configured. */
  readonly describeAutomation: (automationId: string) => Promise<AutomationSwitch | undefined>;
}

export interface ObserverTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const REAL_TIMERS: ObserverTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface ObserverOptions {
  readonly now?: () => Date;
  readonly timers?: ObserverTimers;
  /** Uniform in [0, 1); injected so tests can pin the jitter. */
  readonly random?: () => number;
  /** Reads in flight per process. */
  readonly concurrency?: number;
}

/** The fastest a node of each kind is ever read; a model's floor is the max over its kinds. */
export const FLOORS_MS: Readonly<Record<CapabilityKind, number>> = {
  binarySwitch: 5_000,
  light: 5_000,
  stringLight: 5_000,
  button: 5_000,
  sensor: 15_000,
  occupancySensor: 15_000,
  contactSensor: 15_000,
  motionSensor: 15_000,
  hub: 15_000,
  camera: 30_000,
  treatDispenser: 30_000,
  speaker: 30_000,
  television: 15_000,
  infraredBlaster: 30_000,
  radioFrequencyBlaster: 30_000,
  radioFrequencyReceiver: 30_000,
  cooktop: 30_000,
};

export const TIER_MS = { live: 5_000, glance: 20_000 } as const;
/** A read keeps its concurrency slot this long at most, so a hung device cannot starve the others. */
export const READ_SLOT_MS = 30_000;
export const BACKOFF_CAP_MS = 120_000;
export const CAMERA_BACKOFF_CAP_MS = 300_000;
export const DEFAULT_CONCURRENCY = 6;
const JITTER = 0.1;
const FIRST_READ_STAGGER_MS = 250;
/** Reasons longer than this are cut so a fault message stays one readable sentence. */
const REASON_LIMIT = 300;
interface Watch {
  readonly node: NodeId;
  readonly tiers: Map<Tier, number>;
  timer: unknown;
  /** When the pending timer fires, ms since the epoch. */
  due: number | undefined;
  /** When the last read settled, ms since the epoch; the cadence counts from here. */
  completedAt: number | undefined;
  failures: number;
}

interface Job {
  readonly node: NodeId;
  readonly promise: Promise<NodeRecord>;
  resolve(record: NodeRecord): void;
  reject(error: unknown): void;
  /** A read asked for while this one was in flight: it starts when this one settles, so it sees what changed meanwhile. */
  next?: Job;
}

function hasSubscribe(value: unknown): value is { subscribe(listener: () => void): () => void } {
  return typeof (value as { subscribe?: unknown } | undefined)?.subscribe === "function";
}

function reasonOf(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return reason.length > REASON_LIMIT ? `${reason.slice(0, REASON_LIMIT)}…` : reason;
}

/** The fault for a disabled device: read skipped rather than attempted, so a poller cannot keep contacting it. */
export function disabledFault(device: Device): Fault {
  return { code: "disabled", message: `${device.name} is disabled. Enable it from its Settings tab to see live state.` };
}

/** The fault for a device read that threw, phrased the way the device detail route reports a 502. */
export function readFault(device: Device, error: unknown): Fault {
  const reason = reasonOf(error);
  if (reason.startsWith("Invalid ")) {
    return { code: "invalid", message: `${device.name} answered with a document that fails its schema (${reason}).` };
  }
  const host = (device.config as { host?: unknown } | undefined)?.host;
  return {
    code: reason === "timed out" ? "timeout" : "unreachable",
    message: `${device.name} did not answer${typeof host === "string" ? ` at ${host}` : ""} (${reason}). If it has moved, use Find on network on its Settings tab.`,
  };
}

export class Observer {
  readonly #now: () => Date;
  readonly #timers: ObserverTimers;
  readonly #random: () => number;
  readonly #concurrency: number;
  #binding: ObserverBinding | undefined;
  /** Bumped by bind and stop: a read started under an older epoch publishes nothing. */
  #epoch = 0;
  readonly #watches = new Map<NodeId, Watch>();
  readonly #inFlight = new Map<NodeId, Job>();
  /**
   * Bumped whenever something other than this observer's own read changes a
   * node (a route's publish, an invalidation). A read captures it before it
   * starts and drops its answer if it moved: newer truth already landed, and
   * an older poll must never overwrite it.
   */
  readonly #generation = new Map<NodeId, number>();
  readonly #queue: Job[] = [];
  #running = 0;
  readonly #slots = new Set<unknown>();
  #detachButtons: (() => void)[] = [];

  constructor(readonly graph: Graph, options: ObserverOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#timers = options.timers ?? REAL_TIMERS;
    this.#random = options.random ?? Math.random;
    this.#concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  }

  /** Point at a site: the graph is emptied, in-flight results dropped, and every retained node read again. */
  bind(binding: ObserverBinding): void {
    this.#reset();
    this.graph.clear();
    this.#binding = binding;
    this.attach();
    for (const watch of this.#watches.values()) {
      watch.failures = 0;
      watch.completedAt = undefined;
      this.#arm(watch, this.#random() * FIRST_READ_STAGGER_MS);
    }
  }

  /** Watch a node at a tier; the first retainer triggers a read within 250 ms. Returns the release. */
  retain(node: NodeId, tier: Tier): () => void {
    let watch = this.#watches.get(node);
    const first = !watch;
    if (!watch) {
      watch = { node, tiers: new Map(), timer: undefined, due: undefined, completedAt: undefined, failures: 0 };
      this.#watches.set(node, watch);
    }
    const held = watch;
    held.tiers.set(tier, (held.tiers.get(tier) ?? 0) + 1);
    if (this.#binding) {
      if (first) this.#arm(held, this.#random() * FIRST_READ_STAGGER_MS);
      else this.#rearm(held);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (held.tiers.get(tier) ?? 0) - 1;
      if (count > 0) held.tiers.set(tier, count);
      else held.tiers.delete(tier);
      if (held.tiers.size === 0 && this.#watches.get(node) === held) {
        this.#timers.clear(held.timer);
        this.#watches.delete(node);
      }
    };
  }

  isRetained(node: NodeId): boolean {
    return this.#watches.has(node);
  }

  /** Every node with at least one watcher right now, for the hub's own status and log. */
  watching(): readonly NodeId[] {
    return [...this.#watches.keys()];
  }

  /**
   * Read now. While a read is in flight the caller gets a follow-up read that
   * starts when it settles, never the in-flight one: a read that began before
   * a command answers with the state before it.
   */
  refresh(node: NodeId): Promise<NodeRecord> {
    const inFlight = this.#inFlight.get(node);
    if (inFlight) {
      inFlight.next ??= this.#job(node);
      return inFlight.next.promise;
    }
    const job = this.#job(node);
    this.#inFlight.set(node, job);
    this.#queue.push(job);
    this.#pump();
    return job.promise;
  }

  /** A route already described the device: record it as a successful observation and count the cadence from now. */
  publish(deviceId: string, object: HomeTruthObject): void {
    this.#publishNode(deviceNode(deviceId), { value: object });
  }

  /** The group switch endpoint already described the group: same as `publish`, for a group node. */
  publishGroup(groupId: string, document: GroupSwitch): void {
    this.#publishNode(groupNode(groupId), { value: document });
  }

  /** The automation switch endpoint already described it: same as `publish`, for an automation node. */
  publishAutomation(automationId: string, document: AutomationSwitch): void {
    this.#publishNode(automationNode(automationId), { value: document });
  }

  #publishNode(node: NodeId, result: Result): void {
    this.#bump(node);
    this.graph.publish(node, result);
    const watch = this.#watches.get(node);
    if (!watch) return;
    watch.failures = 0;
    if (this.#inFlight.has(node) || !this.#binding) return;
    watch.completedAt = this.#nowMs();
    this.#arm(watch, this.#delay(watch));
  }

  /**
   * The device changed by someone's hand: forget its backoff and re-read every
   * retained node that changes with it, in either direction (a composite's
   * members, the composites that use it, the group switches it belongs to).
   * The device's own record is the caller's to re-describe.
   */
  invalidate(deviceId: string): void {
    this.#invalidate(deviceId, false);
  }

  /**
   * The device said so itself: a Matter attribute report, a retained MQTT
   * message. Unlike `invalidate`, the device's own record is re-read rather
   * than rescheduled, because the thing that changed *is* this device and
   * nobody else is going to describe it. Everything that changes with it is
   * re-read the same way, so a hub's report also refreshes what it bridges.
   */
  reportChange(deviceId: string): void {
    this.#invalidate(deviceId, true);
  }

  #invalidate(deviceId: string, readItself: boolean): void {
    const site = this.#binding?.site;
    if (!site) return;
    const ownNode = deviceNode(deviceId);
    this.#bump(ownNode);
    const own = this.#watches.get(ownNode);
    if (own) {
      own.failures = 0;
      // A read already under way answers with the state before the change; ask for one after it.
      if (readItself || this.#inFlight.has(ownNode)) void this.refresh(ownNode).catch(() => undefined);
      else this.#rearm(own);
    }
    let references: readonly { from: string; to: string }[] | undefined;
    let groups: readonly { id: string; members: string[] }[] | undefined;
    for (const watch of [...this.#watches.values()]) {
      const parsed = parseNode(watch.node);
      if (!parsed) continue;
      if (parsed.kind === "group") {
        groups ??= site.deviceGroups;
        if (groups.some((group) => group.id === parsed.id && group.members.includes(deviceId))) void this.refresh(watch.node);
        continue;
      }
      if (parsed.id === deviceId) continue;
      // The reference list, not `site.list()`: that computed a full registered
      // view — model, capabilities, page and the whole relationship set — for
      // every device in the site, on every invalidation, so one button press
      // paid for all of it.
      references ??= site.deviceReferences;
      const linked = references.some((reference) =>
        (reference.from === parsed.id && reference.to === deviceId)
        || (reference.to === parsed.id && reference.from === deviceId));
      if (linked) void this.refresh(watch.node);
    }
  }

  /**
   * Subscribe to everything that can tell us it changed instead of waiting to
   * be polled: a button press, and any device with a live push path of its own
   * (`Device.watch`, today a Matter subscription). Each one invalidates its
   * device, which also re-reads whatever `uses` it — so a hub that pushes
   * refreshes the sensors bridged through it. Run again after the site's
   * devices change.
   */
  attach(): void {
    this.#detach();
    const site = this.#binding?.site;
    if (!site) return;
    for (const device of site.devices) {
      const button = device.capabilities.button;
      if (hasSubscribe(button)) this.#detachButtons.push(button.subscribe(() => this.invalidate(device.id)));
      const watch = device.watch?.bind(device);
      if (watch) this.#detachButtons.push(watch(() => this.reportChange(device.id)));
    }
  }

  stop(): void {
    this.#reset();
    this.#binding = undefined;
    this.#watches.clear();
  }

  #reset(): void {
    this.#detach();
    this.#epoch++;
    for (const watch of this.#watches.values()) {
      this.#timers.clear(watch.timer);
      watch.timer = undefined;
      watch.due = undefined;
    }
    for (const slot of this.#slots) this.#timers.clear(slot);
    this.#slots.clear();
    // Queued and follow-up reads never start; their callers get whatever the graph holds now.
    for (const job of this.#queue) job.resolve(this.graph.read(job.node) ?? this.#empty(job.node));
    for (const job of this.#inFlight.values()) job.next?.resolve(this.graph.read(job.node) ?? this.#empty(job.node));
    this.#queue.length = 0;
    this.#inFlight.clear();
    this.#generation.clear();
    this.#running = 0;
  }

  #detach(): void {
    for (const off of this.#detachButtons) off();
    this.#detachButtons = [];
  }

  #nowMs(): number {
    return this.#now().getTime();
  }

  #job(node: NodeId): Job {
    let resolve!: (record: NodeRecord) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<NodeRecord>((res, rej) => { resolve = res; reject = rej; });
    return { node, promise, resolve, reject };
  }

  #bump(node: NodeId): void {
    this.#generation.set(node, (this.#generation.get(node) ?? 0) + 1);
  }

  #empty(node: NodeId): NodeRecord {
    return { node, version: 0, updatedAt: this.#now().toISOString() };
  }

  #kinds(node: NodeId): readonly CapabilityKind[] {
    const site = this.#binding?.site;
    const parsed = parseNode(node);
    if (!site || !parsed) return [];
    if (parsed.kind === "device") return site.get(parsed.id)?.model.capabilities ?? [];
    const members = site.deviceGroups.find((group) => group.id === parsed.id)?.members ?? [];
    return members.flatMap((id) => site.get(id)?.model.capabilities ?? []);
  }

  #interval(watch: Watch): number {
    const floor = this.#kinds(watch.node).reduce((max, kind) => Math.max(max, FLOORS_MS[kind]), 0);
    const tier = Math.min(...[...watch.tiers.keys()].map((name) => TIER_MS[name]));
    return Math.max(floor, tier);
  }

  /** The next delay: the interval, doubled per consecutive failure up to the cap, with ±10 % jitter. */
  #delay(watch: Watch): number {
    const interval = this.#interval(watch);
    const cap = this.#kinds(watch.node).includes("camera") ? CAMERA_BACKOFF_CAP_MS : BACKOFF_CAP_MS;
    const base = watch.failures > 0 ? Math.min(cap, interval * 2 ** watch.failures) : interval;
    return base * (1 + (this.#random() * 2 - 1) * JITTER);
  }

  #arm(watch: Watch, delay: number): void {
    this.#timers.clear(watch.timer);
    watch.due = this.#nowMs() + delay;
    watch.timer = this.#timers.set(() => {
      watch.timer = undefined;
      watch.due = undefined;
      void this.refresh(watch.node);
    }, delay);
  }

  /** A retainer changed the tiers: pull the pending read forward when the interval shortened, never push it back. */
  #rearm(watch: Watch): void {
    if (this.#inFlight.has(watch.node) || watch.completedAt === undefined) return;
    const due = watch.completedAt + this.#delay(watch);
    if (watch.due !== undefined && due >= watch.due) return;
    this.#arm(watch, Math.max(0, due - this.#nowMs()));
  }

  #pump(): void {
    while (this.#running < this.#concurrency && this.#queue.length) {
      const job = this.#queue.shift()!;
      const epoch = this.#epoch;
      this.#running++;
      let released = false;
      let slot: unknown;
      const release = (timedOut: boolean) => {
        if (released) return;
        released = true;
        this.#timers.clear(slot);
        this.#slots.delete(slot);
        if (epoch !== this.#epoch) return;
        this.#running--;
        if (timedOut) this.#settle(job, epoch);
        this.#pump();
      };
      slot = this.#timers.set(() => release(true), READ_SLOT_MS);
      this.#slots.add(slot);
      this.#perform(job.node, epoch).then(
        (record) => {
          this.#settle(job, epoch);
          release(false);
          job.resolve(record);
        },
        (error: unknown) => {
          this.#settle(job, epoch);
          release(false);
          job.reject(error);
        },
      );
    }
  }

  /** The read is over for scheduling purposes: start its follow-up if one was asked for, else count the cadence from now. */
  #settle(job: Job, epoch: number): void {
    if (this.#inFlight.get(job.node) !== job) return;
    this.#inFlight.delete(job.node);
    if (epoch !== this.#epoch || !this.#binding) return;
    if (job.next) {
      this.#inFlight.set(job.node, job.next);
      this.#queue.push(job.next);
      this.#pump();
      return;
    }
    const watch = this.#watches.get(job.node);
    if (!watch) return;
    watch.completedAt = this.#nowMs();
    if (watch.tiers.size) this.#arm(watch, this.#delay(watch));
  }

  async #perform(node: NodeId, epoch: number): Promise<NodeRecord> {
    const binding = this.#binding;
    const parsed = parseNode(node);
    if (!binding || !parsed) return this.graph.read(node) ?? this.#empty(node);
    const generation = this.#generation.get(node) ?? 0;
    const result = parsed.kind === "group" ? await this.#readGroup(binding, parsed.id)
      : parsed.kind === "automation" ? await this.#readAutomation(binding, parsed.id)
      : await this.#readDevice(binding, parsed.id);
    // Dropped: the site swapped the device, the hub rebound, or a route published newer truth while this read was out.
    if (result === undefined || epoch !== this.#epoch || (this.#generation.get(node) ?? 0) !== generation) return this.graph.read(node) ?? this.#empty(node);
    const watch = this.#watches.get(node);
    if (watch) watch.failures = "fault" in result && result.fault.code !== "unconfigured" ? watch.failures + 1 : 0;
    return this.graph.publish(node, result);
  }

  /** Undefined when the site swapped the device out during the read: that answer belongs to nobody. */
  async #readDevice(binding: ObserverBinding, id: string): Promise<Result | undefined> {
    const device = binding.site.get(id);
    if (!device) return { fault: unconfiguredFault(deviceNode(id)) };
    if (!device.enabled) return { fault: disabledFault(device) };
    let result: Result;
    try {
      result = { value: await binding.describe(device) };
    } catch (error) {
      result = { fault: readFault(device, error) };
    }
    return binding.site.get(id) === device ? result : undefined;
  }

  async #readGroup(binding: ObserverBinding, id: string): Promise<Result> {
    try {
      const group = await binding.describeGroup(id);
      return group ? { value: group } : { fault: unconfiguredFault(groupNode(id)) };
    } catch (error) {
      const name = binding.site.deviceGroups.find((group) => group.id === id)?.name ?? id;
      const reason = reasonOf(error);
      return { fault: { code: reason === "timed out" ? "timeout" : "unreachable", message: `${name} did not answer (${reason}).` } };
    }
  }

  async #readAutomation(binding: ObserverBinding, id: string): Promise<Result> {
    try {
      const automation = await binding.describeAutomation(id);
      return automation ? { value: automation } : { fault: unconfiguredFault(automationNode(id)) };
    } catch (error) {
      const reason = reasonOf(error);
      return { fault: { code: reason === "timed out" ? "timeout" : "unreachable", message: `${id} did not answer (${reason}).` } };
    }
  }
}
