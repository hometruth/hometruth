import type { IotValue } from "./types.ts";

export const MEARI_POLYGON_MAX_REGIONS = 6;
export const MEARI_POLYGON_POINT_COUNT = 8;

export interface MeariPolygonPoint {
  readonly x: number;
  readonly y: number;
}

export interface MeariPolygonRegion {
  readonly type: 1 | 2 | 3;
  readonly points: readonly MeariPolygonPoint[];
  readonly vId?: number;
  readonly aiTypes?: readonly number[];
}

export interface MeariPolygonRegionView {
  readonly polygons: readonly MeariPolygonRegion[];
  readonly maxPolygons: typeof MEARI_POLYGON_MAX_REGIONS;
  readonly pointCount: typeof MEARI_POLYGON_POINT_COUNT;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parse(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (!value.trim()) return [];
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(numeric) || numeric < minimum || numeric > maximum) {
    throw new RangeError(`${label} must be from ${minimum} to ${maximum}`);
  }
  // CloudEdge converts normalized coordinates with BigDecimal HALF_UP.
  return Math.round(numeric);
}

function polygonType(value: unknown, index: number): 1 | 2 | 3 {
  const result = integer(value ?? 1, `Polygon ${index + 1} type`, 1, 3);
  return result as 1 | 2 | 3;
}

function points(value: unknown, index: number): MeariPolygonPoint[] {
  if (!Array.isArray(value)) throw new TypeError(`Polygon ${index + 1} points must be a list`);
  const pairs: unknown[][] = value.every(isRecord)
    ? value.map((point) => [point.x, point.y])
    : value.length % 2 === 0 && value.every((coordinate) => typeof coordinate === "number" || typeof coordinate === "string")
      ? Array.from({ length: value.length / 2 }, (_, pointIndex) => [value[pointIndex * 2], value[pointIndex * 2 + 1]])
      : [];
  if (pairs.length !== MEARI_POLYGON_POINT_COUNT) {
    throw new RangeError(`Polygon ${index + 1} must contain exactly ${MEARI_POLYGON_POINT_COUNT} points`);
  }
  return pairs.map(([x, y], pointIndex) => ({
    x: integer(x, `Polygon ${index + 1} point ${pointIndex + 1} x`, 0, 100),
    y: integer(y, `Polygon ${index + 1} point ${pointIndex + 1} y`, 0, 100),
  }));
}

function optionalIntegerList(value: unknown, index: number): number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError(`Polygon ${index + 1} AI types must be a list`);
  const result = value.map((item, itemIndex) => integer(
    item,
    `Polygon ${index + 1} AI type ${itemIndex + 1}`,
    0,
    65_535,
  ));
  if (new Set(result).size !== result.length) {
    throw new RangeError(`Polygon ${index + 1} cannot repeat an AI type`);
  }
  return result;
}

function regions(value: unknown): UnknownRecord[] {
  const candidate = parse(value);
  const list = isRecord(candidate) && Array.isArray(candidate.polygons)
    ? candidate.polygons
    : candidate;
  if (!Array.isArray(list) || !list.every(isRecord)) {
    throw new TypeError("Polygon detection regions must be a list of polygons");
  }
  if (list.length > MEARI_POLYGON_MAX_REGIONS) {
    throw new RangeError(`This firmware supports at most ${MEARI_POLYGON_MAX_REGIONS} polygon regions`);
  }
  return list;
}

function normalized(value: unknown): MeariPolygonRegion[] {
  return regions(value).map((region, index) => {
    const vIdValue = region.vId ?? region.v_id;
    const aiTypes = optionalIntegerList(region.aiTypes ?? region.ai_type, index);
    return {
      type: polygonType(region.type, index),
      points: points(region.points, index),
      ...(vIdValue === undefined ? {} : { vId: integer(vIdValue, `Polygon ${index + 1} view`, 0, 4) }),
      ...(aiTypes === undefined ? {} : { aiTypes }),
    };
  });
}

/** Decode CloudEdge property 232 into percentage-based points suitable for an editor. */
export function decodeMeariPolygonRegions(value: IotValue | undefined): MeariPolygonRegionView | undefined {
  if (value === undefined) return undefined;
  try {
    return {
      polygons: normalized(value),
      maxPolygons: MEARI_POLYGON_MAX_REGIONS,
      pointCount: MEARI_POLYGON_POINT_COUNT,
    };
  } catch {
    return undefined;
  }
}

/** Encode the friendly polygon editor into CloudEdge's flat percentage-point array. */
export function encodeMeariPolygonRegions(value: unknown): IotValue {
  return normalized(value).map((region) => ({
    ...(region.vId === undefined ? {} : { v_id: region.vId }),
    type: region.type,
    points: region.points.flatMap((point) => [point.x, point.y]),
    ...(region.aiTypes === undefined ? {} : { ai_type: [...region.aiTypes] }),
  }));
}
