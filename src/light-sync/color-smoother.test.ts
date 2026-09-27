import { describe, expect, test } from "bun:test";
import { ColorSmoother } from "./color-smoother";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("ColorSmoother", () => {
  test("emits the initial color on the first tick when no target has changed", async () => {
    const ticks: { r: number; g: number; b: number }[] = [];
    const smoother = new ColorSmoother({ tickMs: 10, timeConstantMs: 50, onTick: (c) => ticks.push(c) }, { r: 100, g: 100, b: 100 });
    await wait(25);
    smoother.stop();
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks[0]).toEqual({ r: 100, g: 100, b: 100 });
  });

  test("eases toward a new target rather than jumping to it", async () => {
    const ticks: { r: number; g: number; b: number }[] = [];
    const smoother = new ColorSmoother({ tickMs: 10, timeConstantMs: 100, onTick: (c) => ticks.push(c) }, { r: 0, g: 0, b: 0 });
    smoother.setTarget({ r: 255, g: 255, b: 255 });
    await wait(15); // one or two ticks in
    smoother.stop();
    const firstAfterTarget = ticks[0]!;
    expect(firstAfterTarget.r).toBeGreaterThan(0);
    expect(firstAfterTarget.r).toBeLessThan(255);
  });

  test("converges to the target given enough time", async () => {
    const ticks: { r: number; g: number; b: number }[] = [];
    const smoother = new ColorSmoother({ tickMs: 5, timeConstantMs: 30, onTick: (c) => ticks.push(c) }, { r: 0, g: 0, b: 0 });
    smoother.setTarget({ r: 200, g: 50, b: 10 });
    await wait(300); // ~10 time constants
    smoother.stop();
    const last = ticks.at(-1)!;
    expect(last.r).toBeGreaterThanOrEqual(195);
    expect(last.g).toBeGreaterThanOrEqual(45);
    expect(last.b).toBeGreaterThanOrEqual(5);
  });

  test("a changed target mid-transition redirects smoothly rather than resetting", async () => {
    const ticks: { r: number }[] = [];
    const smoother = new ColorSmoother({ tickMs: 5, timeConstantMs: 100, onTick: (c) => ticks.push(c) }, { r: 0, g: 0, b: 0 });
    smoother.setTarget({ r: 255, g: 0, b: 0 });
    await wait(30);
    const midway = ticks.at(-1)!.r;
    smoother.setTarget({ r: 0, g: 0, b: 0 }); // change target before settling
    await wait(15);
    smoother.stop();
    const afterRedirect = ticks.at(-1)!.r;
    // Should be moving back down from wherever it got to, not still climbing.
    expect(afterRedirect).toBeLessThan(midway + 1);
  });

  test("stop() halts further ticks", async () => {
    const ticks: unknown[] = [];
    const smoother = new ColorSmoother({ tickMs: 5, timeConstantMs: 50, onTick: (c) => ticks.push(c) });
    await wait(15);
    smoother.stop();
    const countAtStop = ticks.length;
    await wait(30);
    expect(ticks.length).toBe(countAtStop);
  });
});
