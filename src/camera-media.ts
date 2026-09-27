import type { CameraPhotoHistory } from "./camera-photos";

export interface CameraMediaSource {
  streamUri?: string;
  snapshotUri?: string;
  username?: string;
  password?: string;
  /** Vendor-owned JPEG retrieval (for example, the latest cellular cloud photo). */
  captureSnapshot?: () => Promise<Uint8Array>;
  photos?: CameraPhotoHistory;
}

export interface CameraPlaybackFrame {
  readonly kind: "video" | "audio" | "metadata";
  readonly codec:
    | "h264"
    | "h265"
    | "aac"
    | "pcm_mulaw"
    | "pcm_alaw"
    | "pcm_s16le"
    | "unknown";
  readonly keyFrame: boolean;
  readonly timestamp: bigint;
  readonly payload: Uint8Array;
}

export interface CameraPlayback {
  start(timestamp: string): Promise<ReadableStream<CameraPlaybackFrame>>;
  pause(): Promise<void> | void;
  resume(): Promise<void> | void;
  seek(timestamp: string): Promise<void> | void;
  stop(): Promise<void>;
  close?(): Promise<void> | void;
}

export class CameraMediaError extends Error {
  constructor(message: string, readonly code: "unavailable" | "invalid_uri" | "ffmpeg_failed") {
    super(message);
    this.name = "CameraMediaError";
  }
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [first = -1, second = -1] = parts;
  return first === 10
    || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

export function isSafeCameraUri(value: string): boolean {
  try {
    const uri = new URL(value);
    if (!["rtsp:", "rtsps:", "http:", "https:"].includes(uri.protocol)) return false;
    const host = uri.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host === "::1" || host.endsWith(".local") || isPrivateIpv4(host);
  } catch {
    return false;
  }
}

export function cameraUriWithCredentials(uri: string, username?: string, password?: string): string {
  if (!isSafeCameraUri(uri)) {
    throw new CameraMediaError("The camera media address is not on the local network", "invalid_uri");
  }
  if (!username) return uri;
  const parsed = new URL(uri);
  parsed.username = username;
  parsed.password = password ?? "";
  return parsed.toString();
}

/**
 * Prefer the camera's advertised still-image endpoint, then fall back to its
 * RTSP stream. Some Meari/TKENPRO firmware advertises an ONVIF snapshot URI
 * that consistently fails even though the corresponding RTSP profile works.
 */
export function cameraSnapshotCandidates(source: CameraMediaSource): string[] {
  return [...new Set([source.snapshotUri, source.streamUri].filter((uri): uri is string => Boolean(uri)))];
}

function ffmpegInputArgs(uri: string): string[] {
  return uri.startsWith("rtsp:") || uri.startsWith("rtsps:")
    ? ["-rtsp_transport", "tcp", "-i", uri]
    : ["-i", uri];
}

async function quietlyDrain(stream: ReadableStream<Uint8Array> | number | undefined): Promise<void> {
  if (!(stream instanceof ReadableStream)) return;
  try {
    await new Response(stream).arrayBuffer();
  } catch {
    // The process may be terminated when the viewer disconnects.
  }
}

function processStream(
  subprocess: ReturnType<typeof Bun.spawn>,
  signal?: AbortSignal,
  onStop?: () => void,
): ReadableStream<Uint8Array> {
  if (!(subprocess.stdout instanceof ReadableStream)) {
    subprocess.kill();
    throw new CameraMediaError("ffmpeg did not provide a video stream", "ffmpeg_failed");
  }

  const reader = subprocess.stdout.getReader();
  const stop = () => {
    subprocess.kill();
    onStop?.();
  };
  signal?.addEventListener("abort", stop, { once: true });
  void quietlyDrain(subprocess.stderr);

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          signal?.removeEventListener("abort", stop);
          onStop?.();
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        onStop?.();
        controller.error(error);
      }
    },
    cancel() {
      signal?.removeEventListener("abort", stop);
      subprocess.kill();
      void reader.cancel();
    },
  });
}

