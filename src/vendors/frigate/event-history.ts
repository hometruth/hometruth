import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { compileEventFilter, type EventData, type EventFilter, type ServiceEvent } from "../../models/event-log";
import { validateEventData } from "../../validation";
import { detectionLabel, detectionLabels } from "../../models/detection-labels";

export const DEFAULT_FRIGATE_HISTORY_PATH = ".hometruth/frigate/events.sqlite";

/** Recording links can change with site configuration without creating a new detection. */
export function frigateEventKey(data: EventData): string {
  const { recordingUrl: _url, recordingStartTime: _time, ...detection } = data;
  return createHash("sha256").update(JSON.stringify(detection)).digest("hex");
}

/** Durable, bounded label metadata only. No images or video are accepted by the event schemas. */
export class FrigateEventHistory {
  private readonly db: Database;

  constructor(path = DEFAULT_FRIGATE_HISTORY_PATH, private readonly capacity = 10_000) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Invalid Frigate history capacity");
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { strict: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS events (
        key TEXT PRIMARY KEY, at TEXT NOT NULL, subject TEXT, type TEXT NOT NULL,
        level TEXT NOT NULL, camera TEXT NOT NULL, object_id TEXT NOT NULL, event TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_time ON events(at DESC);
      CREATE INDEX IF NOT EXISTS events_subject ON events(subject, at DESC);
      CREATE INDEX IF NOT EXISTS events_object ON events(camera, object_id);`);
    if (!(this.db.query("PRAGMA table_info(events)").all() as { name: string }[]).some(c => c.name === "labels")) {
      this.db.transaction(() => {
        this.db.exec("ALTER TABLE events ADD COLUMN labels TEXT NOT NULL DEFAULT '[]'");
        for (const row of this.db.query("SELECT key, event FROM events").all() as { key: string; event: string }[]) {
          this.db.query("UPDATE events SET labels = ? WHERE key = ?").run(JSON.stringify(detectionLabels(JSON.parse(row.event).data)), row.key);
        }
      })();
    }
  }

  has(key: string): boolean { return !!this.db.query("SELECT 1 FROM events WHERE key = ?").get(key); }
  hasObject(camera: string, id: string): boolean {
    return !!this.db.query("SELECT 1 FROM events WHERE camera = ? AND object_id = ? LIMIT 1").get(camera, id);
  }
  hasObjectFrame(camera: string, id: string, frameTime: number): boolean {
    return !!this.db.query(`SELECT 1 FROM events WHERE camera = ? AND object_id = ?
      AND json_extract(event, '$.data.frameTime') = ? LIMIT 1`).get(camera, id, frameTime);
  }

  save(event: ServiceEvent): boolean {
    if (!["camera_object", "camera_classified"].includes(event.type) || !event.data
      || !validateEventData(event.type, event.data) || !Number.isFinite(Date.parse(event.at))
      || event.level !== "info" || typeof event.message !== "string" || event.message.length > 2000
      || (event.subject !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(event.subject))) {
      throw new Error("Invalid Frigate history event");
    }
    // Copy the envelope too: unrelated fields never enter the metadata archive.
    const saved: ServiceEvent = { at: new Date(event.at).toISOString(), type: event.type, level: event.level,
      message: event.message, ...(event.subject ? { subject: event.subject } : {}), data: event.data };
    return this.db.transaction(() => {
      const result = this.db.query("INSERT OR IGNORE INTO events (key, at, subject, type, level, camera, object_id, event, labels) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        frigateEventKey(event.data!), saved.at, saved.subject ?? null, saved.type, saved.level,
        event.data!.camera as string, event.data!.objectId as string, JSON.stringify(saved), JSON.stringify(detectionLabels(saved.data)));
      if (result.changes) this.db.query("DELETE FROM events WHERE rowid IN (SELECT rowid FROM events ORDER BY at DESC, rowid DESC LIMIT -1 OFFSET ?)").run(this.capacity);
      return result.changes > 0;
    })();
  }

  recent(limit = 500, filter: EventFilter = {}): ServiceEvent[] {
    const matches = compileEventFilter(filter);
    const maximum = Math.max(0, Math.min(this.capacity, Math.trunc(limit)));
    if (!maximum) return [];
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.subject !== undefined) { where.push("subject = ?"); args.push(filter.subject); }
    if (filter.level !== undefined) { where.push("level = ?"); args.push(filter.level); }
    if (filter.atOrBefore !== undefined) { where.push("at <= ?"); args.push(filter.atOrBefore); }
    if (filter.types?.length) { where.push(`type IN (${filter.types.map(() => "?").join(",")})`); args.push(...filter.types); }
    if (filter.labels?.length) { where.push(`EXISTS (SELECT 1 FROM json_each(events.labels) WHERE value IN (${filter.labels.map(() => "?").join(",")}))`); args.push(...filter.labels.map(label => detectionLabel(label)!)); }
    // The portable predicate runs before the result limit. Iterate the bounded
    // archive so a rare match behind newer nonmatches is still returned.
    args.push(filter.where ? this.capacity : maximum);
    const statement = this.db.prepare<{ event: string }, (string | number)[]>(`SELECT event FROM events${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY at DESC, key DESC LIMIT ?`);
    const events: ServiceEvent[] = [];
    try {
      for (const row of statement.iterate(...args)) {
        const event = JSON.parse(row.event) as ServiceEvent;
        if (matches(event)) events.push(event);
        if (events.length === maximum) break;
      }
    } finally { statement.finalize(); }
    return events;
  }

  subjects(): string[] {
    return (this.db.query("SELECT DISTINCT subject FROM events WHERE subject IS NOT NULL ORDER BY subject").all() as { subject: string }[]).map(row => row.subject);
  }
  detectionLabels(): string[] {
    return (this.db.query("SELECT DISTINCT value FROM events, json_each(events.labels) ORDER BY value").all() as { value: string }[]).map(row => row.value);
  }
  close(): void { this.db.close(); }
}
