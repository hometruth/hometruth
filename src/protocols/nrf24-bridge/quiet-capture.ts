import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TMNT_SESSION_PLAN } from "./session-plan";

export const QUIET_PROFILES = ["esb-1000", "esb-250", "esb-2000", "xn297-1000", "xn297-250", "xn297-2000"] as const;
export type QuietProfile = typeof QUIET_PROFILES[number];
export const QUIET_DURATIONS_MS = [10000, 20000] as const;
export type QuietDurationMs = typeof QUIET_DURATIONS_MS[number];
export interface QuietCaptureSettings {
  wifiOff: boolean;
  note: string;
  profile: QuietProfile;
  channel: number | null;
  durationMs: QuietDurationMs;
  session?: typeof TMNT_SESSION_PLAN.id;
}

export interface QuietCaptureStatus {
  captureId: string;
  phase: "preparing" | "starting" | "capturing" | "reconnecting" | "complete" | "recorded" | "failed";
  path: string;
  wifiOff: boolean;
  profile: QuietProfile;
  startedAt: string;
  updatedAt: string;
  durationMs: QuietDurationMs;
  channel: number | null;
  session?: typeof TMNT_SESSION_PLAN.id;
  captureStartedAt?: string;
  elapsedMs?: number;
  packets?: number;
  rawFramesSeen?: number;
  records?: number;
  energy?: number[][];
  networkRestored?: boolean;
  error?: string;
  snapshot?: unknown;
}

export function quietIsActive(status: QuietCaptureStatus | undefined): boolean {
  return !!status && ["preparing", "starting", "capturing", "reconnecting"].includes(status.phase);
}

export function validateQuietRequest(value: unknown): QuietCaptureSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected quiet capture settings");
  const body = value as Record<string, unknown>;
  if (typeof body.wifiOff !== "boolean" || !QUIET_DURATIONS_MS.includes(body.durationMs as QuietDurationMs)
    || !(body.channel === null || (typeof body.channel === "number" && Number.isInteger(body.channel) && body.channel >= 5 && body.channel <= 75))
    || !QUIET_PROFILES.includes(body.profile as QuietProfile)
    || typeof body.note !== "string" || body.note.trim().length === 0 || body.note.length > 1000
    || (body.session !== undefined && (body.session !== TMNT_SESSION_PLAN.id || body.durationMs !== TMNT_SESSION_PLAN.durationMs
      || body.wifiOff !== true || body.channel !== 40 || body.profile !== "esb-1000"))
    || Object.keys(body).some(key => !["wifiOff", "durationMs", "note", "profile", "channel", "session"].includes(key))) {
    throw new Error("Use durationMs 10000/20000, channel 5–75 or null for sweep, wifiOff true/false, a supported receive profile, and a capture note (1–1000 characters). The tmnt-six-buttons session requires 20000 ms, channel 40, esb-1000 and Wi-Fi off.");
  }
  return { wifiOff: body.wifiOff, note: body.note.trim(), profile: body.profile as QuietProfile,
    channel: body.channel as number | null, durationMs: body.durationMs as QuietDurationMs,
    ...(body.session === TMNT_SESSION_PLAN.id ? { session: TMNT_SESSION_PLAN.id } : {}) };
}

/** A bounded per-experiment subprocess, not a service. Its own fsynced log
 * survives worker replacement; the shared status file restores the UI.
 */
export class UsbQuietCapture {
  constructor(private readonly directory: string) {}

  async status(): Promise<QuietCaptureStatus | undefined> {
    let files: string[];
    try { files = (await readdir(this.directory)).filter(name => name.endsWith(".status.json")).sort().reverse(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    for (const name of files.slice(0, 5)) {
      try {
        const path = join(this.directory, name);
        const metadata = await lstat(path);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 262144) continue;
        const value = JSON.parse(await readFile(path, "utf8"));
        if (typeof value.captureId !== "string" || !Number.isFinite(Date.parse(value.updatedAt))
          || !["preparing", "starting", "capturing", "reconnecting", "complete", "recorded", "failed"].includes(value.phase)) continue;
        if (quietIsActive(value) && Date.now() - Date.parse(value.updatedAt) > 45000) {
          return { ...value, phase: "failed", error: "USB recorder stopped reporting; retained log may be incomplete. No automatic retry." };
        }
        return value;
      } catch { /* Atomic file replacement; ignore a damaged historic status. */ }
    }
    return undefined;
  }

  async start(deviceId: string, settings: QuietCaptureSettings): Promise<QuietCaptureStatus> {
    const { wifiOff, note, profile, channel, durationMs, session } = validateQuietRequest(settings);
    if (quietIsActive(await this.status())) throw new Error("A USB capture is already active");
    const devices = (await readdir("/dev")).filter(name => /^(cu\.usbserial[-\w]*|ttyUSB\d+)$/u.test(name));
    if (devices.length !== 1) throw new Error("Connect exactly one ESP32 USB serial device to the HomeTruth computer");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const captureId = randomUUID();
    const startedAt = new Date().toISOString();
    const stem = join(this.directory, `${startedAt.replaceAll(":", "-")}-${captureId}`);
    const status: QuietCaptureStatus = { captureId, phase: "preparing", path: `${stem}.jsonl`,
      wifiOff, profile, channel, startedAt, updatedAt: startedAt, durationMs, records: 0,
      ...(session ? { session } : {}) };
    const statusPath = `${stem}.status.json`;
    const handle = await open(statusPath, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(status)); await handle.sync(); } finally { await handle.close(); }
    const directory = await open(dirname(statusPath), "r");
    try { await directory.sync(); } finally { await directory.close(); }
    const script = fileURLToPath(new URL("./quiet_capture.py", import.meta.url));
    const config = { status, statusPath, deviceId, note, port: `/dev/${devices[0]}`,
      ...(session ? { sessionPlan: TMNT_SESSION_PLAN } : {}) };
    // No shell interpolation, secrets or network credentials. A worker reload
    // does not own the child lifetime; the helper has a duration-dependent bound.
    try {
      // The supervisor kills retiring workers' entire process groups. Put this
      // finite recorder in its own group so the authorized bounded capture
      // can finish and fsync even across a web worker replacement.
      const child = Bun.spawn(["python3", script], { detached: true,
        stdin: new Blob([JSON.stringify(config) + "\n"]), stdout: "ignore", stderr: "ignore" });
      void child.exited.then(async () => {
        // Handles import/startup failures before the helper can own its status.
        const saved = JSON.parse(await readFile(statusPath, "utf8"));
        if (!quietIsActive(saved)) return;
        const handle = await open(statusPath, "w", 0o600);
        try {
          await handle.writeFile(JSON.stringify({ ...saved, phase: "failed", updatedAt: new Date().toISOString(),
            error: "USB recorder exited before completion; received records remain on disk. No retry." }));
          await handle.sync();
        } finally { await handle.close(); }
      }).catch(() => {});
    } catch (error) {
      const handle = await open(statusPath, "w", 0o600);
      try { await handle.writeFile(JSON.stringify({ ...status, phase: "failed", error: "Could not start Python 3 USB recorder" })); await handle.sync(); }
      finally { await handle.close(); }
      throw error;
    }
    return status;
  }
}
