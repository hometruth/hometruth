import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { RevealPhotoArchive, SavedPhotoLabels } from "../reveal/photo-archive";

export interface FrigatePhotoImportConfig {
  sshConfigPath: string; sshHost: string; container: string; cameras: Record<string, string>;
}
export function frigatePhotoImportConfig(value: unknown): FrigatePhotoImportConfig | undefined {
  if (!value || typeof value !== "object" || !("enabled" in value) || value.enabled !== true) return;
  const v = value as Record<string, unknown>;
  const name = (s: unknown): s is string => typeof s === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/u.test(s);
  if (typeof v.sshConfigPath !== "string" || !isAbsolute(v.sshConfigPath) || !name(v.sshHost) || !name(v.container)
    || !v.cameras || typeof v.cameras !== "object" || Array.isArray(v.cameras)
    || !Object.keys(v.cameras).length || Object.entries(v.cameras).some(([device, camera]) => !name(device) || !name(camera) || camera.length > 20)
    || new Set(Object.values(v.cameras)).size !== Object.values(v.cameras).length) throw new Error("Invalid Frigate photo import configuration");
  return { sshConfigPath: v.sshConfigPath, sshHost: v.sshHost, container: v.container, cameras: { ...v.cameras } as Record<string, string> };
}

export interface PhotoImportJob { photo: SavedPhotoLabels; camera: string; jpeg: Uint8Array }
export interface PhotoImportTarget { readonly key: string; import(jobs: PhotoImportJob[], signal: AbortSignal): Promise<void> }

/** Authenticated SSH only. The version-checked importer is installed in Frigate's persistent config volume. */
export class FrigatePhotoTarget implements PhotoImportTarget {
  readonly key: string;
  constructor(private readonly config: FrigatePhotoImportConfig) {
    this.key = createHash("sha256").update(JSON.stringify(["snapshot-import-v1", config.sshHost, config.container,
      Object.entries(config.cameras).sort(([a], [b]) => a.localeCompare(b))])).digest("hex");
  }
  async import(jobs: PhotoImportJob[], signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const payload = JSON.stringify({ photos: jobs.map(({ photo, camera, jpeg }) => ({ id: photo.id, camera,
      capturedAt: photo.capturedAt, uploadedAt: photo.uploadedAt, result: photo.result, jpeg: Buffer.from(jpeg).toString("base64") })) });
    if (Buffer.byteLength(payload) > 32 * 1024 * 1024) throw new Error("Photo import batch exceeds limit");
    const child = Bun.spawn(["ssh", "-F", this.config.sshConfigPath, "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
      "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2", this.config.sshHost,
      `sudo -n docker exec -i ${this.config.container} python3 /config/hometruth/import_photos.py`],
    { stdin: new Blob([payload]), stdout: "pipe", stderr: "ignore" });
    const abort = () => child.kill("SIGKILL");
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 60_000);
    try {
      const chunks: Uint8Array[] = []; let length = 0;
      for await (const chunk of child.stdout) {
        length += chunk.length;
        if (length > 32_768) { abort(); throw new Error("Photo import response exceeds limit"); }
        chunks.push(chunk);
      }
      if (await child.exited !== 0) throw new Error("Frigate photo import unavailable; queued for retry");
      signal.throwIfAborted();
      const result: unknown = JSON.parse(Buffer.concat(chunks).toString());
      const imported = result && typeof result === "object" && "imported" in result ? result.imported : undefined;
      if (!Array.isArray(imported) || imported.length !== jobs.length || jobs.some(job => !imported.includes(job.photo.id))) throw new Error("Invalid photo import acknowledgement");
    } finally {
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (child.exitCode === null) abort();
      await child.exited;
    }
  }
}

/** Independent durable delivery: Frigate downtime never blocks labeling or MQTT publication. */
export class FrigatePhotoImport {
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private failed = false;
  constructor(private readonly archive: RevealPhotoArchive, private readonly target: PhotoImportTarget,
    private readonly cameras: () => readonly { cameraId: string; camera: string }[]) {}
  check(): Promise<void> { return this.running ??= this.checkOnce().finally(() => { this.running = undefined; }); }
  private async checkOnce(): Promise<void> {
    if (this.controller.signal.aborted) return;
    try {
      const cameras = this.cameras();
      const photos = await this.archive.pendingNativePhotos(cameras.map(c => c.cameraId), this.target.key);
      if (photos.length) {
        const jobs: PhotoImportJob[] = [];
        let bytes = 0;
        for (const photo of photos) {
          const jpeg = await this.archive.read(photo.cameraId, photo.id);
          if (!jpeg) throw new Error("Saved photo unavailable");
          if (jobs.length && bytes + jpeg.length > 20 * 1024 * 1024) break;
          bytes += jpeg.length;
          jobs.push({ photo, jpeg, camera: cameras.find(c => c.cameraId === photo.cameraId)!.camera });
        }
        await this.target.import(jobs, this.controller.signal);
        for (const { photo } of jobs) await this.archive.markNativePhoto(photo.id, photo.serializedResult, this.target.key);
      }
      this.failed = false;
    } catch { this.failed = true; }
  }
  status(): { failed: boolean; detail: string } {
    const cameras = this.cameras().map(c => c.cameraId);
    const { total } = this.archive.labelCounts(cameras);
    const imported = this.archive.nativePhotoCount(cameras, this.target.key);
    return { failed: this.failed, detail: `Frigate snapshots: ${imported} of ${total} imported${this.failed ? "; import unavailable, queued for retry" : ""}` };
  }
  start(): void {
    if (this.timer || this.controller.signal.aborted) return;
    const tick = async () => {
      await this.check();
      if (!this.controller.signal.aborted) { this.timer = setTimeout(tick, this.failed ? 30_000 : 1000); this.timer.unref(); }
    };
    void tick();
  }
  async stop(): Promise<void> { this.controller.abort(); clearTimeout(this.timer); await this.running; }
}
