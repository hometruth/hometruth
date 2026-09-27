export interface DetectionPreview {
  frames: { time: number; image: string }[];
  playbackRate: 5;
}
export interface DetectionPreviewReader {
  read(camera: string, frameTime: number, signal: AbortSignal): Promise<DetectionPreview | undefined>;
  /** One recorded frame at a moment, for a detection whose best frame is from another time of the track. */
  still(camera: string, frameTime: number, signal: AbortSignal): Promise<Uint8Array | undefined>;
}
export class PreviewAccessError extends Error {}

/** Ten small historical stills, requested only while somebody wants to preview an event. */
export class DetectionPreviews implements DetectionPreviewReader {
  private readonly cache = new Map<string, { until: number; value: DetectionPreview | undefined; bytes: number }>();
  private readonly pending = new Map<string, { controller: AbortController; users: number; promise: Promise<DetectionPreview | undefined> }>();
  private bytes = 0;
  constructor(private readonly frame: (camera: string, time: number, signal: AbortSignal) => Promise<Uint8Array | undefined>,
    private readonly now = Date.now) {}

  async read(camera: string, frameTime: number, signal: AbortSignal): Promise<DetectionPreview | undefined> {
    signal.throwIfAborted();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(camera) || !Number.isFinite(frameTime) || frameTime < 0) return;
    const start = Math.max(0, Math.floor(frameTime) - 2);
    const key = `${camera}/${start}`;
    const cached = this.cache.get(key);
    if (cached && cached.until > this.now()) return cached.value;
    if (cached) { this.bytes -= cached.bytes; this.cache.delete(key); }
    let work = this.pending.get(key);
    if (!work) {
      if (this.pending.size >= 2) throw new Error("Preview requests are busy");
      const controller = new AbortController();
      const upstream = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
      const promise = this.collect(camera, start, upstream).then(value => {
        const bytes = (JSON.stringify(value)?.length ?? 0) * 2;
        while (this.cache.size && (this.cache.size >= 32 || this.bytes + bytes > 24 * 1024 * 1024)) {
          const oldest = this.cache.keys().next().value!;
          this.bytes -= this.cache.get(oldest)!.bytes; this.cache.delete(oldest);
        }
        // A fresh event or missing recording may acquire more frames shortly.
        this.cache.set(key, { value, bytes, until: this.now() + (value?.frames.length === 10 ? 300_000 : 5000) });
        this.bytes += bytes;
        return value;
      }).finally(() => { if (this.pending.get(key)?.controller === controller) this.pending.delete(key); });
      work = { controller, users: 0, promise };
      this.pending.set(key, work);
    }
    work.users++;
    const current = work;
    let abort: () => void = () => {};
    try {
      return await Promise.race([current.promise, new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      })]);
    } finally {
      signal.removeEventListener("abort", abort);
      if (--current.users === 0 && this.pending.get(key) === current) {
        this.pending.delete(key); current.controller.abort();
      }
    }
  }

  async still(camera: string, frameTime: number, signal: AbortSignal): Promise<Uint8Array | undefined> {
    signal.throwIfAborted();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(camera) || !Number.isFinite(frameTime) || frameTime < 0) return;
    const jpeg = await this.frame(camera, Math.floor(frameTime), AbortSignal.any([signal, AbortSignal.timeout(15_000)]));
    if (jpeg && (jpeg.length > 256 * 1024 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[2] !== 0xff
      || jpeg.at(-2) !== 0xff || jpeg.at(-1) !== 0xd9)) throw new Error("Invalid preview frame");
    return jpeg;
  }

  private async collect(camera: string, start: number, signal: AbortSignal): Promise<DetectionPreview | undefined> {
    const frames: DetectionPreview["frames"] = [];
    // Sequential reads bound load on the recorder; no video download or permanent thumbnail archive.
    for (let time = start; time < start + 10 && time * 1000 <= this.now() - 2000; time++) {
      signal.throwIfAborted();
      const jpeg = await this.frame(camera, time, signal);
      if (!jpeg) continue;
      if (jpeg.length > 256 * 1024 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[2] !== 0xff
        || jpeg.at(-2) !== 0xff || jpeg.at(-1) !== 0xd9) throw new Error("Invalid preview frame");
      frames.push({ time, image: `data:image/jpeg;base64,${Buffer.from(jpeg).toString("base64")}` });
    }
    signal.throwIfAborted();
    return frames.length >= 2 ? { frames, playbackRate: 5 } : undefined;
  }
}
