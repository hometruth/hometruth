/**
 * A camera's "TV region": an arbitrary polygon drawn by the user over a
 * snapshot, in coordinates normalized to the snapshot's own width/height
 * (0..1 on each axis) so the same region stays valid across resolutions
 * (main stream vs. sub stream) and survives the camera being nudged only
 * slightly.
 *
 * Deliberately independent of the tkenpro vendor's `MeariPolygonRegion`
 * (see `protocols/tkenpro/polygon-region-codecs.ts`): that type is a fixed
 * 8-point, integer 0-100, on-camera motion-detection wire format for one
 * vendor's firmware. This one is a generic pixel-space shape used purely on
 * our side to know which pixels of a decoded frame to average.
 */

export interface NormalizedPoint {
  readonly x: number;
  readonly y: number;
}

export interface SourceRegion {
  readonly points: readonly NormalizedPoint[];
}

export const MIN_REGION_POINTS = 3;
export const MAX_REGION_POINTS = 32;

export type RegionErrorCode = "too_few_points" | "too_many_points" | "invalid_point";

export class RegionError extends Error {
  constructor(message: string, readonly code: RegionErrorCode) {
    super(message);
    this.name = "RegionError";
  }
}

function isFiniteUnitCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Validate and normalize arbitrary input into a `SourceRegion`, or throw `RegionError`. */
export function parseSourceRegion(value: unknown): SourceRegion {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? (value as { points?: unknown })
    : undefined;
  const rawPoints = record ? record.points : value;
  if (!Array.isArray(rawPoints)) {
    throw new RegionError("A region's points must be a list", "too_few_points");
  }
  if (rawPoints.length < MIN_REGION_POINTS) {
    throw new RegionError(`A region needs at least ${MIN_REGION_POINTS} points`, "too_few_points");
  }
  if (rawPoints.length > MAX_REGION_POINTS) {
    throw new RegionError(`A region can have at most ${MAX_REGION_POINTS} points`, "too_many_points");
  }
  const points: NormalizedPoint[] = rawPoints.map((point, index) => {
    if (!point || typeof point !== "object") {
      throw new RegionError(`Point ${index + 1} must be an object with x and y`, "invalid_point");
    }
    const { x, y } = point as { x?: unknown; y?: unknown };
    if (!isFiniteUnitCoordinate(x) || !isFiniteUnitCoordinate(y)) {
      throw new RegionError(`Point ${index + 1} must have x and y from 0 to 1`, "invalid_point");
    }
    return { x, y };
  });
  return { points };
}

/** Ray-casting point-in-polygon test, coordinates in the same (normalized or pixel) space. */
export function pointInPolygon(point: NormalizedPoint, polygon: readonly NormalizedPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    const crossesScanline = (a.y > point.y) !== (b.y > point.y);
    if (!crossesScanline) continue;
    const xAtScanline = a.x + ((point.y - a.y) / (b.y - a.y)) * (b.x - a.x);
    if (point.x < xAtScanline) inside = !inside;
  }
  return inside;
}

/**
 * A precomputed boolean mask over a `width` x `height` pixel grid, `true`
 * where the pixel center falls inside the region. Rasterizing once and
 * reusing the mask keeps per-frame sampling to a single pass over the pixels
 * already known to matter, instead of a point-in-polygon test per pixel per
 * frame.
 */
export interface RegionMask {
  readonly width: number;
  readonly height: number;
  /** `true` at index `y * width + x` when that pixel is inside the region. */
  readonly inside: Uint8Array;
  /** Count of `true` entries in `inside`; 0 means the region covers no pixel center at this resolution. */
  readonly pixelCount: number;
}

export function rasterizeRegion(region: SourceRegion, width: number, height: number): RegionMask {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RegionError("Mask dimensions must be positive integers", "invalid_point");
  }
  const polygon = region.points;
  const inside = new Uint8Array(width * height);
  let pixelCount = 0;
  for (let py = 0; py < height; py++) {
    // Sample at the pixel center so a region edge that lands exactly on a
    // pixel boundary doesn't flicker between included/excluded by rounding.
    const ny = (py + 0.5) / height;
    for (let px = 0; px < width; px++) {
      const nx = (px + 0.5) / width;
      if (pointInPolygon({ x: nx, y: ny }, polygon)) {
        inside[py * width + px] = 1;
        pixelCount++;
      }
    }
  }
  return { width, height, inside, pixelCount };
}
