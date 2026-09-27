import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { PhotoLabels } from "../../camera-photos";
import type { RevealPhotoArchive } from "../reveal/photo-archive";

export interface PhotoLabeler { label(jpeg: Uint8Array, signal: AbortSignal): Promise<PhotoLabels>; close?(): void }
export interface FrigateStillsConfig { sshConfigPath: string; sshHost: string; container: string }

export function frigateStillsConfig(value: unknown): FrigateStillsConfig | undefined {
  if (!value || typeof value !== "object" || !("enabled" in value) || value.enabled !== true) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.sshConfigPath !== "string" || !isAbsolute(v.sshConfigPath)
    || typeof v.sshHost !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(v.sshHost)
    || typeof v.container !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(v.container)) {
    throw new Error("Invalid Frigate still-image worker configuration");
  }
  return { sshConfigPath: v.sshConfigPath, sshHost: v.sshHost, container: v.container };
}

/** Validate the wire result, including its binding to the JPEG we actually sent. */
export function parsePhotoLabels(value: unknown, jpeg: Uint8Array): PhotoLabels {
  const fail = () => { throw new Error("Invalid still-image labeling response"); };
  if (!value || typeof value !== "object") return fail();
  const v = value as PhotoLabels;
  const score = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
  const label = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length <= 200;
  if (!label(v.engine) || !label(v.model) || !/^[a-f0-9]{64}$/u.test(v.modelHash)
    || !Number.isSafeInteger(v.processedAt) || v.processedAt < 0
    || v.imageHash !== createHash("sha256").update(jpeg).digest("hex")
    || !Array.isArray(v.detections) || v.detections.length > 500) return fail();
  for (const d of v.detections) {
    if (!d || !label(d.label) || !score(d.score) || !Array.isArray(d.box) || d.box.length !== 4 || !d.box.every(score)
      || d.box[0] >= d.box[2] || d.box[1] >= d.box[3]) return fail();
  }
  const c = v.classification;
  if (c && (!label(c.label) || !score(c.score) || typeof c.taxonomy !== "string" || c.taxonomy.length > 1000
    || typeof c.uncertain !== "boolean" || !Array.isArray(c.candidates) || c.candidates.length > 10
    || c.candidates.some(candidate => !candidate || !label(candidate.label) || !score(candidate.score)))) return fail();
  // Store only declared fields, never arbitrary paths, upstream URLs or diagnostics.
  return { engine: v.engine, model: v.model, modelHash: v.modelHash, processedAt: v.processedAt, imageHash: v.imageHash,
    detections: v.detections.map(d => ({ label: d.label, score: d.score, box: [...d.box] as [number, number, number, number] })),
    ...(c ? { classification: { label: c.label, score: c.score, taxonomy: c.taxonomy, uncertain: c.uncertain,
      candidates: c.candidates.map(candidate => ({ label: candidate.label, score: candidate.score })) } } : {}),
  };
}

/** Uses the site's existing SSH identity; the worker has no published network port. */
export class FrigateStillLabeler implements PhotoLabeler {
  constructor(private readonly config: FrigateStillsConfig) {}

  async label(jpeg: Uint8Array, signal: AbortSignal): Promise<PhotoLabels> {
    signal.throwIfAborted();
    if (jpeg.length > 20 * 1024 * 1024) throw new Error("Photo exceeds labeling size limit");
    const command = `sudo -n docker exec -i ${this.config.container} python3 /app/request.py`;
    const child = Bun.spawn(["ssh", "-F", this.config.sshConfigPath, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
      "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2", this.config.sshHost, command],
    { stdin: new Blob([new Uint8Array(jpeg)]), stdout: "pipe", stderr: "ignore" });
    const abort = () => child.kill("SIGKILL");
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 200_000);
    try {
      const reader = child.stdout.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.length;
        if (length > 65_536) { abort(); throw new Error("Still-image response exceeds limit"); }
        chunks.push(chunk.value);
      }
      if (await child.exited !== 0) throw new Error("The Frigate still-image worker is unavailable");
      signal.throwIfAborted();
      return parsePhotoLabels(JSON.parse(Buffer.concat(chunks).toString("utf8")), jpeg);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (child.exitCode === null) abort();
      await child.exited;
    }
  }
}

export class RevealPhotoLabeling {
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private nextAttemptAt = 0;

  constructor(private readonly archive: RevealPhotoArchive, private readonly labeler: PhotoLabeler,
    private readonly cameraIds: () => readonly string[], private readonly now = Date.now) {
    archive.labelingEnabled = true;
  }

  check(): Promise<void> {
    return this.running ??= this.checkOnce().finally(() => { this.running = undefined; });
  }

  private async checkOnce(): Promise<void> {
    if (this.controller.signal.aborted || this.now() < this.nextAttemptAt) return;
    // One image at a time, prioritizing newly arrived photos over the backfill.
    const job = (await this.archive.pendingLabels(this.cameraIds(), 1))[0];
    if (!job) return;
    try {
      const jpeg = await this.archive.read(job.cameraId, job.id);
      if (!jpeg) throw new Error("Saved photo is unavailable");
      const result = await this.labeler.label(jpeg, this.controller.signal);
      this.controller.signal.throwIfAborted();
      await this.archive.saveLabels(job.id, result);
    } catch {
      if (this.controller.signal.aborted) return;
      await this.archive.failLabels(job.id);
      // An unavailable host should not fail every photo in the archive at once.
      this.nextAttemptAt = this.now() + 60_000;
    }
  }

  start(): void {
    if (this.timer || this.controller.signal.aborted) return;
    const tick = async () => {
      await this.check().catch(() => {});
      if (!this.controller.signal.aborted) {
        this.timer = setTimeout(tick, 1000);
        this.timer.unref();
      }
    };
    void tick();
  }

  async stop(): Promise<void> {
    this.controller.abort();
    clearTimeout(this.timer);
    await this.running;
  }
}
