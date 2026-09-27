import { describe, expect, test } from "bun:test";
import { MAX_REGION_POINTS, MIN_REGION_POINTS, parseSourceRegion, pointInPolygon, RegionError, rasterizeRegion } from "./region";

describe("parseSourceRegion", () => {
  test("accepts a plain array of points", () => {
    const region = parseSourceRegion([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]);
    expect(region.points).toHaveLength(3);
  });

  test("accepts a { points } wrapper", () => {
    const region = parseSourceRegion({ points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] });
    expect(region.points).toHaveLength(3);
  });

  test("rejects fewer than the minimum points", () => {
    expect(() => parseSourceRegion([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toThrow(RegionError);
  });

  test(`rejects more than ${MAX_REGION_POINTS} points`, () => {
    const points = Array.from({ length: MAX_REGION_POINTS + 1 }, (_, i) => ({ x: i / 100, y: 0 }));
    expect(() => parseSourceRegion(points)).toThrow(RegionError);
  });

  test("rejects coordinates outside 0..1", () => {
    expect(() => parseSourceRegion([{ x: -0.1, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }])).toThrow(RegionError);
    expect(() => parseSourceRegion([{ x: 0, y: 0 }, { x: 1.5, y: 0 }, { x: 1, y: 1 }])).toThrow(RegionError);
  });

  test("rejects NaN / non-numeric coordinates", () => {
    expect(() => parseSourceRegion([{ x: Number.NaN, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }])).toThrow(RegionError);
    expect(() => parseSourceRegion([{ x: "0", y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] as unknown[])).toThrow(RegionError);
  });

  test(`accepts exactly the minimum (${MIN_REGION_POINTS}) points`, () => {
    const points = Array.from({ length: MIN_REGION_POINTS }, (_, i) => ({ x: i / 10, y: 0 }));
    expect(parseSourceRegion(points).points).toHaveLength(MIN_REGION_POINTS);
  });
});

describe("pointInPolygon", () => {
  const square = [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.8, y: 0.8 }, { x: 0.2, y: 0.8 }];

  test("center is inside", () => {
    expect(pointInPolygon({ x: 0.5, y: 0.5 }, square)).toBe(true);
  });

  test("outside the bounding box is outside", () => {
    expect(pointInPolygon({ x: 0.05, y: 0.05 }, square)).toBe(false);
    expect(pointInPolygon({ x: 0.95, y: 0.95 }, square)).toBe(false);
  });

  test("inside the bounding box but outside a non-convex shape", () => {
    // An "L" shape: full left column plus a bottom-right notch.
    const lShape = [
      { x: 0.1, y: 0.1 }, { x: 0.4, y: 0.1 }, { x: 0.4, y: 0.4 },
      { x: 0.9, y: 0.4 }, { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.9 },
    ];
    expect(pointInPolygon({ x: 0.6, y: 0.2 }, lShape)).toBe(false); // top-right notch, outside
    expect(pointInPolygon({ x: 0.6, y: 0.6 }, lShape)).toBe(true); // bottom-right, inside
    expect(pointInPolygon({ x: 0.2, y: 0.6 }, lShape)).toBe(true); // left column, inside
  });

  test("a triangle excludes points across its hypotenuse", () => {
    const triangle = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }];
    expect(pointInPolygon({ x: 0.1, y: 0.1 }, triangle)).toBe(true);
    expect(pointInPolygon({ x: 0.9, y: 0.9 }, triangle)).toBe(false);
  });
});

describe("rasterizeRegion", () => {
  test("marks only pixels whose center is inside", () => {
    // A region covering exactly the right half of the frame (x in [0.5, 1]).
    const region = parseSourceRegion([{ x: 0.5, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0.5, y: 1 }]);
    const mask = rasterizeRegion(region, 4, 2);
    // Pixel centers at x = 0.125, 0.375, 0.625, 0.875 (normalized); only the
    // right two columns (0.625, 0.875) should be inside.
    const row0 = Array.from(mask.inside.slice(0, 4));
    expect(row0).toEqual([0, 0, 1, 1]);
    expect(mask.pixelCount).toBe(4); // 2 columns x 2 rows
  });

  test("full-frame region marks every pixel", () => {
    const region = parseSourceRegion([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]);
    const mask = rasterizeRegion(region, 3, 3);
    expect(mask.pixelCount).toBe(9);
    expect(Array.from(mask.inside)).toEqual(new Array(9).fill(1));
  });

  test("a region entirely outside the sampled area marks nothing", () => {
    // Degenerate but valid: a sliver beyond typical camera framing, expressed
    // as a region hugging x in [0.98, 1] on a low-res grid where no pixel
    // center lands there.
    const region = parseSourceRegion([{ x: 0.98, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0.98, y: 1 }]);
    const mask = rasterizeRegion(region, 4, 4); // pixel centers at 0.125, 0.375, 0.625, 0.875
    expect(mask.pixelCount).toBe(0);
  });

  test("rejects non-positive or non-integer dimensions", () => {
    const region = parseSourceRegion([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]);
    expect(() => rasterizeRegion(region, 0, 4)).toThrow();
    expect(() => rasterizeRegion(region, 4, -1)).toThrow();
    expect(() => rasterizeRegion(region, 1.5, 4)).toThrow();
  });
});
