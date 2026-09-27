/**
 * Eases a light's color toward whatever `setTarget()` last set, over a fixed
 * time constant, on its own output clock — the same shape as Hyperion's and
 * HyperHDR's "smoothing" stage. Two problems this solves that raw per-frame
 * output does not:
 *
 *  - A camera source's frame-to-frame noise (encoder artifacts, tiny
 *    exposure shifts) would otherwise flicker the light every frame; easing
 *    toward a target instead of jumping to it filters that out.
 *  - The perceived transition speed would otherwise be coupled to whatever
 *    frame rate the camera happens to deliver; ticking on its own clock
 *    keeps the light's update rate constant regardless of source jitter.
 */
import type { RgbColor } from "./sample";

export interface ColorSmootherOptions {
  /** How long a full transition takes to settle (exponential approach), matching Hyperion's ~100-200ms default. */
  readonly timeConstantMs?: number;
  /** How often to tick and re-send, independent of the source's own frame rate. */
  readonly tickMs?: number;
  readonly onTick: (color: RgbColor) => void;
}

const DEFAULT_TIME_CONSTANT_MS = 150;
const DEFAULT_TICK_MS = 40; // 25 Hz, matching Hyperion's typical LED update rate

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/** Runs an exponential-approach smoother on its own timer; `stop()` clears it. */
export class ColorSmoother {
  private current: RgbColor;
  private target: RgbColor;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly alpha: number;

  constructor(private readonly options: ColorSmootherOptions, initial: RgbColor = { r: 0, g: 0, b: 0 }) {
    this.current = initial;
    this.target = initial;
    const tickMs = options.tickMs ?? DEFAULT_TICK_MS;
    const timeConstantMs = options.timeConstantMs ?? DEFAULT_TIME_CONSTANT_MS;
    // Fraction of the remaining distance to close each tick, derived from the
    // time constant so the transition settles in roughly `timeConstantMs`
    // regardless of `tickMs` (a standard discretized exponential approach).
    this.alpha = 1 - Math.exp(-tickMs / timeConstantMs);
    this.timer = setInterval(() => this.tick(), tickMs);
  }

  setTarget(color: RgbColor): void {
    this.target = color;
  }

  private tick(): void {
    this.current = {
      r: lerp(this.current.r, this.target.r, this.alpha),
      g: lerp(this.current.g, this.target.g, this.alpha),
      b: lerp(this.current.b, this.target.b, this.alpha),
    };
    this.options.onTick({
      r: Math.round(this.current.r),
      g: Math.round(this.current.g),
      b: Math.round(this.current.b),
    });
  }

  stop(): void {
    clearInterval(this.timer);
  }
}