export function playbackVideoInputFormat(codec: CameraPlaybackFrame["codec"]): "h264" | "hevc" {
  if (codec === "h264") return "h264";
  if (codec === "h265") return "hevc";
  throw new CameraMediaError(`Unsupported playback video codec: ${codec}`, "unavailable");
}

async function firstPlaybackVideoFrame(
  reader: ReadableStreamDefaultReader<CameraPlaybackFrame>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<CameraPlaybackFrame> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const interruption = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new CameraMediaError(
      "No recorded video arrived for that time",
      "unavailable",
    )), timeoutMs);
    if (signal) {
      abort = () => reject(new CameraMediaError("Playback request was closed", "unavailable"));
      signal.addEventListener("abort", abort, { once: true });
    }
  });
  try {
    while (true) {
      const result = await Promise.race([reader.read(), interruption]);
      if (result.done) {
        throw new CameraMediaError("The camera returned no recording for that time", "unavailable");
      }
      const frame = result.value;
      if (
        frame.kind === "video"
        && frame.keyFrame
        && (frame.codec === "h264" || frame.codec === "h265")
      ) return frame;
    }
  } finally {
    if (timeout) clearTimeout(timeout);
    if (signal && abort) signal.removeEventListener("abort", abort);
  }
}

/** Convert direct channel-2 H.264/H.265 playback into browser-safe MJPEG. */
export async function createPlaybackMjpegStreamResponse(
  frames: ReadableStream<CameraPlaybackFrame>,
  signal?: AbortSignal,
  onStop?: () => Promise<void> | void,
  firstFrameTimeoutMs = 15_000,
): Promise<Response> {
  const reader = frames.getReader();
  let first: CameraPlaybackFrame;
  try {
    first = await firstPlaybackVideoFrame(reader, signal, firstFrameTimeoutMs);
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    await onStop?.();
    throw error;
  }
  const inputFormat = playbackVideoInputFormat(first.codec);
  const subprocess = Bun.spawn([
    "ffmpeg",
    "-hide_banner",
    "-loglevel",
    "error",
    "-fflags",
    "nobuffer",
    "-flags",
    "low_delay",
    "-f",
    inputFormat,
    "-i",
    "pipe:0",
    "-an",
    "-vf",
    "fps=8,scale=min(1280\\,iw):-2",
    "-q:v",
    "5",
    "-f",
    "mpjpeg",
    "pipe:1",
  ], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const sink = subprocess.stdin;
  if (!sink || typeof sink === "number") {
    subprocess.kill();
    await reader.cancel().catch(() => undefined);
    await onStop?.();
    throw new CameraMediaError("ffmpeg did not accept recorded video", "ffmpeg_failed");
  }

  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    signal?.removeEventListener("abort", stop);
    subprocess.kill();
    void reader.cancel().catch(() => undefined);
    void onStop?.();
  };
  signal?.addEventListener("abort", stop, { once: true });
  void quietlyDrain(subprocess.stderr);
  void (async () => {
    try {
      sink.write(first.payload);
      while (!stopped) {
        const result = await reader.read();
        if (result.done) break;
        if (
          result.value.kind === "video"
          && result.value.codec === first.codec
        ) sink.write(result.value.payload);
      }
      await sink.flush();
    } catch {
      stop();
    } finally {
      try { sink.end(); } catch { /* Process already stopped. */ }
    }
  })();
  void subprocess.exited.then(stop, stop);

  return new Response(processStream(subprocess, signal, stop), {
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "Content-Type": "multipart/x-mixed-replace; boundary=ffmpeg",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

const HARD_KILL_GRACE_MS = 2_000;

function killSubprocess(subprocess: ReturnType<typeof Bun.spawn>): void {
  subprocess.kill();
  const timeout = setTimeout(() => {
    try { subprocess.kill("SIGKILL"); } catch { /* Already exited. */ }
  }, HARD_KILL_GRACE_MS);
  void subprocess.exited.finally(() => clearTimeout(timeout));
}

/**
 * Most consumer RTSP cameras (including this Pet 3T) only accept one client
 * at a time, so a second ffmpeg process opening the same RTSP URI knocks the
 * first one off. Reloading a tab, opening a second tab, or a slow-to-abort
 * request can all otherwise pile up competing connections. Live viewers of
 * the same camera instead share a single upstream ffmpeg process, keyed by
 * its fully-resolved URI; the process is torn down once the last subscriber
 * leaves or ffmpeg itself exits.
 */
class SharedMjpegBroadcast {
  private readonly subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private ended = false;

  constructor(private readonly subprocess: ReturnType<typeof Bun.spawn>) {
    if (!(subprocess.stdout instanceof ReadableStream)) {
      killSubprocess(subprocess);
      throw new CameraMediaError("ffmpeg did not provide a video stream", "ffmpeg_failed");
    }
    void quietlyDrain(subprocess.stderr);
    void this.pump(subprocess.stdout);
  }

  private async pump(stdout: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stdout.getReader();
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        for (const controller of this.subscribers) {
          try { controller.enqueue(result.value); } catch { /* Subscriber already closed. */ }
        }
      }
    } catch {
      // ffmpeg's pipe broke; subscribers are closed below either way.
    } finally {
      this.end();
    }
  }

  private end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const controller of this.subscribers) {
      try { controller.close(); } catch { /* Already closed. */ }
    }
    this.subscribers.clear();
    onBroadcastEnded(this);
    killSubprocess(this.subprocess);
  }

  subscribe(): ReadableStream<Uint8Array> {
    let subscribed: ReadableStreamDefaultController<Uint8Array> | undefined;
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        if (this.ended) {
          controller.close();
          return;
        }
        subscribed = controller;
        this.subscribers.add(controller);
      },
      cancel: () => {
        if (subscribed) this.unsubscribe(subscribed);
      },
    });
  }

  private unsubscribe(controller: ReadableStreamDefaultController<Uint8Array>): void {
    this.subscribers.delete(controller);
    if (this.subscribers.size === 0) this.end();
  }
}

