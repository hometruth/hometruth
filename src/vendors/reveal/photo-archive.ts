import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CameraMediaError } from "../../camera-media";
import type { CameraPhoto, CameraPhotoHistory, CameraPhotoPage, PhotoLabels } from "../../camera-photos";
import { RevealError, type RevealClient, type RevealPhoto } from "../../protocols/reveal/client";
import { detectionLabels } from "../../models/detection-labels";

declare module "../../models/device" {
  interface SiteServices { revealPhotos?: RevealPhotoArchive }
}

type PhotoClient = Pick<RevealClient, "listPhotos" | "downloadPhoto">;
type PhotoRow = { id: string; capturedAt: string | null; uploadedAt: number | null; savedAt: number; sortAt: number };
type SyncRow = {
  lastCheckedAt: number | null; lastSuccessAt: number | null; nextCheckAt: number; fullScanAt: number | null; failures: number; error: string | null;
  cursor: string | null; scanMode: "full" | "incremental" | null; scanPages: number;
  requestVersion: number; completedVersion: number; scanVersion: number;
};
const DAY = 86_400_000;
const PAGE_SIZE = 48;

export interface SavedPhotoLabels {
  id: string; cameraId: string; capturedAt: string | null; uploadedAt: number | null;
  result: PhotoLabels; serializedResult: string;
}

export function revealPhotoKey(cameraId: string, photoId: string): string {
  return createHash("sha256").update(JSON.stringify([cameraId, photoId])).digest("hex");
}

/** One server-owned archive. JPEGs commit before metadata, so failed downloads can be retried. */
export class RevealPhotoArchive {
  readonly directory: string;
  private database: Promise<Database> | undefined;
  private openedDatabase: Database | undefined;
  private readonly active = new Map<string, Promise<void>>();
  private closed = false;
  labelingEnabled = false;

  constructor(directory = ".hometruth/reveal/library", private readonly now: () => number = Date.now) {
    this.directory = resolve(directory);
  }

