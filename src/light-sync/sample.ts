/**
 * Averages the pixels of a decoded RGB frame that fall inside a `RegionMask`.
 * This is the per-frame hot path for camera-to-light sync: cheap on purpose,
 * since it runs at whatever frame rate the analyzer decides to sample at.
 */
import type { RegionMask } from "./region";

export interface RgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export type SampleErrorCode = "empty_region" | "dimension_mismatch" | "invalid_buffer";

export class SampleError extends Error {
  constructor(message: string, readonly code: SampleErrorCode) {
    super(message);
    this.name = "SampleError";
  }
}

/**
 * `frame` is packed RGB24 (3 bytes per pixel, row-major, no padding) at
 * exactly `mask.width` x `mask.height` — the same dimensions the mask was
 * rasterized for. Callers scale the decoded frame to the mask's resolution
 * (or vice versa) before calling this; it does not resample.
 */
export function averageColorInRegion(frame: Uint8Array, mask: RegionMask): RgbColor {
  const expectedBytes = mask.width * mask.height * 3;
  if (frame.length !== expectedBytes) {
    throw new SampleError(
      `Frame is ${frame.length} bytes; expected ${expectedBytes} for a ${mask.width}x${mask.height} RGB24 frame`,
      "dimension_mismatch",
    );
  }
  if (mask.pixelCount === 0) {
    throw new SampleError("Region covers no pixels at this frame's resolution", "empty_region");
  }
  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  const pixelTotal = mask.width * mask.height;
  for (let i = 0; i < pixelTotal; i++) {
    if (mask.inside[i] === 0) continue;
    const offset = i * 3;
    rSum += frame[offset]!;
    gSum += frame[offset + 1]!;
    bSum += frame[offset + 2]!;
  }
  const count = mask.pixelCount;
  return {
    r: Math.round(rSum / count),
    g: Math.round(gSum / count),
    b: Math.round(bSum / count),
  };
}

/**
 * Splits a region's bounding box into an `n`-across grid of sub-regions
 * (each itself intersected with the original mask) so a caller can drive
 * multiple lights — e.g. a left/right pair, or the three Hue "TV area"
 * channels — from different edges of the same source region instead of one
 * flat average. Cells with no pixels of their own fall back to the overall
 * average so a light is never left without a color.
 */
export function splitRegionIntoZones(mask: RegionMask, zoneCount: number): RegionMask[] {
  if (!Number.isInteger(zoneCount) || zoneCount < 1) {
    throw new SampleError("Zone count must be a positive integer", "invalid_buffer");
  }
  const zones: RegionMask[] = [];
  const columnWidth = mask.width / zoneCount;
  for (let zone = 0; zone < zoneCount; zone++) {
    const columnStart = Math.floor(zone * columnWidth);
    const columnEnd = zone === zoneCount - 1 ? mask.width : Math.floor((zone + 1) * columnWidth);
    const inside = new Uint8Array(mask.width * mask.height);
    let pixelCount = 0;
    for (let y = 0; y < mask.height; y++) {
      for (let x = columnStart; x < columnEnd; x++) {
        const index = y * mask.width + x;
        if (mask.inside[index] === 1) {
          inside[index] = 1;
          pixelCount++;
        }
      }
    }
    zones.push({ width: mask.width, height: mask.height, inside, pixelCount });
  }
  return zones;
}
