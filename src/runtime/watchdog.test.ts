import { expect, test } from "bun:test";
import { heartbeatOverdue } from "./watchdog";

test("cold application imports get the startup deadline instead of the shorter heartbeat deadline", () => {
  expect(heartbeatOverdue({ port: 0, heartbeat: 0, retiring: false }, 15_000, 10_000)).toBe(false);
});

test("ready workers are still killed when their heartbeat stops", () => {
  expect(heartbeatOverdue({ port: 41000, heartbeat: 0, retiring: false }, 15_000, 10_000)).toBe(true);
  expect(heartbeatOverdue({ port: 41000, heartbeat: 14_000, retiring: false }, 15_000, 10_000)).toBe(false);
  expect(heartbeatOverdue({ port: 41000, heartbeat: 0, retiring: true }, 15_000, 10_000)).toBe(false);
});