const activeMjpegBroadcasts = new Map<string, SharedMjpegBroadcast>();

function onBroadcastEnded(broadcast: SharedMjpegBroadcast): void {
  for (const [key, value] of activeMjpegBroadcasts) {
    if (value === broadcast) activeMjpegBroadcasts.delete(key);
  }
}

export type MjpegQuality = "preview" | "original" | "analysis";

export function mjpegOutputArgs(quality: MjpegQuality = "preview"): string[] {
  return ["-vf", quality === "analysis" ? "fps=1,scale=min(1280\\,iw):-2" : quality === "original" ? "fps=8" : "fps=8,scale=min(1280\\,iw):-2",
    "-q:v", quality === "original" ? "1" : "5", "-f", "mpjpeg", "pipe:1"];
}

export function createMjpegStreamResponse(source: CameraMediaSource, signal?: AbortSignal, quality: MjpegQuality = "preview"): Response {
  if (!source.streamUri) {
    throw new CameraMediaError("This camera has no local RTSP stream yet", "unavailable");
  }
  const uri = cameraUriWithCredentials(source.streamUri, source.username, source.password);

  const key = `${quality}:${uri}`;
  let broadcast = activeMjpegBroadcasts.get(key);
  if (!broadcast) {
    const subprocess = Bun.spawn([
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      ...ffmpegInputArgs(uri),
      "-an",
      ...mjpegOutputArgs(quality),
    ], { stdout: "pipe", stderr: "pipe" });
    broadcast = new SharedMjpegBroadcast(subprocess);
    activeMjpegBroadcasts.set(key, broadcast);
  }

  const stream = broadcast.subscribe();
  const reader = stream.getReader();
  const output = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const result = await reader.read();
      if (result.done) { controller.close(); return; }
      controller.enqueue(result.value);
    },
    cancel() { void reader.cancel(); },
  });
  signal?.addEventListener("abort", () => void reader.cancel(), { once: true });

  return new Response(output, {
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "Content-Type": "multipart/x-mixed-replace; boundary=ffmpeg",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * Stream the camera microphone in a format web browsers can play directly.
 * Meari's local profiles expose G.711 µ-law, so only the audio codec is
 * converted; the source connection remains entirely on the local network.
 */
export function createCameraAudioStreamResponse(
  source: CameraMediaSource,
  signal?: AbortSignal,
): Response {
  if (!source.streamUri) {
    throw new CameraMediaError("This camera has no local RTSP audio stream yet", "unavailable");
  }
  const uri = cameraUriWithCredentials(source.streamUri, source.username, source.password);
  const subprocess = Bun.spawn([
    "ffmpeg",
    "-hide_banner",
    "-loglevel",
    "error",
    "-fflags",
    "nobuffer",
    "-flags",
    "low_delay",
    ...ffmpegInputArgs(uri),
    "-map",
    "0:a:0",
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "32k",
    "-flush_packets",
    "1",
    "-f",
    "mp3",
    "pipe:1",
  ], { stdout: "pipe", stderr: "pipe" });

  return new Response(processStream(subprocess, signal), {
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "Content-Type": "audio/mpeg",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function captureSnapshotFromUri(
  source: CameraMediaSource,
  sourceUri: string,
  timeoutMs = 10_000,
  lowLatency = false,
): Promise<Uint8Array> {
  const uri = cameraUriWithCredentials(sourceUri, source.username, source.password);
  const subprocess = Bun.spawn([
    "ffmpeg",
    "-hide_banner",
    "-loglevel",
    "error",
    ...(lowLatency && /^rtsps?:/u.test(uri) ? ["-analyzeduration", "100000", "-probesize", "32768", "-fpsprobesize", "0"] : []),
    ...ffmpegInputArgs(uri),
    "-frames:v",
    "1",
    "-q:v",
    "3",
    "-f",
    "image2pipe",
    "-c:v",
    "mjpeg",
    "pipe:1",
  ], { stdout: "pipe", stderr: "pipe" });

  if (!(subprocess.stdout instanceof ReadableStream)) {
    subprocess.kill();
    throw new CameraMediaError("ffmpeg did not provide a snapshot", "ffmpeg_failed");
  }

  const timeout = setTimeout(() => subprocess.kill(), timeoutMs);
  const stderrPromise = subprocess.stderr instanceof ReadableStream
    ? new Response(subprocess.stderr).text().catch(() => "")
    : Promise.resolve("");
  try {
    const bytes = new Uint8Array(await new Response(subprocess.stdout).arrayBuffer());
    const exitCode = await subprocess.exited;
    const stderr = await stderrPromise;
    if (exitCode !== 0 || bytes.byteLength === 0) {
      throw new CameraMediaError(
        stderr.trim() || "The camera did not return a snapshot",
        "ffmpeg_failed",
      );
    }
    return bytes;
  } finally {
    clearTimeout(timeout);
  }
}

export async function captureCameraSnapshot(
  source: CameraMediaSource,
  timeoutMs = 10_000,
  options: { lowLatency?: boolean } = {},
): Promise<Uint8Array> {
  if (source.captureSnapshot) return await source.captureSnapshot();
  const candidates = cameraSnapshotCandidates(source);
  if (candidates.length === 0) {
    throw new CameraMediaError("This camera has no local snapshot or RTSP source yet", "unavailable");
  }

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return await captureSnapshotFromUri(source, candidate, timeoutMs, options.lowLatency);
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError instanceof CameraMediaError) throw lastError;
  throw new CameraMediaError("The camera did not return a snapshot", "ffmpeg_failed");
}
