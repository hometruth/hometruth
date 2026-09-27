export interface ProtectRecordingsConfig {
  /** Local /protect URL or the site's UniFi cloud console /protect URL. No credentials. */
  baseUrl: string;
  /** Frigate camera name → Protect camera ID, independent of HomeTruth device names. */
  cameras: Readonly<Record<string, string>>;
  preRollSeconds: number;
}

export function protectRecordingsConfig(value: unknown): ProtectRecordingsConfig | undefined {
  if (value === undefined) return;
  const fail = (): never => { throw new Error("Invalid Protect recording link configuration"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const v = value as Record<string, unknown>;
  if (typeof v.baseUrl !== "string" || v.baseUrl.length > 1800) return fail();
  let url: URL;
  try { url = new URL(v.baseUrl); } catch { return fail(); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || !/^\/(?:consoles\/[a-zA-Z0-9:_-]+\/)?protect\/?$/u.test(url.pathname)) return fail();
  const cameras = v.cameras;
  if (!cameras || typeof cameras !== "object" || Array.isArray(cameras)
    || Object.entries(cameras).some(([name, id]) => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(name)
      || typeof id !== "string" || !/^[a-f0-9]{24}$/u.test(id))) return fail();
  const preRollSeconds = v.preRollSeconds ?? 5;
  if (typeof preRollSeconds !== "number" || !Number.isFinite(preRollSeconds) || preRollSeconds < 0 || preRollSeconds > 60) return fail();
  return { baseUrl: url.href.replace(/\/$/u, ""), cameras: { ...cameras } as Record<string, string>, preRollSeconds };
}

/** Frigate timestamps are seconds; Protect's playback `start` parameter is milliseconds. */
export function protectRecordingLink(config: ProtectRecordingsConfig | undefined, camera: string, frameTime: unknown): {
  recordingUrl: string; recordingStartTime: number;
} | undefined {
  if (!config || !Object.hasOwn(config.cameras, camera) || typeof frameTime !== "number" || !Number.isFinite(frameTime)
    || frameTime < 0 || frameTime >= 100_000_000_000) return;
  const recordingStartTime = Math.max(0, Math.floor((frameTime - config.preRollSeconds) * 1000));
  const url = new URL(`${config.baseUrl}/timelapse/${config.cameras[camera]}`);
  url.searchParams.set("start", String(recordingStartTime));
  return { recordingUrl: url.href, recordingStartTime };
}
