import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Nrf24ListenerState } from "./client";

export const RADIO_CAPTURE_DIRECTORY = "research/tmnt-pizza-blaster-rc/captures/live";

export interface Nrf24CaptureStatus {
  readonly path: string;
  readonly lastWriteAt?: string;
  readonly lastStateAt?: string;
  readonly records: number;
  readonly error?: string;
}
export interface Nrf24CaptureJournal {
  append(event: Record<string, unknown>): Promise<void>;
  snapshot(state: Nrf24ListenerState): Promise<void>;
  status(): Nrf24CaptureStatus;
  lastSnapshot(): { recordedAt: string; state: Nrf24ListenerState } | undefined;
}

/** A recording failure is not a radio failure and must never cause a POST retry. */
export class Nrf24RecordingError extends Error {
  constructor() { super("Radio capture could not be saved to disk; check the capture log directory and free space"); }
}

/** Append-only, fsynced JSONL plus atomic per-collector snapshots for offline display.
 * Each process owns a unique file, including during supervisor handovers.
 * Old logs are never truncated or automatically deleted.
 */
export class FileNrf24CaptureJournal implements Nrf24CaptureJournal {
  readonly directory: string;
  readonly path: string;
  private readonly snapshotPath: string;
  private readonly collectorId = randomUUID();
  private queue = Promise.resolve();
  private ready = false;
  private records = 0;
  private lastWriteAt: string | undefined;
  private failure: string | undefined;
  private latest: { recordedAt: string; state: Nrf24ListenerState } | undefined;
  private snapshotFingerprint: string | undefined;

  constructor(private readonly deviceId: string, private readonly baseUrl: string, directory = RADIO_CAPTURE_DIRECTORY) {
    // Encode every unsafe byte; never use a user-supplied id as a path component.
    this.directory = resolve(directory, `device-${encodeURIComponent(deviceId).replaceAll(".", "%2E")}`);
    const stem = `${new Date().toISOString().replaceAll(":", "-")}-${this.collectorId}`;
    this.path = join(this.directory, `${stem}.jsonl`);
    this.snapshotPath = join(this.directory, `${stem}.snapshot.json`);
  }

  status(): Nrf24CaptureStatus {
    return { path: this.path, records: this.records,
      ...(this.lastWriteAt ? { lastWriteAt: this.lastWriteAt } : {}),
      ...(this.latest ? { lastStateAt: this.latest.recordedAt } : {}),
      ...(this.failure ? { error: this.failure } : {}) };
  }
  lastSnapshot() { return this.latest; }

  private exclusive(work: () => Promise<void>): Promise<void> {
    const result = this.queue.then(work).then(() => { this.failure = undefined; }).catch(() => {
      this.failure = new Nrf24RecordingError().message;
      throw new Nrf24RecordingError();
    });
    this.queue = result.catch(() => {});
    return result;
  }

  private async prepare() {
    if (this.ready) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Unsafe capture directory");
    // Only the newest bounded snapshot files are needed, never scan large JSONL logs.
    const files = (await readdir(this.directory)).filter(name => name.endsWith(".snapshot.json")).sort().reverse().slice(0, 10);
    for (const file of files) {
      try {
        const path = join(this.directory, file);
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 262144) continue;
        const saved = JSON.parse(await readFile(path, "utf8"));
        if (saved.version !== 1 || saved.deviceId !== this.deviceId || saved.baseUrl !== this.baseUrl
          || typeof saved.recordedAt !== "string" || !Number.isFinite(Date.parse(saved.recordedAt))) continue;
        // Use the same validator as live input; disk is not a trusted API contract.
        const { decodeNrf24ListenerState } = await import("./client");
        const state = decodeNrf24ListenerState(saved.state);
        if (!this.latest || saved.recordedAt > this.latest.recordedAt) this.latest = { recordedAt: saved.recordedAt, state };
      } catch { /* A damaged snapshot never deletes or prevents new append-only recording. */ }
    }
    await this.writeRecord({ event: "collector_started", runtime: process.version, processId: process.pid,
      scope: "Bridge HTTP requests, complete or partial responses, decoded snapshots, and errors. Raw RF frames not exposed by firmware cannot be archived." });
    this.ready = true;
  }

  private async writeRecord(event: Record<string, unknown>) {
    const recordedAt = new Date().toISOString();
    const handle = await open(this.path, "a", 0o600);
    try {
      // A leading separator isolates a partial previous line after a process/disk failure.
      await handle.writeFile(`\n${JSON.stringify({ ...event, version: 1, recordedAt,
        deviceId: this.deviceId, baseUrl: this.baseUrl, collectorId: this.collectorId, recordNumber: this.records + 1 })}\n`);
      await handle.sync();
    } finally { await handle.close(); }
    if (this.records === 0) {
      const directory = await open(this.directory, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
    this.lastWriteAt = recordedAt;
    this.records++;
  }

  append(event: Record<string, unknown>): Promise<void> {
    return this.exclusive(async () => { await this.prepare(); await this.writeRecord(event); });
  }

  snapshot(state: Nrf24ListenerState): Promise<void> {
    return this.exclusive(async () => {
      await this.prepare();
      const fingerprint = JSON.stringify(state);
      // Idle polling still logs reachability, but does not rewrite an identical
      // packet history thousands of times per day.
      if (fingerprint === this.snapshotFingerprint) return;
      const recordedAt = new Date().toISOString();
      // The append log is authoritative, including if the snapshot rename fails.
      await this.writeRecord({ event: "listener_snapshot", state });
      const temporary = `${this.snapshotPath}.${randomUUID()}.tmp`;
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ version: 1, deviceId: this.deviceId, baseUrl: this.baseUrl, recordedAt, state })}\n`);
        await handle.sync();
      } finally { await handle.close(); }
      await rename(temporary, this.snapshotPath);
      // Make the new directory entry durable as well as the file contents.
      const directory = await open(this.directory, "r");
      try { await directory.sync(); } finally { await directory.close(); }
      this.latest = { recordedAt, state };
      this.snapshotFingerprint = fingerprint;
    });
  }
}
