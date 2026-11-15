/**
 * This site's Rachio account: one API client and one read cache shared by
 * every Rachio controller, zone, and rain-delay entry configured against it.
 *
 * Rachio meters the public API at roughly 1,700 calls per key per day, and
 * HomeTruth's state observer reads a watched switch every few seconds. So no
 * device here talks to Rachio on a read: they all read this cache, and the
 * cache decides when the cloud is actually asked.
 *
 *   - The account (`GET /person/{id}`: every controller, its zones, online
 *     status, standby, rain delay, rain sensor) is re-read at most every
 *     `accountIntervalMs` (default 10 min), and once right after a standby or
 *     rain-delay command.
 *   - What is watering (`GET /device/{id}/current_schedule`) is re-read at most
 *     every `scheduleIntervalMs` per controller (default 3 min), and every
 *     `settleIntervalMs` (15 s) for one minute after a zone command so the
 *     switch shows the valve Rachio actually opened.
 *   - A failed read is held for `failureRetryMs` (1 min) as the current
 *     answer, so a dozen watched zones do not retry in lockstep. A failure is
 *     never papered over with an earlier success.
 *   - When Rachio says fewer than `reserveCalls` remain in the day, polling
 *     stops until the allowance resets and reads report `rate_limited`;
 *     commands still go out on the reserve.
 *
 * Absent when `vendors.rachio.apiKey` is not set: Rachio is optional.
 */
import { secretsFor } from "../../config/secrets";
import type { SecretsFile } from "../../schemas";
import { RachioClient, RachioError, type RachioController, type RachioCurrentSchedule, type RachioFetch } from "../../protocols/rachio/client";

export const RACHIO_API_KEY_SECRET = "vendors.rachio.apiKey";

export const RACHIO_DEFAULTS = {
  accountIntervalMs: 600_000,
  scheduleIntervalMs: 180_000,
  settleIntervalMs: 15_000,
  settleWindowMs: 60_000,
  failureRetryMs: 60_000,
  reserveCalls: 150,
} as const;

/** One controller as the account last reported it. */
export interface RachioControllerReading {
  readonly controller: RachioController;
  /** ISO time of the account read this came from. */
  readonly observedAt: string;
}

/** What one controller is watering right now, as last read. */
export interface RachioWateringReading extends RachioControllerReading {
  readonly schedule: RachioCurrentSchedule | undefined;
  /** ISO time of the current-schedule read. */
  readonly scheduleObservedAt: string;
}

/** Everything a Rachio device needs from the account, for one controller. */
export interface RachioControllerSource {
  readonly deviceId: string;
  /** The controller from the shared account read. Rejects with a `RachioError`. */
  controller(): Promise<RachioControllerReading>;
  /**
   * The controller plus what it is watering. `fresh` asks Rachio now rather
   * than accepting the cached answer; used before a stop so a zone never
   * stops a different zone's watering on a stale belief.
   */
  watering(options?: { fresh?: boolean }): Promise<RachioWateringReading>;
  startZone(zoneId: string, seconds: number): Promise<void>;
  stopWatering(): Promise<void>;
  setStandby(standby: boolean): Promise<void>;
  setRainDelay(seconds: number): Promise<void>;
}

export interface RachioSiteService {
  readonly client: RachioClient;
  /** The one source for this Rachio device id, created on first use. */
  controller(deviceId: string, options?: { scheduleIntervalMs?: number }): RachioControllerSource;
  /** Calls this service has made since it started; what the daily allowance is charged. */
  readonly requests: number;
}

export interface RachioSiteServiceOptions {
  readonly fetch?: RachioFetch;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly accountIntervalMs?: number;
  readonly scheduleIntervalMs?: number;
  readonly settleIntervalMs?: number;
  readonly settleWindowMs?: number;
  readonly failureRetryMs?: number;
  readonly reserveCalls?: number;
}

type Outcome<T> = { readonly ok: true; readonly value: T; readonly at: number } | { readonly ok: false; readonly error: unknown; readonly at: number };

/**
 * The latest answer to one cloud read, shared by everyone who asks. A read
 * started before `invalidate()` is never stored, so a command is always
 * followed by an answer Rachio gave after it.
 */
class SharedRead<T> {
  private outcome: Outcome<T> | undefined;
  private inflight: { readonly generation: number; readonly promise: Promise<Outcome<T>> } | undefined;
  private generation = 0;

  constructor(private readonly load: () => Promise<T>, private readonly now: () => number) {}

  async get(maxAgeMs: number, failureRetryMs: number, guard?: () => void): Promise<{ value: T; at: number }> {
    const current = this.outcome;
    const age = current ? this.now() - current.at : Infinity;
    if (current && age < (current.ok ? maxAgeMs : failureRetryMs)) return unwrap(current);
    if (this.inflight?.generation === this.generation) return unwrap(await this.inflight.promise);
    guard?.();
    const generation = this.generation;
    const promise = this.load().then(
      (value): Outcome<T> => ({ ok: true, value, at: this.now() }),
      (error: unknown): Outcome<T> => ({ ok: false, error, at: this.now() }),
    ).then(outcome => {
      if (generation === this.generation) this.outcome = outcome;
      if (this.inflight?.promise === promise) this.inflight = undefined;
      return outcome;
    });
    this.inflight = { generation, promise };
    return unwrap(await promise);
  }

