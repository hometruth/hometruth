import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { compileEventFilter, type EventFilter, type ServiceEvent } from "./event-log";

/** The installation's event archive. Rows have no age or count expiry. */
export class EventHistory {
  private readonly db: Database;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { strict: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS events (key TEXT PRIMARY KEY, at TEXT NOT NULL, subject TEXT, type TEXT NOT NULL, event TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_time ON events(at DESC, key DESC);
      CREATE INDEX IF NOT EXISTS events_subject ON events(subject, at DESC, key DESC);`);
  }
  save(event: ServiceEvent): void {
    const value = JSON.stringify(event);
    const key = createHash("sha256").update(value).digest("hex");
    this.db.query("INSERT OR IGNORE INTO events VALUES (?, ?, ?, ?, ?)").run(key, event.at, event.subject ?? null, event.type, value);
  }
  page(limit = 200, filter: EventFilter = {}, before?: string): { events: ServiceEvent[]; nextCursor?: string } {
    const maximum = Math.max(1, Math.min(200, Math.trunc(limit) || 200));
    const where: string[] = [];
    const args: string[] = [];
    if (filter.subject !== undefined) { where.push("subject = ?"); args.push(filter.subject); }
    if (filter.types?.length) { where.push(`type IN (${filter.types.map(() => "?").join(",")})`); args.push(...filter.types); }
    if (before) {
      let cursor: unknown;
      try { cursor = JSON.parse(Buffer.from(before, "base64url").toString()); } catch { throw new Error("Invalid event cursor"); }
      if (!Array.isArray(cursor) || cursor.length !== 2 || typeof cursor[0] !== "string" || !Number.isFinite(Date.parse(cursor[0])) || typeof cursor[1] !== "string" || !/^[a-f0-9]{64}$/.test(cursor[1])) throw new Error("Invalid event cursor");
      where.push("(at, key) < (?, ?)"); args.push(cursor[0], cursor[1]);
    }
    const matches = compileEventFilter(filter);
    const query = this.db.prepare<{ key: string; at: string; event: string }, string[]>(`SELECT key, at, event FROM events${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY at DESC, key DESC`);
    const events: ServiceEvent[] = [];
    let last: string | undefined;
    try {
      for (const row of query.iterate(...args)) {
        const event = JSON.parse(row.event) as ServiceEvent;
        if (!matches(event)) continue;
        if (events.length === maximum) return { events, nextCursor: last! };
        events.push(event);
        last = Buffer.from(JSON.stringify([row.at, row.key])).toString("base64url");
      }
    } finally { query.finalize(); }
    return { events };
  }
  close(): void { this.db.close(); }
}
