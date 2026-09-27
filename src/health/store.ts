import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DAY, isProblem, type HealthCheck, type HealthKind, type HealthStatus } from "./model";

export interface HealthEntity { key: string; kind: HealthKind; id: string; name: string }
export interface HealthRow extends HealthEntity {
  health: HealthCheck;
  healthySince: string | null;
  uptimePercent: number | null;
  observedMs: number;
  unknownMs: number;
  disabledMs: number;
}
export interface HealthProblem extends HealthEntity {
  detail: string; startedAt: string; lastAt: string; resolvedAt: string | null; occurrences: number;
}
export interface HealthReport {
  since: string; until: string; pollIntervalMs: number; entities: HealthRow[]; problems: HealthProblem[];
}
interface EntityRow extends HealthEntity { status: HealthStatus; detail: string; checked: number | null; since: number }

/** Time-weighted observations. A stopped/crashed monitor leaves a gap, never assumed uptime. */
export class HealthStore {
  private readonly db: Database;
  private closed = false;
  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { strict: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS monitor (id INTEGER PRIMARY KEY CHECK(id=1), heartbeat INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS entities (key TEXT PRIMARY KEY, kind TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
        status TEXT NOT NULL, detail TEXT NOT NULL, checked INTEGER, since INTEGER NOT NULL, active INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS spans (key TEXT NOT NULL, status TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER);
      CREATE INDEX IF NOT EXISTS spans_key ON spans(key,start);
      CREATE TABLE IF NOT EXISTS problems (key TEXT NOT NULL, detail TEXT NOT NULL, start INTEGER NOT NULL, last INTEGER NOT NULL, end INTEGER, occurrences INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS problems_time ON problems(start,end);`);
  }

  begin(now: number): void {
    const last = this.db.query<{ heartbeat: number }, []>("SELECT heartbeat FROM monitor WHERE id=1").get()?.heartbeat ?? now;
    this.db.transaction(() => {
      this.db.query("UPDATE spans SET end=MAX(start, ?) WHERE end IS NULL").run(Math.min(now, last));
      this.db.exec("UPDATE entities SET active=0");
      this.heartbeat(now);
    })();
  }

  heartbeat(now: number): void {
    this.db.query("INSERT INTO monitor VALUES(1,?) ON CONFLICT(id) DO UPDATE SET heartbeat=excluded.heartbeat").run(now);
  }

  observe(entity: HealthEntity, health: HealthCheck, now: number): void {
    const old = this.db.query<EntityRow & { active: number }, [string]>("SELECT * FROM entities WHERE key=?").get(entity.key);
    const changed = !old?.active || old.status !== health.status;
    this.db.transaction(() => {
      if (changed) {
        this.db.query("UPDATE spans SET end=MAX(start,?) WHERE key=? AND end IS NULL").run(now, entity.key);
        this.db.query("INSERT INTO spans VALUES(?,?,?,NULL)").run(entity.key, health.status, now);
      }
      this.db.query(`INSERT INTO entities VALUES(?,?,?,?,?,?,?,?,1) ON CONFLICT(key) DO UPDATE SET
        kind=excluded.kind,id=excluded.id,name=excluded.name,status=excluded.status,detail=excluded.detail,
        checked=excluded.checked,since=excluded.since,active=1`).run(entity.key, entity.kind, entity.id, entity.name,
          health.status, health.detail, health.checkedAt === null ? null : now, changed ? now : old!.since);
      if (!isProblem(health.status) && health.status !== "unknown") {
        this.db.query("UPDATE problems SET end=? WHERE key=? AND end IS NULL").run(now, entity.key);
      }
    })();
  }

  problem(entity: HealthEntity, detail: string, now: number): void {
    const current = this.db.query<{ detail: string }, [string]>("SELECT detail FROM problems WHERE key=? AND end IS NULL").get(entity.key);
    // A different symptom is not recovery. Keep the incident open until an
    // observation confirms recovery, retaining the latest explanation here;
    // individual reports remain available on the event stream.
    if (current) this.db.query("UPDATE problems SET detail=?,last=?,occurrences=occurrences+1 WHERE key=? AND end IS NULL").run(detail, now, entity.key);
    else this.db.query("INSERT INTO problems VALUES(?,?,?,?,NULL,1)").run(entity.key, detail, now, now);
  }

  retain(keys: readonly string[], now: number): void {
    const keep = new Set(keys);
    for (const { key } of this.db.query<{ key: string }, []>("SELECT key FROM entities WHERE active=1").all()) {
      if (keep.has(key)) continue;
      this.db.query("UPDATE spans SET end=MAX(start,?) WHERE key=? AND end IS NULL").run(now, key);
      this.db.query("UPDATE entities SET active=0 WHERE key=?").run(key);
      this.db.query("UPDATE problems SET end=? WHERE key=? AND end IS NULL").run(now, key);
    }
    const cutoff = now - 30 * DAY;
    this.db.query("DELETE FROM spans WHERE end IS NOT NULL AND end < ?").run(cutoff);
    this.db.query("UPDATE spans SET start=? WHERE start<?").run(cutoff, cutoff);
    this.db.query("DELETE FROM problems WHERE end IS NOT NULL AND end < ?").run(cutoff);
  }

  report(since: number, now: number, pollIntervalMs: number): HealthReport {
    const stamp = (at: number) => new Date(at).toISOString();
    // Only count time the monitor is known to have been running.
    const monitoredUntil = Math.min(now, this.db.query<{ heartbeat: number }, []>("SELECT heartbeat FROM monitor WHERE id=1").get()?.heartbeat ?? now);
    const rows = this.db.query<EntityRow, []>("SELECT * FROM entities WHERE active=1 ORDER BY kind,name,key").all();
    const entities = rows.map(row => {
      const totals = { healthy: 0, degraded: 0, unhealthy: 0, unknown: 0, disabled: 0 };
      for (const span of this.db.query<{ status: HealthStatus; start: number; end: number | null }, [string, number, number]>(
        "SELECT status,start,end FROM spans WHERE key=? AND start<? AND (end IS NULL OR end>?)").all(row.key, now, since)) {
        totals[span.status] += Math.max(0, Math.min(now, span.end ?? monitoredUntil) - Math.max(since, span.start));
      }
      const observedMs = totals.healthy + totals.degraded + totals.unhealthy;
      const health: HealthCheck = row.checked === null
        ? { status: "unknown", detail: row.detail, checkedAt: null }
        : { status: row.status, detail: row.detail, checkedAt: stamp(row.checked) };
      return { key: row.key, kind: row.kind, id: row.id, name: row.name,
        health,
        healthySince: row.status === "healthy" ? stamp(row.since) : null,
        uptimePercent: observedMs ? 100 * totals.healthy / observedMs : null, observedMs,
        disabledMs: totals.disabled, unknownMs: Math.max(0, now - since - observedMs - totals.disabled) };
    });
    const problems = this.db.query<HealthEntity & { detail: string; start: number; last: number; end: number | null; occurrences: number }, [number, number]>(
      `SELECT e.key,e.kind,e.id,e.name,p.detail,p.start,p.last,p.end,p.occurrences FROM problems p JOIN entities e ON e.key=p.key
       WHERE p.start<=? AND (p.end IS NULL OR p.end>=?) ORDER BY p.last DESC`).all(now, since)
      .map(({ start, last, end, ...rest }) => ({ ...rest, startedAt: stamp(start), lastAt: stamp(last), resolvedAt: end === null ? null : stamp(end) }));
    return { since: stamp(since), until: stamp(now), pollIntervalMs, entities, problems };
  }

  end(now: number): void {
    this.heartbeat(now);
    this.db.query("UPDATE spans SET end=MAX(start,?) WHERE end IS NULL").run(now);
  }
  close(): void { if (!this.closed) { this.closed = true; this.db.close(); } }
}
