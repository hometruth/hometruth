/** Intended cues, not evidence that the owner performed an action at this time. */
export const TMNT_SESSION_PLAN = {
  id: "tmnt-six-buttons",
  durationMs: 20000,
  timingBasis: "Planned milliseconds from firmware capture start; physical button edges are NOT measured.",
  steps: [
    { startMs: 0, endMs: 1000, action: "off" },
    { startMs: 1000, endMs: 3000, action: "pair" },
    { startMs: 3000, endMs: 5000, action: "forward" },
    { startMs: 5000, endMs: 6000, action: "release" },
    { startMs: 6000, endMs: 8000, action: "backward" },
    { startMs: 8000, endMs: 9000, action: "release" },
    { startMs: 9000, endMs: 11000, action: "left" },
    { startMs: 11000, endMs: 12000, action: "release" },
    { startMs: 12000, endMs: 14000, action: "right" },
    { startMs: 14000, endMs: 15000, action: "release" },
    { startMs: 15000, endMs: 17000, action: "energize" },
    { startMs: 17000, endMs: 18000, action: "release" },
    { startMs: 18000, endMs: 20000, action: "throwPizza" },
  ],
} as const;
