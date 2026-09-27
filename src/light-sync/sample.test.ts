import { describe, expect, test } from "bun:test";
import { parseSourceRegion, rasterizeRegion } from "./region";
import { averageColorInRegion, SampleError, splitRegionIntoZones } from "./sample";

/** Build a packed RGB24 frame from a row-major grid of [r,g,b] triples. */
function frameFromPixels(pixels: readonly (readonly [number, number, number])[]): Uint8Array {
  const buffer = new Uint8Array(pixels.length * 3);
  pixels.forEach(([r, g, b], i) => {
    buffer[i * 3] = r;
    buffer[i * 3 + 1] = g;
    buffer[i * 3 + 2] = b;
  });
  return buffer;
}

describe("averageColorInRegion", () => {
  test("averages only pixels inside the region", () => {
    // 4x2 frame; left half red, right half blue.
    const frame = frameFromPixels([
      [255, 0, 0], [255, 0, 0], [0, 0, 255], [0, 0, 255],
      [255, 0, 0], [255, 0, 0], [0, 0, 255], [0, 0, 255],
    ]);
    const rightHalf = rasterizeRegion(
      parseSourceRegion([{ x: 0.5, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0.5, y: 1 }]),
      4, 2,
    );
    expect(averageColorInRegion(frame, rightHalf)).toEqual({ r: 0, g: 0, b: 255 });
  });

  test("a full-frame region averages every pixel", () => {
    const frame = frameFromPixels([[100, 100, 100], [200, 200, 200]]);
    const full = rasterizeRegion(parseSourceRegion([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]), 2, 1);
    expect(averageColorInRegion(frame, full)).toEqual({ r: 150, g: 150, b: 150 });
  });

  test("rounds a non-integer average", () => {
    const frame = frameFromPixels([[10, 10, 10], [11, 11, 11], [10, 10, 10]]);
    const full = rasterizeRegion(parseSourceRegion([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]), 3, 1);
    // (10+11+10)/3 = 10.333... -> rounds to 10
    expect(averageColorInRegion(frame, full)).toEqual({ r: 10, g: 10, b: 10 });
  });

  test("throws on a frame/mask dimension mismatch", () => {
    const frame = frameFromPixels([[0, 0, 0]]); // 1 pixel
    const mask = rasterizeRegion(parseSourceRegion([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]), 2, 2); // expects 4
    expect(() => averageColorInRegion(frame, mask)).toThrow(SampleError);
  });

  test("throws when the region covers zero pixels at this resolution", () => {
    const frame = frameFromPixels([[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]);
    const emptyMask = rasterizeRegion(
      parseSourceRegion([{ x: 0.98, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0.98, y: 1 }]),
      4, 1,
    );
    expect(() => averageColorInRegion(frame, emptyMask)).toThrow(SampleError);
  });
});

describe("splitRegionIntoZones", () => {
  test("splits a full-frame region into equal columns", () => {
    const full = rasterizeRegion(parseSourceRegion([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]), 6, 1);
    const zones = splitRegionIntoZones(full, 3);
    expect(zones).toHaveLength(3);
    expect(zones.map((z) => z.pixelCount)).toEqual([2, 2, 2]);
  });

  test("each zone samples its own slice of the frame", () => {
    const frame = frameFromPixels([[255, 0, 0], [255, 0, 0], [0, 255, 0], [0, 255, 0], [0, 0, 255], [0, 0, 255]]);
    const full = rasterizeRegion(parseSourceRegion([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]), 6, 1);
    const [left, middle, right] = splitRegionIntoZones(full, 3);
    expect(averageColorInRegion(frame, left!)).toEqual({ r: 255, g: 0, b: 0 });
    expect(averageColorInRegion(frame, middle!)).toEqual({ r: 0, g: 255, b: 0 });
    expect(averageColorInRegion(frame, right!)).toEqual({ r: 0, g: 0, b: 255 });
  });

  test("an uneven split gives the remainder to the last zone", () => {
    const full = rasterizeRegion(parseSourceRegion([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]), 7, 1);
    const zones = splitRegionIntoZones(full, 3);
    expect(zones.reduce((sum, z) => sum + z.pixelCount, 0)).toBe(7);
  });

  test("rejects a non-positive or non-integer zone count", () => {
    const full = rasterizeRegion(parseSourceRegion([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]), 4, 1);
    expect(() => splitRegionIntoZones(full, 0)).toThrow();
    expect(() => splitRegionIntoZones(full, 1.5)).toThrow();
  });
});
