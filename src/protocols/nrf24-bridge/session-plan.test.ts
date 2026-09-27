import { expect, test } from "bun:test";
import { TMNT_SESSION_PLAN as plan } from "./session-plan";

test("full session has six separate two-second holds in requested order with released gaps", () => {
  expect(plan.steps[0]).toEqual({ startMs: 0, endMs: 1000, action: "off" });
  expect(plan.steps[1].action).toBe("pair");
  expect(plan.steps.at(-1)?.endMs).toBe(plan.durationMs);
  for (let i = 1; i < plan.steps.length; i++) expect(Number(plan.steps[i]!.startMs)).toBe(plan.steps[i - 1]!.endMs);
  const presses = plan.steps.filter(step => !["off", "pair", "release"].includes(step.action));
  expect(presses.map(step => step.action)).toEqual(["forward", "backward", "left", "right", "energize", "throwPizza"]);
  for (const step of presses) expect(step.endMs - step.startMs).toBe(2000);
  for (const step of plan.steps.filter(step => step.action === "release")) expect(step.endMs - step.startMs).toBe(1000);
  expect(plan.timingBasis).toContain("NOT measured");
});
