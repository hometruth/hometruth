/**
 * This site's Whisker account: one signed-in client and one shared snapshot
 * of every Litter-Robot 4 on it, however many robots and child switches are
 * configured. Reads within `maxAgeMs` share the last answer and concurrent
 * reads share one request, so the state hub polling four entries does not
 * become four cloud calls. While something watches, the account is polled
 * every `pollIntervalMs` and watchers hear about changes.
 *
 * A failed fetch clears the snapshot: an account that cannot be read is
 * offline, never "the last thing it said".
 *
 * Absent when `vendors.whisker.username` or `vendors.whisker.password` is not
 * set. The password is kept rather than a token because Cognito refresh
 * tokens expire; nothing is ever written back to the secrets file.
 */
import { secretsFor } from "../../config/secrets";
import type { SecretsFile } from "../../schemas";
import { WhiskerClient, WhiskerError, type Lr4Robot, type WhiskerClientOptions } from "../../protocols/whisker/client";
import type { Lr4Command } from "../../protocols/whisker/constants";

declare module "../../models/device" {
  interface SiteServices {
    /** Absent when `vendors.whisker.username`/`password` are not configured for this site. */
    whisker?: WhiskerAccount;
  }
}

export const WHISKER_USERNAME_SECRET = "vendors.whisker.username";
export const WHISKER_PASSWORD_SECRET = "vendors.whisker.password";

/** What a Litter-Robot device needs from the account; the dormant source and tests implement it too. */
export interface WhiskerRobotSource {
  /** The robot with this serial from a snapshot no older than the account's max age. */
  robot(serial: string): Promise<Lr4Robot>;
  /** Send one command, then make the next read fetch fresh state. */
  command(serial: string, command: Lr4Command, value?: string): Promise<void>;
  /** Hear about snapshot changes; `active` lets a disabled device stop counting as a watcher. */
  subscribe(listener: () => void, active?: () => boolean): () => void;
}

export interface WhiskerTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const REAL_TIMERS: WhiskerTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface WhiskerAccountOptions extends WhiskerClientOptions {
  /** Reads younger than this reuse the last snapshot. */
  readonly maxAgeMs?: number;
  /** Background refresh while anything watches. */
  readonly pollIntervalMs?: number;
  readonly timers?: WhiskerTimers;
  /** A prepared client, so a test can drive the account without Cognito. */
  readonly client?: Pick<WhiskerClient, "robots" | "command">;
}

interface Snapshot {
  readonly at: number;
  readonly robots: ReadonlyMap<string, Lr4Robot>;
  readonly fingerprint: string;
}

interface Watcher {
  readonly listener: () => void;
  readonly active: () => boolean;
}

export class WhiskerAccount implements WhiskerRobotSource {
  private readonly client: Pick<WhiskerClient, "robots" | "command">;
  private readonly maxAgeMs: number;
  private readonly pollIntervalMs: number;
  private readonly timers: WhiskerTimers;
  private readonly now: () => number;
  private snapshotValue: Snapshot | undefined;
  private pending: Promise<Snapshot> | undefined;
  private readonly watchers = new Set<Watcher>();
  private timer: unknown;
  /** The last thing watchers were told: a fingerprint, or `failed`. */
  private announced: string | undefined;
  private stopped = false;

  constructor(credentials: { username: string; password: string }, options: WhiskerAccountOptions = {}) {
    this.client = options.client ?? new WhiskerClient(credentials, options);
    this.maxAgeMs = options.maxAgeMs ?? 30_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 60_000;
    this.timers = options.timers ?? REAL_TIMERS;
    this.now = options.now ?? Date.now;
  }

  async robots(): Promise<readonly Lr4Robot[]> {
    return [...(await this.snapshot()).robots.values()];
  }

  async robot(serial: string): Promise<Lr4Robot> {
    const robot = (await this.snapshot()).robots.get(serial.toUpperCase());
    if (!robot) throw new WhiskerError(`The Whisker account has no Litter-Robot 4 with serial ${serial}`, "not_found");
    return robot;
  }

  async command(serial: string, command: Lr4Command, value?: string): Promise<void> {
    try { await this.client.command(serial, command, value); }
    finally {
      // Whatever happened, the robot's state is no longer what we last read.
      this.snapshotValue = undefined;
    }
  }

  subscribe(listener: () => void, active: () => boolean = () => true): () => void {
    const watcher: Watcher = { listener, active };
    this.watchers.add(watcher);
    this.arm();
    return () => {
      this.watchers.delete(watcher);
      if (!this.watchers.size) this.disarm();
    };
  }

  stop(): void {
    this.stopped = true;
    this.watchers.clear();
    this.disarm();
  }

  private async snapshot(): Promise<Snapshot> {
    const current = this.snapshotValue;
    if (current && this.now() - current.at < this.maxAgeMs) return current;
    this.pending ??= this.fetch().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async fetch(): Promise<Snapshot> {
    try {
      const robots = await this.client.robots();
      const snapshot: Snapshot = {
        at: this.now(),
        robots: new Map(robots.map(robot => [robot.serial.toUpperCase(), robot])),
        fingerprint: JSON.stringify(robots),
      };
      this.snapshotValue = snapshot;
      this.announce(snapshot.fingerprint);
      return snapshot;
    } catch (error) {
      this.snapshotValue = undefined;
      this.announce("failed");
      throw error;
    }
  }

  private announce(fingerprint: string): void {
    const changed = this.announced !== undefined && this.announced !== fingerprint;
    this.announced = fingerprint;
    if (!changed) return;
    for (const watcher of [...this.watchers]) {
      try { watcher.listener(); }
      catch { console.warn(JSON.stringify({ event: "whisker_watch_delivery_failed" })); }
    }
  }

  private arm(): void {
    if (this.timer !== undefined || this.stopped || !this.watchers.size) return;
    this.timer = this.timers.set(() => {
      this.timer = undefined;
      const wanted = [...this.watchers].some(watcher => watcher.active());
      const poll = wanted ? this.snapshot().then(() => undefined, () => undefined) : Promise.resolve();
      void poll.then(() => this.arm());
    }, this.pollIntervalMs);
  }

  private disarm(): void {
    if (this.timer === undefined) return;
    this.timers.clear(this.timer);
    this.timer = undefined;
  }
}

export function createWhiskerSiteService(secretsFile: SecretsFile, options: WhiskerAccountOptions = {}): WhiskerAccount | undefined {
  const bag = secretsFor(secretsFile, "vendors", "whisker");
  const username = typeof bag.username === "string" ? bag.username.trim() : "";
  const password = typeof bag.password === "string" ? bag.password : "";
  if (!username || !password) return undefined;
  return new WhiskerAccount({ username, password }, options);
}
