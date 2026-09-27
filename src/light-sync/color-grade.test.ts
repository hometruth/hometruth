import { describe, expect, test } from "bun:test";
import { gradeColor } from "./color-grade";

describe("gradeColor", () => {
  test("pure grey stays grey regardless of saturation gain (zero saturation has nothing to boost)", () => {
    const graded = gradeColor({ r: 128, g: 128, b: 128 }, { saturationGain: 3, valueGain: 1, gamma: 1 });
    expect(graded.r).toBe(graded.g);
    expect(graded.g).toBe(graded.b);
  });

  test("saturation gain increases the spread between channels of a tinted color", () => {
    const raw = { r: 180, g: 190, b: 200 }; // mildly blue-tinted, low saturation
    const unboosted = gradeColor(raw, { saturationGain: 1, valueGain: 1, gamma: 1 });
    const boosted = gradeColor(raw, { saturationGain: 3, valueGain: 1, gamma: 1 });
    const spread = (c: { r: number; g: number; b: number }) => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
    expect(spread(boosted)).toBeGreaterThan(spread(unboosted));
  });

  test("value gain brightens a dim color", () => {
    const dim = { r: 50, g: 50, b: 50 };
    const graded = gradeColor(dim, { saturationGain: 1, valueGain: 2, gamma: 1 });
    expect(graded.r).toBeGreaterThan(dim.r);
  });

  test("gamma > 1 brightens midtones", () => {
    const mid = { r: 128, g: 128, b: 128 };
    const graded = gradeColor(mid, { saturationGain: 1, valueGain: 1, gamma: 2 });
    expect(graded.r).toBeGreaterThan(mid.r);
  });

  test("black stays black", () => {
    const graded = gradeColor({ r: 0, g: 0, b: 0 });
    expect(graded).toEqual({ r: 0, g: 0, b: 0 });
  });

  test("white stays at or near white", () => {
    const graded = gradeColor({ r: 255, g: 255, b: 255 });
    expect(graded.r).toBeGreaterThanOrEqual(250);
    expect(graded.g).toBeGreaterThanOrEqual(250);
    expect(graded.b).toBeGreaterThanOrEqual(250);
  });

  test("output is always a valid byte range", () => {
    const graded = gradeColor({ r: 10, g: 200, b: 90 }, { saturationGain: 5, valueGain: 3, gamma: 3 });
    for (const channel of [graded.r, graded.g, graded.b]) {
      expect(channel).toBeGreaterThanOrEqual(0);
      expect(channel).toBeLessThanOrEqual(255);
    }
  });

  test("default options apply a visible saturation and value boost vs. the identity", () => {
    const raw = { r: 175, g: 190, b: 200 };
    const identity = gradeColor(raw, { saturationGain: 1, valueGain: 1, gamma: 1 });
    const defaulted = gradeColor(raw);
    expect(defaulted).not.toEqual(identity);
  });
});
