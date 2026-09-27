import { isAbsolute } from "node:path";

export interface FrigateSnapshotsConfig { sshConfigPath: string; sshHost: string; container: string }
export interface FrigateSnapshotReader { read(camera: string, objectId: string, signal: AbortSignal): Promise<Uint8Array | undefined> }
const name = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(value);
const MAX_JPEG = 8 * 1024 * 1024;

export function frigateSnapshotsConfig(value: unknown): FrigateSnapshotsConfig | undefined {
  if (!value || typeof value !== "object" || !("enabled" in value) || value.enabled !== true) return;
  const v = value as Record<string, unknown>;
  if (typeof v.sshConfigPath !== "string" || !isAbsolute(v.sshConfigPath) || !name(v.sshHost) || !name(v.container)) {
    throw new Error("Invalid Frigate snapshot configuration");
  }
  return { sshConfigPath: v.sshConfigPath, sshHost: v.sshHost, container: v.container };
}

// One read-only request through the existing SSH connection. No listener, worker installation,
// recording download, or persistent copy. Frigate draws the box on its own selected snapshot.
const REQUEST = String.raw`
import json, sys, urllib.request, urllib.error
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None
opener = urllib.request.build_opener(NoRedirect)
def get(path, limit):
    with opener.open('http://127.0.0.1:5000/api/' + path, timeout=5) as response:
        data = response.read(limit + 1)
        if len(data) > limit:
            raise ValueError('Response too large')
        return data
try:
    request = json.load(sys.stdin)
    import re
    camera, event_id = request['camera'], request['objectId']
    if not all(isinstance(v, str) and re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}', v) for v in [camera, event_id]):
        sys.exit(4)
    # HomeTruth already verifies the camera/track pair against its event history.
    # Active tracks can have a snapshot before Frigate creates their database row.
    jpeg = get('events/' + event_id + '/snapshot.jpg?bbox=1&crop=0&timestamp=0&quality=85', 8388608)
    if not jpeg.startswith(b'\xff\xd8\xff') or not jpeg.endswith(b'\xff\xd9'):
        raise ValueError('Not a JPEG')
    sys.stdout.buffer.write(jpeg)
except urllib.error.HTTPError as error:
    sys.exit(4 if error.code == 404 else 5)
except Exception:
    sys.exit(5)
`;

/** Share simultaneous reads and briefly cache a bounded set of JPEGs in memory. */
export class FrigateSnapshots implements FrigateSnapshotReader {
  private readonly cache = new Map<string, { until: number; jpeg: Uint8Array | undefined }>();
  private readonly pending = new Map<string, Promise<Uint8Array | undefined>>();
  private bytes = 0;
  constructor(private readonly fetchSnapshot: FrigateSnapshotReader["read"], private readonly now = Date.now) {}

  async read(camera: string, objectId: string, signal: AbortSignal): Promise<Uint8Array | undefined> {
    signal.throwIfAborted();
    if (!name(camera) || !name(objectId)) return;
    const key = `${camera}/${objectId}`;
    const cached = this.cache.get(key);
    if (cached && cached.until > this.now()) return cached.jpeg;
    if (cached) { this.bytes -= cached.jpeg?.length ?? 0; this.cache.delete(key); }
    // Browser requests for repeated updates of the same object share its best frame.
    let result = this.pending.get(key);
    if (!result) {
      if (this.pending.size >= 12) throw new Error("Frigate snapshot requests are busy; retry shortly");
      result = this.fetchSnapshot(camera, objectId, AbortSignal.timeout(15_000)).then(jpeg => {
        if (jpeg && (jpeg.length > MAX_JPEG || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[2] !== 0xff
          || jpeg.at(-2) !== 0xff || jpeg.at(-1) !== 0xd9)) throw new Error("Invalid Frigate snapshot");
        while (this.cache.size && (this.cache.size >= 128 || this.bytes + (jpeg?.length ?? 0) > 16 * 1024 * 1024)) {
          const oldest = this.cache.keys().next().value!;
          this.bytes -= this.cache.get(oldest)!.jpeg?.length ?? 0; this.cache.delete(oldest);
        }
        this.cache.set(key, { until: this.now() + (jpeg ? 30_000 : 2000), jpeg });
        this.bytes += jpeg?.length ?? 0;
        return jpeg;
      }).finally(() => { this.pending.delete(key); });
      this.pending.set(key, result);
    }
    const jpeg = await result;
    signal.throwIfAborted();
    return jpeg;
  }
}

export function createFrigateSnapshots(config: FrigateSnapshotsConfig): FrigateSnapshots {
  // Revalidate even when a caller constructs a config without the configuration parser.
  const safe = frigateSnapshotsConfig({ ...config, enabled: true })!;
  const quotedScript = "'" + REQUEST.replaceAll("'", "'\\''") + "'";
  return new FrigateSnapshots(async (camera, objectId, signal) => {
    signal.throwIfAborted();
    const child = Bun.spawn(["ssh", "-F", safe.sshConfigPath, "-o", "BatchMode=yes", "-o", "ConnectTimeout=5",
      "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=1", safe.sshHost,
      `sudo -n docker exec -i ${safe.container} python3 -c ${quotedScript}`],
    { stdin: new Blob([JSON.stringify({ camera, objectId })]), stdout: "pipe", stderr: "ignore" });
    const abort = () => { try { child.kill(); } catch { /* Already exited. */ } };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const chunks: Uint8Array[] = []; let length = 0;
      for await (const chunk of child.stdout) {
        length += chunk.length;
        if (length > MAX_JPEG) { abort(); throw new Error("Invalid Frigate snapshot size"); }
        chunks.push(chunk);
      }
      const code = await child.exited;
      signal.throwIfAborted();
      if (code === 4) return;
      if (code !== 0) throw new Error("Frigate snapshot unavailable");
      return Buffer.concat(chunks);
    } finally {
      signal.removeEventListener("abort", abort);
      if (child.exitCode === null) abort();
      await child.exited;
    }
  });
}
