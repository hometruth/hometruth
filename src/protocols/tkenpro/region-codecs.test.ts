import { describe, expect, test } from "bun:test";
import {
  decodeMeariGridRegion,
  encodeMeariGridRegion,
  MEARI_ROI_CELL_COUNT,
} from "./region-codecs.ts";

describe("Meari motion-region codec", () => {
  test("encodes selected cells with the app's row-major, high-bit-first format", () => {
    expect(encodeMeariGridRegion({ selectedCells: [0, 3, 4, 143] })).toEqual({
      enable: 1,
      width: 16,
      height: 9,
      bitmap: `98${"0".repeat(33)}1`,
    });
  });

  test("decodes all 144 cells without losing nibble boundaries", () => {
    const decoded = decodeMeariGridRegion(JSON.stringify({
      enable: 1,
      width: 16,
      height: 9,
      bitmap: "8".repeat(36),
    }));
    expect(decoded).toEqual({
      enabled: true,
      width: 16,
      height: 9,
      selectedCells: Array.from({ length: 36 }, (_, index) => index * 4),
    });
  });

  test("encodes a cleared grid as the disabled canonical value", () => {
    expect(encodeMeariGridRegion({
      cells: Array.from({ length: MEARI_ROI_CELL_COUNT }, () => false),
    })).toEqual({
      enable: 0,
      width: 16,
      height: 9,
      bitmap: "0".repeat(36),
    });
  });

  test("rejects malformed, duplicate, and internally inconsistent regions", () => {
    expect(decodeMeariGridRegion('{"enable":1,"width":16,"height":9,"bitmap":"F"}')).toBeUndefined();
    expect(() => encodeMeariGridRegion({ selectedCells: [1, 1] })).toThrow("duplicate");
    expect(() => encodeMeariGridRegion({ enabled: false, selectedCells: [1] })).toThrow("must match");
    expect(() => encodeMeariGridRegion({ selectedCells: [MEARI_ROI_CELL_COUNT] })).toThrow("0 through 143");
  });
});
