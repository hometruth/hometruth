/**
 * The camera-to-light sync engine: reads a camera's RTSP stream, samples the
 * average color inside its saved region on every decoded frame, and streams
 * that color to a set of Hue Entertainment channels in real time.
 *
 * ffmpeg does the decode + downscale in one step (`-vf scale=WxH`) so each
 * frame arrives already at the region mask's resolution — no resampling on
 * our side, matching `averageColorInRegion`'s exact-size contract.
 */
import { cameraUriWithCredentials, type CameraMediaSource } from "../camera-media";
import type { HueEntertainmentSession } from "../vendors/hue/entertainment-session";
import { gradeColor, type ColorGradeOptions } from "./color-grade";
import { ColorSmoother, type ColorSmootherOptions } from "./color-smoother";
import { rasterizeRegion, type SourceRegion } from "./region";
import { averageColorInRegion, type RgbColor } from "./sample";

export interface LiveSyncChannel {
  readonly channel: number;
}

export interface LiveSyncOptions {
  readonly source: CameraMediaSource;
  readonly region: SourceRegion;
  readonly session: HueEntertainmentSession;
  readonly channels: readonly LiveSyncChannel[];
  /** Frame width/height ffmpeg decodes to; also the region mask's resolution. Small on purpose (this is a color average, not a picture). */
  readonly width?: number;
  readonly height?: number;
  /** Target decode rate; the Wyze's own encoder and network are the real ceiling. */
  readonly fps?: number;
  /** Saturation/value/gamma correction applied to every raw sample before smoothing — see `color-grade.ts`. Pass `{}` to disable (identity). */
  readonly grade?: ColorGradeOptions;
  /** Temporal easing so the light moves toward each new sample instead of snapping to it — see `color-smoother.ts`. The lights update on this timer, not the camera's own frame rate. */
  readonly smoothing?: Pick<ColorSmootherOptions, "timeConstantMs" | "tickMs">;
  /** Called with each raw sampled color (before grading/smoothing) — lets a caller log/inspect what the camera actually saw. */
  readonly onFrame?: (color: RgbColor) => void;
  /** Called with each color actually sent to the lights, after grading and smoothing. */
  readonly onOutput?: (color: RgbColor) => void;
  readonly onError?: (error: Error) => void;
}

const DEFAULT_WIDTH = 64;
const DEFAULT_HEIGHT = 36;
const DEFAULT_FPS = 15;

export type LiveSyncErrorCode = "ffmpeg_failed" | "empty_region";

export class LiveSyncError extends Error {
  constructor(message: string, readonly code: LiveSyncErrorCode) {
    super(message);
    this.name = "LiveSyncError";
  }
}

/** A running camera-to-light sync; `stop()` tears down ffmpeg and disconnects the Hue session. */
export interface LiveSyncHandle {
  stop(): Promise<void>;
  readonly framesSampled: () => number;
}

/**
 * Starts streaming: connects the Hue Entertainment session, spawns ffmpeg
 * against the camera's RTSP stream, and forwards each decoded frame's
 * region-average color to every given channel. Runs until `stop()` is
 * called or ffmpeg exits (camera unreachable, stream dropped).
 */
export async function startLiveSync(options: LiveSyncOptions): Promise<LiveSyncHandle> {
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const fps = options.fps ?? DEFAULT_FPS;
  const mask = rasterizeRegion(options.region, width, height);
  if (mask.pixelCount === 0) {
    throw new LiveSyncError("The saved region covers no pixels at this sample resolution", "empty_region");
  }

  if (!options.source.streamUri) {
    throw new LiveSyncError("This camera has no stream URI to read", "ffmpeg_failed");
  }
  const uri = cameraUriWithCredentials(options.source.streamUri, options.source.username, options.source.password);

  await options.session.connect();

  const subprocess = Bun.spawn(
    [
      "ffmpeg",
      "-hide_banner", "-loglevel", "error",
      "-fflags", "nobuffer", "-flags", "low_delay",
      "-rtsp_transport", "tcp",
      "-i", uri,
      "-an",
      "-vf", `fps=${fps},scale=${width}:${height}`,
      "-f", "rawvideo", "-pix_fmt", "rgb24",
      "pipe:1",
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );

  if (!(subprocess.stdout instanceof ReadableStream)) {
    subprocess.kill();
    await options.session.disconnect().catch(() => undefined);
    throw new LiveSyncError("ffmpeg did not provide a frame stream", "ffmpeg_failed");
  }

  void (async () => {
    try {
      const text = await new Response(subprocess.stderr as ReadableStream<Uint8Array>).text();
      if (text.trim()) options.onError?.(new LiveSyncError(text.trim(), "ffmpeg_failed"));
    } catch {
      // Process torn down; nothing to report.
    }
  })();

  const frameBytes = width * height * 3;
  let frameCount = 0;
  let stopped = false;

  // The smoother owns sending to the lights, on its own clock — decoupled
  // from whatever rate the camera actually delivers frames at, and immune to
  // per-frame noise since it eases toward each new sample rather than
  // snapping to it.
  const smoother = new ColorSmoother({
    ...(options.smoothing?.timeConstantMs !== undefined ? { timeConstantMs: options.smoothing.timeConstantMs } : {}),
    ...(options.smoothing?.tickMs !== undefined ? { tickMs: options.smoothing.tickMs } : {}),
    onTick: (color) => {
      options.onOutput?.(color);
      if (options.session.isConnected) {
        options.session.setColors(options.channels.map((c) => ({ channel: c.channel, ...color })));
      }
    },
  });

  const pump = async () => {
    const reader = subprocess.stdout!.getReader();
    let buffer = new Uint8Array(0);
    try {
      while (!stopped) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        const merged = new Uint8Array(buffer.length + value.length);
        merged.set(buffer);
        merged.set(value, buffer.length);
        buffer = merged;
        while (buffer.length >= frameBytes) {
          const frame = buffer.subarray(0, frameBytes);
          buffer = buffer.subarray(frameBytes);
          const rawColor = averageColorInRegion(frame, mask);
          frameCount += 1;
          options.onFrame?.(rawColor);
          smoother.setTarget(gradeColor(rawColor, options.grade));
        }
      }
    } catch (error) {
      if (!stopped) options.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  };
  void pump();

  return {
    framesSampled: () => frameCount,
    async stop() {
      stopped = true;
      smoother.stop();
      subprocess.kill();
      await subprocess.exited.catch(() => undefined);
      await options.session.disconnect().catch(() => undefined);
    },
  };
}
