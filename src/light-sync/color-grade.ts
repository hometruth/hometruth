/**
 * Corrects a raw camera-frame color average so it reads the way Hyperion and
 * HyperHDR grade their own captures: a straight RGB average of a video frame
 * (doubly so from a lossy, auto-exposing consumer camera pointed at a
 * screen, rather than a clean HDMI/screen capture) comes out visibly
 * desaturated and dim compared to what a viewer perceives the scene's color
 * to be, so every ambient-lighting project boosts saturation and value in
 * HSV space and applies a per-channel gamma curve before sending to a light.
 */
import type { RgbColor } from "./sample";

export interface ColorGradeOptions {
  /** Multiplies HSV saturation; 1 = unchanged. Hyperion/HyperHDR default well above 1 (commonly 1.5-3) because camera captures read desaturated. */
  readonly saturationGain?: number;
  /** Multiplies HSV value (brightness); 1 = unchanged. */
  readonly valueGain?: number;
  /** Per-channel gamma; >1 brightens midtones (HyperHDR's own default is 1.5). Applied after the HSV gains, in linear-ish RGB space. */
  readonly gamma?: number;
}

const DEFAULT_SATURATION_GAIN = 2.2;
const DEFAULT_VALUE_GAIN = 1.15;
const DEFAULT_GAMMA = 1.5;

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  let h = 0;
  if (delta !== 0) {
    if (max === rn) h = ((gn - bn) / delta) % 6;
    else if (max === gn) h = (bn - rn) / delta + 2;
    else h = (rn - gn) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : delta / max;
  return [h, s, max];
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let [r, g, b] = [0, 0, 0];
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

function clampByte(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

/** Boost saturation/value in HSV space, then apply per-channel gamma. Order matches Hyperion's own RGB→HSV→RGB→gamma pipeline. */
export function gradeColor(color: RgbColor, options: ColorGradeOptions = {}): RgbColor {
  const saturationGain = options.saturationGain ?? DEFAULT_SATURATION_GAIN;
  const valueGain = options.valueGain ?? DEFAULT_VALUE_GAIN;
  const gamma = options.gamma ?? DEFAULT_GAMMA;

  const [h, s, v] = rgbToHsv(color.r, color.g, color.b);
  const [r, g, b] = hsvToRgb(h, Math.min(1, s * saturationGain), Math.min(1, v * valueGain));

  const applyGamma = (channel: number) => 255 * Math.pow(channel / 255, 1 / gamma);
  return {
    r: clampByte(applyGamma(r)),
    g: clampByte(applyGamma(g)),
    b: clampByte(applyGamma(b)),
  };
}
