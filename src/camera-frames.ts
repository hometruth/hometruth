import { CameraMediaError, cameraUriWithCredentials, createMjpegStreamResponse, type CameraMediaSource } from "./camera-media";

const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** ffmpeg's multipart output may split headers or JPEGs across arbitrary pipe reads. */
export class MjpegFrameParser {
  private pending = Buffer.alloc(0);
  private length: number | undefined;
  push(chunk: Uint8Array): Uint8Array[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const frames: Uint8Array[] = [];
    while (true) {
      if (this.length === undefined) {
        const end = this.pending.indexOf("\r\n\r\n");
        if (end < 0) {
          if (this.pending.length > MAX_FRAME_BYTES) throw new Error("Invalid camera frame headers");
          break;
        }
        const header = this.pending.subarray(0, end).toString("ascii");
        this.pending = this.pending.subarray(end + 4);
        const match = /(?:^|\r\n)Content-Length:\s*(\d+)\s*(?:\r\n|$)/i.exec(header);
        if (!match) continue; // A subscriber may join in the middle of a frame.
        this.length = Number(match[1]);
        if (this.length < 4 || this.length > MAX_FRAME_BYTES) throw new Error("Invalid camera frame size");
      }
      if (this.pending.length < this.length) break;
      const bytes = this.pending.subarray(0, this.length);
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw new Error("Invalid camera JPEG");
      frames.push(new Uint8Array(bytes));
      this.pending = this.pending.subarray(this.length);
      this.length = undefined;
    }
    return frames;
  }
}

export interface CameraFrame { bytes: Uint8Array; at: number }

type Connection = {
  uri: string;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  latest?: CameraFrame;
  waiters: Set<{ resolve(frame: CameraFrame): void; reject(error: Error): void }>;
};

/** Continuously drains one shared stream, retaining only its newest complete frame. */
export class LatestCameraFrames {
  private connection: Connection | undefined;
  private idle?: ReturnType<typeof setTimeout>;
  constructor(private readonly options: {
    open?: (source: CameraMediaSource) => Response;
    now?: () => number;
    maxAgeMs?: number;
    timeoutMs?: number;
    idleMs?: number;
  } = {}) {}

  async snapshot(source: CameraMediaSource, signal: AbortSignal): Promise<CameraFrame> {
    signal.throwIfAborted();
    if (!source.streamUri) throw new CameraMediaError("A camera stream is required", "unavailable");
    const uri = cameraUriWithCredentials(source.streamUri, source.username, source.password);
    if (this.connection?.uri !== uri) {
      this.stop();
      const response = this.options.open ? this.options.open(source) : createMjpegStreamResponse(source, undefined, "analysis");
      if (!response.ok || !response.body) throw new CameraMediaError("Camera stream is unavailable", "unavailable");
      const connection: Connection = { uri, reader: response.body.getReader(), waiters: new Set() };
      this.connection = connection;
      void this.pump(connection);
    }
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stop(), this.options.idleMs ?? 90_000);
    this.idle.unref();
    const connection = this.connection!;
    if (connection.latest && this.now() - connection.latest.at <= (this.options.maxAgeMs ?? 1_500)) {
      const frame = connection.latest;
      delete connection.latest; // Never submit the same captured frame twice.
      return frame;
    }
    return new Promise<CameraFrame>((resolve, reject) => {
      const abort = () => this.close(connection, new CameraMediaError("Camera check cancelled", "unavailable"));
      const timeout = setTimeout(() => this.close(connection, new CameraMediaError("No fresh camera frame arrived", "unavailable")), this.options.timeoutMs ?? 10_000);
      const cleanup = () => { clearTimeout(timeout); signal.removeEventListener("abort", abort); };
      signal.addEventListener("abort", abort, { once: true });
      connection.waiters.add({
        resolve: frame => { cleanup(); resolve(frame); },
        reject: error => { cleanup(); reject(error); },
      });
      if (signal.aborted) abort();
    });
  }

  private now() { return (this.options.now ?? Date.now)(); }

  private async pump(connection: Connection): Promise<void> {
    const parser = new MjpegFrameParser();
    try {
      while (this.connection === connection) {
        const chunk = await connection.reader.read();
        if (chunk.done) break;
        for (const bytes of parser.push(chunk.value)) {
          if (this.connection !== connection) return;
          connection.latest = { bytes, at: this.now() };
          for (const waiter of connection.waiters) waiter.resolve(connection.latest);
          if (connection.waiters.size) delete connection.latest;
          connection.waiters.clear();
        }
      }
    } catch { /* Do not expose a stream URL or its credentials in errors. */ }
    finally { this.close(connection, new CameraMediaError("Camera stream disconnected", "unavailable")); }
  }

  private close(connection: Connection, error: Error): void {
    if (this.connection === connection) {
      this.connection = undefined;
      clearTimeout(this.idle);
    }
    delete connection.latest;
    for (const waiter of connection.waiters) waiter.reject(error);
    connection.waiters.clear();
    void connection.reader.cancel().catch(() => undefined);
  }

  stop(): void {
    clearTimeout(this.idle);
    if (this.connection) this.close(this.connection, new CameraMediaError("Camera stream stopped", "unavailable"));
  }
}
