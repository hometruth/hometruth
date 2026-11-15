import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DAY, isProblem, type HealthCheck, type HealthKind, type HealthStatus } from "./model";
import { diagnoseHealth, type HealthDiagnosis } from "./diagnostics";
import type { HealthInvestigation } from "./investigation";

export interface HealthEntity { key: string; kind: HealthKind; id: string; name: string }
export interface HealthRow extends HealthEntity {
  health: HealthCheck;
  healthySince: string | null;
  uptimePercent: number | null;
  observedMs: number;
  unknownMs: number;
  disabledMs: number;
  expectedOfflineMs: number;
  unreachableIsUnhealthy: boolean;
}
export interface HealthProblem extends HealthEntity {
  detail: string; startedAt: string; lastAt: string; resolvedAt: string | null; occurrences: number;
}
export interface HealthReport {
  since: string; until: string; pollIntervalMs: number; entities: HealthRow[]; problems: HealthProblem[];
  diagnoses: HealthDiagnosis[];
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
      CREATE INDEX IF NOT EXISTS problems_time ON problems(start,end);
      CREATE TABLE IF NOT EXISTS health_policy (key TEXT PRIMARY KEY, unreachable_is_unhealthy INTEGER NOT NULL CHECK(unreachable_is_unhealthy IN (0,1)));
      CREATE TABLE IF NOT EXISTS action_failures (key TEXT PRIMARY KEY, detail TEXT NOT NULL, checked TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS health_investigations (id TEXT PRIMARY KEY, key TEXT NOT NULL, status TEXT NOT NULL,
        created TEXT NOT NULL, document TEXT NOT NULL, open INTEGER NOT NULL DEFAULT 1);
      CREATE INDEX IF NOT EXISTS investigations_entity ON health_investigations(key,open);
      CREATE TABLE IF NOT EXISTS advisor_spend (month TEXT NOT NULL, investigation TEXT NOT NULL, model TEXT NOT NULL, usd REAL NOT NULL);
      CREATE INDEX IF NOT EXISTS advisor_spend_month ON advisor_spend(month);`);
  }

  /** USD charged for Claude reviews in a calendar month (UTC, YYYY-MM). */
  advisorSpend(month: string): number {
    return this.db.query<{ usd: number | null }, [string]>("SELECT SUM(usd) AS usd FROM advisor_spend WHERE month=?").get(month)?.usd ?? 0;
  }

  advisorInvestigationSpend(investigation: string): number {
    return this.db.query<{ usd: number | null }, [string]>("SELECT SUM(usd) AS usd FROM advisor_spend WHERE investigation=?").get(investigation)?.usd ?? 0;
  }

  recordAdvisorSpend(month: string, investigation: string, model: string, usd: number): void {
    this.db.query("INSERT INTO advisor_spend VALUES(?,?,?,?)").run(month, investigation, model, usd);
  }

  saveInvestigation(value: HealthInvestigation): void {
    this.db.query(`INSERT INTO health_investigations(id,key,status,created,document) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,document=excluded.document`).run(value.id, value.entity.key, value.status, value.createdAt, JSON.stringify(value));
  }

  investigation(id: string): HealthInvestigation | undefined {
    const row = this.db.query<{ document: string }, [string]>("SELECT document FROM health_investigations WHERE id=?").get(id);
    return row ? JSON.parse(row.document) : undefined;
  }

  openInvestigation(key: string): HealthInvestigation | undefined {
    const row = this.db.query<{ document: string }, [string]>("SELECT document FROM health_investigations WHERE key=? AND open=1 ORDER BY rowid DESC LIMIT 1").get(key);
    return row ? JSON.parse(row.document) : undefined;
  }

  investigations(limit = 10): HealthInvestigation[] {
    return this.db.query<{ document: string }, [number]>("SELECT document FROM health_investigations ORDER BY created DESC,rowid DESC LIMIT ?").all(limit).map(row => JSON.parse(row.document));
  }

  pendingInvestigations(): HealthInvestigation[] {
    return this.db.query<{ document: string }, []>("SELECT document FROM health_investigations WHERE status IN ('starting','checking') ORDER BY rowid").all().map(row => JSON.parse(row.document));
  }

  unreachableIsUnhealthy(key: string): boolean {
    return this.db.query<{ unreachable_is_unhealthy: number }, [string]>("SELECT unreachable_is_unhealthy FROM health_policy WHERE key=?").get(key)?.unreachable_is_unhealthy !== 0;
  }

  setUnreachableIsUnhealthy(key: string, value: boolean): void {
    this.db.query("INSERT INTO health_policy VALUES(?,?) ON CONFLICT(key) DO UPDATE SET unreachable_is_unhealthy=excluded.unreachable_is_unhealthy").run(key, value ? 1 : 0);
  }

  actionFailure(key: string): HealthCheck | undefined {
    const row = this.db.query<{ detail: string; checked: string }, [string]>("SELECT detail,checked FROM action_failures WHERE key=?").get(key);
    return row ? { status: "unhealthy", reason: "operation_failed", detail: row.detail, checkedAt: row.checked } : undefined;
  }

  recordActionFailure(key: string, health: HealthCheck): void {
    this.db.query("INSERT INTO action_failures VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET detail=excluded.detail,checked=excluded.checked").run(key, health.detail, health.checkedAt!);
  }

  clearActionFailure(key: string): void {
    this.db.transaction(() => {
      this.db.query("DELETE FROM action_failures WHERE key=?").run(key);
      this.db.query("UPDATE health_investigations SET open=0 WHERE key=?").run(key);
    })();
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
      this.clearActionFailure(key);
    }
    const cutoff = now - 30 * DAY;
    this.db.query("DELETE FROM spans WHERE end IS NOT NULL AND end < ?").run(cutoff);
    this.db.query("UPDATE spans SET start=? WHERE start<?").run(cutoff, cutoff);
    this.db.query("DELETE FROM problems WHERE end IS NOT NULL AND end < ?").run(cutoff);
  }

  report(since: number, now: number, pollIntervalMs: number, parents?: ReadonlyMap<string, string>): HealthReport {
    const stamp = (at: number) => new Date(at).toISOString();
    // Only count time the monitor is known to have been running.
    const monitoredUntil = Math.min(now, this.db.query<{ heartbeat: number }, []>("SELECT heartbeat FROM monitor WHERE id=1").get()?.heartbeat ?? now);
    const rows = this.db.query<EntityRow, []>("SELECT * FROM entities WHERE active=1 ORDER BY kind,name,key").all();
    const entities = rows.map(row => {
      const totals = { healthy: 0, degraded: 0, unhealthy: 0, unknown: 0, disabled: 0, expected_offline: 0 };
      for (const span of this.db.query<{ status: HealthStatus; start: number; end: number | null }, [string, number, number]>(
        "SELECT status,start,end FROM spans WHERE key=? AND start<? AND (end IS NULL OR end>?)").all(row.key, now, since)) {
        totals[span.status] += Math.max(0, Math.min(now, span.end ?? monitoredUntil) - Math.max(since, span.start));
      }
      const observedMs = totals.healthy + totals.degraded + totals.unhealthy;
      const health: HealthCheck = this.actionFailure(row.key) ?? (row.checked === null
        ? { status: "unknown", detail: row.detail, checkedAt: null }
        : { status: row.status, detail: row.detail, checkedAt: stamp(row.checked) });
      return { key: row.key, kind: row.kind, id: row.id, name: row.name,
        health,
        healthySince: row.status === "healthy" ? stamp(row.since) : null,
        uptimePercent: observedMs ? 100 * totals.healthy / observedMs : null, observedMs,
        unreachableIsUnhealthy: this.unreachableIsUnhealthy(row.key), expectedOfflineMs: totals.expected_offline,
        disabledMs: totals.disabled, unknownMs: Math.max(0, now - since - observedMs - totals.disabled - totals.expected_offline) };
    });
    const problems = this.db.query<HealthEntity & { detail: string; start: number; last: number; end: number | null; occurrences: number }, [number, number]>(
      `SELECT e.key,e.kind,e.id,e.name,p.detail,p.start,p.last,p.end,p.occurrences FROM problems p JOIN entities e ON e.key=p.key
       WHERE p.start<=? AND (p.end IS NULL OR p.end>=?) ORDER BY p.last DESC`).all(now, since)
      .map(({ start, last, end, ...rest }) => ({ ...rest, startedAt: stamp(start), lastAt: stamp(last), resolvedAt: end === null ? null : stamp(end) }));
    return { since: stamp(since), until: stamp(now), pollIntervalMs, entities, problems, diagnoses: diagnoseHealth(entities, problems, parents) };
  }

  end(now: number): void {
    this.heartbeat(now);
    this.db.query("UPDATE spans SET end=MAX(start,?) WHERE end IS NULL").run(now);
  }
  close(): void { if (!this.closed) { this.closed = true; this.db.close(); } }
}