  invalidate(): void {
    this.generation++;
    this.outcome = undefined;
  }
}

function unwrap<T>(outcome: Outcome<T>): { value: T; at: number } {
  if (!outcome.ok) throw outcome.error;
  return { value: outcome.value, at: outcome.at };
}

export function createRachioSiteService(secretsFile: SecretsFile, options: RachioSiteServiceOptions = {}): RachioSiteService | undefined {
  const bag = secretsFor(secretsFile, "vendors", "rachio");
  const apiKey = typeof bag.apiKey === "string" && bag.apiKey.trim() ? bag.apiKey.trim() : undefined;
  if (!apiKey) return undefined;
  return rachioSiteService(new RachioClient(apiKey, {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  }), options);
}

/** The service around an existing client; `createRachioSiteService` is the usual way in. */
export function rachioSiteService(client: RachioClient, options: RachioSiteServiceOptions = {}): RachioSiteService {
  const now = options.now ?? Date.now;
  const settings = { ...RACHIO_DEFAULTS, ...definedOnly(options) };
  let pausedUntil = 0;

  /** Polling stops on the reserve; commands never call this. */
  const guard = () => {
    const at = now();
    if (at < pausedUntil) throw budgetError(pausedUntil);
    const { remaining, resetAt } = client.rateLimit;
    if (remaining === undefined || remaining > settings.reserveCalls) return;
    if (resetAt !== undefined && resetAt <= at) return;
    pausedUntil = resetAt ?? at + 3_600_000;
    throw budgetError(pausedUntil);
  };

  const account = new SharedRead(() => client.controllers(), now);
  const sources = new Map<string, RachioControllerSource>();

  const readController = async (deviceId: string): Promise<RachioControllerReading> => {
    const { value, at } = await account.get(settings.accountIntervalMs, settings.failureRetryMs, guard);
    const controller = value.find(candidate => candidate.id === deviceId);
    if (!controller) throw new RachioError(`The Rachio account has no controller ${deviceId}; run \`bun src/vendors/rachio/discover.ts\` for the right id`, "unavailable");
    return { controller, observedAt: new Date(at).toISOString() };
  };

  return {
    client,
    get requests() { return client.requests; },
    controller(deviceId, sourceOptions = {}) {
      const existing = sources.get(deviceId);
      if (existing) return existing;
      const scheduleIntervalMs = sourceOptions.scheduleIntervalMs ?? settings.scheduleIntervalMs;
      const schedule = new SharedRead(() => client.currentSchedule(deviceId), now);
      let settleUntil = 0;
      const afterWaterCommand = () => { schedule.invalidate(); settleUntil = now() + settings.settleWindowMs; };

      const source: RachioControllerSource = {
        deviceId,
        controller: () => readController(deviceId),
        async watering(wateringOptions = {}) {
          const reading = await readController(deviceId);
          if (reading.controller.status !== "ONLINE") {
            throw new RachioError(`Rachio reports ${reading.controller.name} offline`, "unreachable");
          }
          if (wateringOptions.fresh) schedule.invalidate();
          const interval = now() < settleUntil ? Math.min(settings.settleIntervalMs, scheduleIntervalMs) : scheduleIntervalMs;
          // A fresh read is for a command that is about to spend the reserve anyway.
          const { value, at } = await schedule.get(interval, settings.failureRetryMs, wateringOptions.fresh ? undefined : guard);
          return { ...reading, schedule: value, scheduleObservedAt: new Date(at).toISOString() };
        },
        async startZone(zoneId, seconds) {
          try { await client.startZone(zoneId, seconds); } finally { afterWaterCommand(); }
        },
        async stopWatering() {
          try { await client.stopWater(deviceId); } finally { afterWaterCommand(); }
        },
        async setStandby(standby) {
          try { await client.setStandby(deviceId, standby); } finally { account.invalidate(); }
        },
        async setRainDelay(seconds) {
          try { await client.rainDelay(deviceId, seconds); } finally { account.invalidate(); }
        },
      };
      sources.set(deviceId, source);
      return source;
    },
  };
}

function budgetError(until: number): RachioError {
  return new RachioError(`Rachio's daily API allowance is nearly spent; status reads pause until ${new Date(until).toISOString()} so commands keep working`, "rate_limited");
}

function definedOnly(options: RachioSiteServiceOptions): Partial<Record<keyof typeof RACHIO_DEFAULTS, number>> {
  const result: Partial<Record<keyof typeof RACHIO_DEFAULTS, number>> = {};
  for (const key of Object.keys(RACHIO_DEFAULTS) as (keyof typeof RACHIO_DEFAULTS)[]) {
    const value = options[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/**
 * A site built without a Rachio key. Reads fail with `not_configured`, which
 * the devices report as `unknown` (nothing is known, which is not the same
 * as unreachable); writes name the missing secret.
 */
export function dormantRachioSource(deviceId: string): RachioControllerSource {
  const missing = (): never => { throw new RachioError(`This site has no Rachio API key; store one with \`ht secrets set ${RACHIO_API_KEY_SECRET}\``, "not_configured"); };
  return {
    deviceId,
    controller: async () => missing(),
    watering: async () => missing(),
    startZone: async () => missing(),
    stopWatering: async () => missing(),
    setStandby: async () => missing(),
    setRainDelay: async () => missing(),
  };
}