  private async db(): Promise<Database> {
    if (this.closed) throw new Error("REVEAL photo archive is closed");
    return this.database ??= (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const dir = await lstat(this.directory);
      if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error("REVEAL archive requires a regular directory");
      await chmod(this.directory, 0o700);
      const path = join(this.directory, "index.sqlite");
      const file = await open(path, "a", 0o600);
      await file.close();
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("REVEAL archive index must be a regular file");
      await chmod(path, 0o600);
      const db = new Database(path, { strict: true });
      db.run(`PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS photos (
          id TEXT PRIMARY KEY, cameraId TEXT NOT NULL, photoId TEXT NOT NULL,
          capturedAt TEXT, uploadedAt INTEGER, savedAt INTEGER NOT NULL, sortAt INTEGER NOT NULL,
          UNIQUE(cameraId, photoId)
        );
        CREATE INDEX IF NOT EXISTS photos_camera_time ON photos(cameraId, sortAt DESC, id DESC);
        CREATE TABLE IF NOT EXISTS sync (
          cameraId TEXT PRIMARY KEY, lastCheckedAt INTEGER, lastSuccessAt INTEGER,
          nextCheckAt INTEGER NOT NULL DEFAULT 0, fullScanAt INTEGER, failures INTEGER NOT NULL DEFAULT 0, error TEXT
        );
        CREATE TABLE IF NOT EXISTS scan_tokens (cameraId TEXT NOT NULL, tokenHash TEXT NOT NULL, PRIMARY KEY(cameraId, tokenHash));
        CREATE TABLE IF NOT EXISTS photo_labels (id TEXT PRIMARY KEY, result TEXT, attempts INTEGER NOT NULL DEFAULT 0,
          nextAttemptAt INTEGER NOT NULL DEFAULT 0, error TEXT);`);
      const columns = new Set(db.query<{ name: string }, []>("PRAGMA table_info(sync)").all().map(row => row.name));
      for (const [name, declaration] of Object.entries({
        cursor: "TEXT", scanMode: "TEXT", scanPages: "INTEGER NOT NULL DEFAULT 0",
        requestVersion: "INTEGER NOT NULL DEFAULT 0", completedVersion: "INTEGER NOT NULL DEFAULT 0", scanVersion: "INTEGER NOT NULL DEFAULT 0",
      })) if (!columns.has(name)) db.run(`ALTER TABLE sync ADD COLUMN ${name} ${declaration}`);
      const labelColumns = new Set(db.query<{ name: string }, []>("PRAGMA table_info(photo_labels)").all().map(row => row.name));
      if (!labelColumns.has("publishedResult")) db.run("ALTER TABLE photo_labels ADD COLUMN publishedResult TEXT");
      if (!labelColumns.has("labels")) db.transaction(() => {
        db.run("ALTER TABLE photo_labels ADD COLUMN labels TEXT NOT NULL DEFAULT '[]'");
        for (const row of db.query("SELECT id, result FROM photo_labels WHERE result IS NOT NULL").all() as { id: string; result: string }[]) {
          db.query("UPDATE photo_labels SET labels = ? WHERE id = ?").run(JSON.stringify(detectionLabels(JSON.parse(row.result))), row.id);
        }
      })();
      if (!labelColumns.has("nativeResult")) db.run("ALTER TABLE photo_labels ADD COLUMN nativeResult TEXT");
      if (!labelColumns.has("nativeTarget")) db.run("ALTER TABLE photo_labels ADD COLUMN nativeTarget TEXT");
      this.openedDatabase = db;
      return db;
    })().catch(error => { this.database = undefined; throw error; });
  }

  history(cameraId: string): CameraPhotoHistory {
    return { list: (cursor, order) => this.list(cameraId, cursor, order), read: id => this.read(cameraId, id), syncAll: () => this.requestFullSync(cameraId) };
  }

  /** Open once before synchronous service-history views are exposed. */
  async prepare(): Promise<void> { await this.db(); }

  /** Page existing labels directly from their original archive; no second image or label archive. */
  labeledPhotos(cameraIds: readonly string[], limit = 200, atOrBefore?: string, labels?: readonly string[], accepts?: (job: SavedPhotoLabels) => boolean): SavedPhotoLabels[] {
    const db = this.openedDatabase;
    if (this.closed || !db || !cameraIds.length) return [];
    const maximum = Math.max(0, Math.trunc(limit));
    if (!maximum) return [];
    const before = atOrBefore ? Date.parse(atOrBefore) : undefined;
    const statement = db.prepare<{ id: string; cameraId: string; capturedAt: string | null; uploadedAt: number | null; result: string }, (string | number)[]>(
      `SELECT p.id, p.cameraId, p.capturedAt, p.uploadedAt, l.result FROM photos p JOIN photo_labels l ON p.id = l.id
       WHERE p.cameraId IN (${cameraIds.map(() => "?").join(",")}) AND l.result IS NOT NULL
       ${before !== undefined ? "AND json_extract(l.result, '$.processedAt') <= ?" : ""}
       ${labels?.length ? `AND EXISTS (SELECT 1 FROM json_each(l.labels) WHERE value IN (${labels.map(() => "?").join(",")}))` : ""}
       ORDER BY json_extract(l.result, '$.processedAt') DESC, p.id DESC LIMIT ?`);
    const jobs: SavedPhotoLabels[] = [];
    try {
      for (const row of statement.iterate(...cameraIds, ...(before !== undefined ? [before] : []), ...(labels ?? []), accepts ? -1 : maximum)) {
        const job = { ...row, serializedResult: row.result, result: JSON.parse(row.result) as PhotoLabels };
        if (!accepts || accepts(job)) jobs.push(job);
        if (jobs.length === maximum) break;
      }
    } finally { statement.finalize(); }
    return jobs;
  }

  labelCounts(cameraIds: readonly string[]): { total: number; completed: number } {
    if (this.closed || !this.openedDatabase || !cameraIds.length) return { total: 0, completed: 0 };
    return this.openedDatabase.query<{ total: number; completed: number }, string[]>(
      `SELECT COUNT(*) AS total, COUNT(l.result) AS completed FROM photos p LEFT JOIN photo_labels l ON p.id = l.id
       WHERE p.cameraId IN (${cameraIds.map(() => "?").join(",")})`).get(...cameraIds)!;
  }

  detectionLabels(cameraIds: readonly string[]): string[] {
    if (this.closed || !this.openedDatabase || !cameraIds.length) return [];
    return (this.openedDatabase.query(`SELECT DISTINCT j.value FROM photos p JOIN photo_labels l ON p.id = l.id,
      json_each(l.labels) j WHERE p.cameraId IN (${cameraIds.map(() => "?").join(",")}) ORDER BY j.value`)
      .all(...cameraIds) as { value: string }[]).map(row => row.value);
  }

  detectionLabelCounts(cameraIds: readonly string[]): Record<string, number> {
    if (this.closed || !this.openedDatabase || !cameraIds.length) return {};
    const rows = this.openedDatabase.query(`SELECT j.value AS label, COUNT(*) AS count
      FROM photos p JOIN photo_labels l ON p.id = l.id, json_each(l.labels) j
      WHERE l.result IS NOT NULL AND p.cameraId IN (${cameraIds.map(() => "?").join(",")}) GROUP BY j.value`)
      .all(...cameraIds) as { label: string; count: number }[];
    return Object.fromEntries(rows.map(row => [row.label, row.count]));
  }

  async pendingNativePhotos(cameraIds: readonly string[], target: string, limit = 20): Promise<SavedPhotoLabels[]> {
    if (!cameraIds.length) return [];
    const db = await this.db();
    return (db.query(`SELECT p.id, p.cameraId, p.capturedAt, p.uploadedAt, l.result FROM photos p JOIN photo_labels l ON p.id = l.id
      WHERE p.cameraId IN (${cameraIds.map(() => "?").join(",")}) AND l.result IS NOT NULL
      AND (l.nativeTarget IS NULL OR l.nativeTarget != ? OR l.nativeResult IS NULL OR l.nativeResult != l.result)
      ORDER BY p.savedAt DESC, p.id DESC LIMIT ?`).all(...cameraIds, target, limit) as (Omit<SavedPhotoLabels, "result" | "serializedResult"> & { result: string })[])
      .map(row => ({ ...row, serializedResult: row.result, result: JSON.parse(row.result) as PhotoLabels }));
  }

  async markNativePhoto(id: string, result: string, target: string): Promise<void> {
    (await this.db()).query("UPDATE photo_labels SET nativeResult = ?, nativeTarget = ? WHERE id = ? AND result = ?").run(result, target, id, result);
  }

  nativePhotoCount(cameraIds: readonly string[], target: string): number {
    if (this.closed || !this.openedDatabase || !cameraIds.length) return 0;
    return (this.openedDatabase.query(`SELECT COUNT(*) AS count FROM photos p JOIN photo_labels l ON p.id = l.id
      WHERE p.cameraId IN (${cameraIds.map(() => "?").join(",")}) AND l.nativeTarget = ? AND l.nativeResult = l.result`)
      .get(...cameraIds, target) as { count: number }).count;
  }

  async list(cameraId: string, cursor?: string, order: "newest" | "oldest" = "newest"): Promise<CameraPhotoPage> {
    const db = await this.db();
    let after: { time: number; id: string } | undefined;
    if (cursor !== undefined) {
      const match = /^(\d+):([a-f0-9]{64})$/u.exec(cursor);
      if (!match || !Number.isSafeInteger(Number(match[1]))) throw new CameraMediaError("Invalid photo cursor", "invalid_uri");
      after = { time: Number(match[1]), id: match[2]! };
    }
    const direction = order === "oldest" ? "ASC" : "DESC";
    const comparison = order === "oldest" ? ">" : "<";
    const rows = after
      ? db.query<PhotoRow, [string, number, number, string, number]>(`SELECT * FROM photos WHERE cameraId = ? AND (sortAt ${comparison} ? OR (sortAt = ? AND id ${comparison} ?)) ORDER BY sortAt ${direction}, id ${direction} LIMIT ?`).all(cameraId, after.time, after.time, after.id, PAGE_SIZE + 1)
      : db.query<PhotoRow, [string, number]>(`SELECT * FROM photos WHERE cameraId = ? ORDER BY sortAt ${direction}, id ${direction} LIMIT ?`).all(cameraId, PAGE_SIZE + 1);
    const hasMore = rows.length > PAGE_SIZE;
    const visible = rows.slice(0, PAGE_SIZE);
    const last = visible.at(-1);
    const state = db.query<SyncRow, [string]>("SELECT * FROM sync WHERE cameraId = ?").get(cameraId);
    const labels = db.query<{ result: string | null; error: string | null }, [string]>("SELECT result, error FROM photo_labels WHERE id = ?");
    const labelCounts = db.query<{ completed: number; retrying: number }, [string]>(`SELECT
      COUNT(CASE WHEN l.result IS NOT NULL THEN 1 END) AS completed,
      COUNT(CASE WHEN l.result IS NULL AND l.error IS NOT NULL THEN 1 END) AS retrying
      FROM photos p LEFT JOIN photo_labels l ON p.id = l.id WHERE p.cameraId = ?`).get(cameraId)!;
    const total = db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM photos WHERE cameraId = ?").get(cameraId)!.count;
    return {
      photos: visible.map((row): CameraPhoto => {
        const label = labels.get(row.id);
        return { id: row.id, savedAt: row.savedAt,
        ...(row.capturedAt !== null ? { capturedAt: row.capturedAt } : {}),
        ...(row.uploadedAt !== null ? { uploadedAt: row.uploadedAt } : {}),
        ...(label?.result ? { labeling: { status: "complete", result: JSON.parse(label.result) as PhotoLabels } }
          : this.labelingEnabled ? { labeling: { status: label?.error ? "retrying" : "pending", ...(label?.error ? { error: label.error } : {}) } } : {}),
      }; }),
      total,
      ...(this.labelingEnabled || labelCounts.completed ? { labeling: { ...labelCounts, pending: total - labelCounts.completed } } : {}),
      ...(hasMore && last ? { nextCursor: `${last.sortAt}:${last.id}` } : {}),
      sync: { running: this.active.has(cameraId),
        continuing: Boolean(state?.scanMode), pagesScanned: state?.scanPages ?? 0,
        fullSyncQueued: (state?.requestVersion ?? 0) > (state?.completedVersion ?? 0),
        ...(state?.lastCheckedAt != null ? { lastCheckedAt: state.lastCheckedAt } : {}),
        ...(state?.lastSuccessAt != null ? { lastSuccessAt: state.lastSuccessAt } : {}),
        ...(state?.nextCheckAt ? { nextCheckAt: state.nextCheckAt } : {}),
        ...(state?.error ? { error: state.error } : {}),
      },
    };
  }

  /** Missing results are the durable queue, including all photos saved before labeling was enabled. */
  async pendingLabels(cameraIds: readonly string[], limit = 8): Promise<{ cameraId: string; id: string }[]> {
    if (!cameraIds.length) return [];
    const db = await this.db();
    return db.query<{ cameraId: string; id: string }, (string | number)[]>(`SELECT p.cameraId, p.id FROM photos p
      LEFT JOIN photo_labels l ON p.id = l.id WHERE p.cameraId IN (${cameraIds.map(() => "?").join(",")})
      AND l.result IS NULL AND COALESCE(l.nextAttemptAt, 0) <= ?
      ORDER BY p.savedAt DESC, p.id DESC LIMIT ?`).all(...cameraIds, this.now(), limit);
  }

  async saveLabels(id: string, result: PhotoLabels): Promise<void> {
    const db = await this.db();
    db.query(`INSERT INTO photo_labels(id, result, labels) SELECT id, ?, ? FROM photos WHERE id = ?
      ON CONFLICT(id) DO UPDATE SET result = excluded.result, labels = excluded.labels, attempts = 0, nextAttemptAt = 0, error = NULL`)
      .run(JSON.stringify(result), JSON.stringify(detectionLabels(result as unknown as Record<string, unknown>)), id);
  }

  /** Results saved before event delivery was enabled are included. A changed result is a new event. */
  async pendingLabelEvents(cameraIds: readonly string[], limit = 20): Promise<{
    id: string; cameraId: string; capturedAt: string | null; uploadedAt: number | null; result: PhotoLabels; serializedResult: string;
  }[]> {
    if (!cameraIds.length) return [];
    const db = await this.db();
    return db.query<{ id: string; cameraId: string; capturedAt: string | null; uploadedAt: number | null; result: string }, (string | number)[]>(
      `SELECT p.id, p.cameraId, p.capturedAt, p.uploadedAt, l.result FROM photos p JOIN photo_labels l ON p.id = l.id
       WHERE p.cameraId IN (${cameraIds.map(() => "?").join(",")}) AND l.result IS NOT NULL
       AND (l.publishedResult IS NULL OR l.publishedResult != l.result) ORDER BY p.savedAt DESC, p.id DESC LIMIT ?`)
      .all(...cameraIds, limit).map(row => ({ ...row, serializedResult: row.result, result: JSON.parse(row.result) as PhotoLabels }));
  }

  async markLabelEventPublished(id: string, serializedResult: string): Promise<void> {
    const db = await this.db();
    // Do not acknowledge a newer inference that replaced this result during publication.
    db.query("UPDATE photo_labels SET publishedResult = ? WHERE id = ? AND result = ?").run(serializedResult, id, serializedResult);
  }

  async failLabels(id: string): Promise<void> {
    const db = await this.db();
    const attempts = (db.query<{ attempts: number }, [string]>("SELECT attempts FROM photo_labels WHERE id = ?").get(id)?.attempts ?? 0) + 1;
    db.query(`INSERT INTO photo_labels(id, attempts, nextAttemptAt, error) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET attempts = excluded.attempts, nextAttemptAt = excluded.nextAttemptAt, error = excluded.error`)
      .run(id, attempts, this.now() + Math.min(3_600_000, 30_000 * 2 ** Math.min(attempts, 7)), "Could not label this photo; HomeTruth will retry");
  }

  /** Queue a full scan without bypassing a cloud rate-limit/error backoff. */
  async requestFullSync(cameraId: string): Promise<void> {
    const db = await this.db();
    db.query("INSERT OR IGNORE INTO sync(cameraId) VALUES (?)").run(cameraId);
    const state = db.query<SyncRow, [string]>("SELECT * FROM sync WHERE cameraId = ?").get(cameraId)!;
    if (state.requestVersion > state.completedVersion || state.scanMode === "full") return;
    db.query("UPDATE sync SET requestVersion = requestVersion + 1, nextCheckAt = CASE WHEN error IS NULL THEN 0 ELSE nextCheckAt END WHERE cameraId = ?").run(cameraId);
  }

  async read(cameraId: string, id: string): Promise<Uint8Array | undefined> {
    if (!/^[a-f0-9]{64}$/u.test(id)) return undefined;
    const db = await this.db();
    if (!db.query("SELECT 1 FROM photos WHERE cameraId = ? AND id = ?").get(cameraId, id)) return undefined;
    const path = join(this.directory, `${id}.jpg`);
    const stat = await lstat(path).catch(() => undefined);
    if (!stat?.isFile() || stat.isSymbolicLink()) return undefined;
    return readFile(path);
  }

  /** Incremental polls stop at a wholly saved page; a daily full scan catches late/older uploads. */
  async sync(cameraId: string, client: PhotoClient, options: {
    intervalMs: number; maxPages?: number; signal?: AbortSignal;
    latest?: (photo: RevealPhoto | undefined) => void;
  }): Promise<void> {
    const existing = this.active.get(cameraId);
    if (existing) return existing;
    const work = this.syncOnce(cameraId, client, options).finally(() => this.active.delete(cameraId));
    this.active.set(cameraId, work);
    return work;
  }

  private async syncOnce(cameraId: string, client: PhotoClient, options: {
    intervalMs: number; maxPages?: number; signal?: AbortSignal;
    latest?: (photo: RevealPhoto | undefined) => void;
  }): Promise<void> {
    const db = await this.db();
    const previous = db.query<SyncRow, [string]>("SELECT * FROM sync WHERE cameraId = ?").get(cameraId);
    if (this.now() < (previous?.nextCheckAt ?? 0)) return;
    options.signal?.throwIfAborted();
    db.query(`INSERT INTO sync(cameraId, lastCheckedAt) VALUES (?, ?) ON CONFLICT(cameraId) DO UPDATE SET lastCheckedAt = excluded.lastCheckedAt`).run(cameraId, this.now());
    const requested = (previous?.requestVersion ?? 0) > (previous?.scanVersion ?? 0);
    const resume = Boolean(previous?.scanMode) && !requested;
    const fullScan = requested || (resume ? previous!.scanMode === "full" : !previous?.fullScanAt || this.now() - previous.fullScanAt >= DAY);
    const scanVersion = previous?.requestVersion ?? 0;
    if (!resume) {
      db.transaction(() => {
        db.query("DELETE FROM scan_tokens WHERE cameraId = ?").run(cameraId);
        db.query("UPDATE sync SET cursor = NULL, scanMode = ?, scanPages = 0, scanVersion = ? WHERE cameraId = ?")
          .run(fullScan ? "full" : "incremental", scanVersion, cameraId);
      })();
    }
    let paginationKey = resume ? previous?.cursor ?? undefined : undefined;
    const startsAtHead = !paginationKey;
    let latestReported = false;
    let finished = false;
    try {
      for (let page = 0; page < (options.maxPages ?? 100); page++) {
        options.signal?.throwIfAborted();
        const result = await client.listPhotos({ cameraId, size: 100, ...(paginationKey ? { paginationKey } : {}) });
        options.signal?.throwIfAborted();
        if (startsAtHead && !latestReported && result.photos[0]) { options.latest?.(result.photos[0]); latestReported = true; }
        let allSaved = result.photos.length > 0;
        for (const photo of result.photos) {
          options.signal?.throwIfAborted();
          if (photo.cameraId !== cameraId) throw new RevealError("REVEAL returned photos for another camera", "protocol");
          const id = revealPhotoKey(cameraId, photo.photoId);
          const known = db.query("SELECT 1 FROM photos WHERE id = ?").get(id);
          const target = join(this.directory, `${id}.jpg`);
          const file = await lstat(target).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
          });
          if (file && (!file.isFile() || file.isSymbolicLink())) throw new Error("REVEAL image destination must be a regular file");
          if (known && file && file.size > 0) continue;
          allSaved = false;
          const bytes = await client.downloadPhoto(photo);
          options.signal?.throwIfAborted();
          const temporary = join(this.directory, `.${id}.${randomUUID()}.tmp`);
          try {
            const handle = await open(temporary, "wx", 0o600);
            try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
            await rename(temporary, target);
          } finally { await unlink(temporary).catch(() => {}); }
          const savedAt = this.now();
          const uploadedAt = Number.isSafeInteger(photo.createdTimestamp) && photo.createdTimestamp! >= 0 ? photo.createdTimestamp! : null;
          db.query(`INSERT OR IGNORE INTO photos(id, cameraId, photoId, capturedAt, uploadedAt, savedAt, sortAt) VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(id, cameraId, photo.photoId, photo.photoTimestamp != null ? String(photo.photoTimestamp) : null, uploadedAt, savedAt, uploadedAt ?? savedAt);
        }
        if (!result.nextToken || (!fullScan && allSaved)) {
          finished = true;
          db.query("UPDATE sync SET scanPages = scanPages + 1 WHERE cameraId = ?").run(cameraId);
          break;
        }
        const tokenHash = createHash("sha256").update(result.nextToken).digest("hex");
        if (db.query("SELECT 1 FROM scan_tokens WHERE cameraId = ? AND tokenHash = ?").get(cameraId, tokenHash)) {
          throw new RevealError("REVEAL repeated a pagination token", "protocol");
        }
        // Checkpoint only after every photo on the page has committed. Tokens
        // stay private; their hashes detect cycles without an unbounded RAM set.
        db.transaction(() => {
          db.query("INSERT INTO scan_tokens(cameraId, tokenHash) VALUES (?, ?)").run(cameraId, tokenHash);
          db.query("UPDATE sync SET cursor = ?, scanPages = scanPages + 1 WHERE cameraId = ?").run(result.nextToken!, cameraId);
        })();
        paginationKey = result.nextToken;
      }
      if (!finished) {
        db.query("UPDATE sync SET nextCheckAt = ?, failures = 0, error = NULL WHERE cameraId = ?").run(this.now() + 10_000, cameraId);
        return;
      }
      if (startsAtHead && !latestReported) options.latest?.(undefined);
      db.transaction(() => {
        db.query(`UPDATE sync SET lastSuccessAt = ?, nextCheckAt = CASE WHEN requestVersion > ? THEN 0 ELSE ? END,
          fullScanAt = ?, completedVersion = ?, cursor = NULL, scanMode = NULL, failures = 0, error = NULL WHERE cameraId = ?`)
          .run(this.now(), scanVersion, this.now() + options.intervalMs, fullScan ? this.now() : previous?.fullScanAt ?? null,
            fullScan ? scanVersion : previous?.completedVersion ?? 0, cameraId);
        db.query("DELETE FROM scan_tokens WHERE cameraId = ?").run(cameraId);
      })();
    } catch (error) {
      if (options.signal?.aborted) return;
      const failures = (previous?.failures ?? 0) + 1;
      const delay = Math.max(options.intervalMs, Math.min(3_600_000, options.intervalMs * 2 ** Math.min(failures, 10)));
      // Filesystem and arbitrary transport errors can contain paths or signed URLs.
      const message = error instanceof RevealError ? error.message : "Could not save REVEAL photos; check local storage and the cloud connection";
      db.query("UPDATE sync SET nextCheckAt = ?, failures = ?, error = ? WHERE cameraId = ?").run(this.now() + delay, failures, message, cameraId);
      // An expired/rejected cursor or cycle cannot be resumed. Restart from
      // the head after backoff, keeping every photo already saved.
      if (paginationKey && error instanceof RevealError && (error.code === "protocol" || /HTTP (400|404|410)\b/u.test(error.message))) {
        db.query("UPDATE sync SET cursor = NULL, scanMode = NULL, fullScanAt = NULL WHERE cameraId = ?").run(cameraId);
      }
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.active.values());
    this.closed = true;
    this.openedDatabase = undefined;
    const db = await this.database;
    db?.close();
  }
}
