import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventHistory } from "./event-history";
import type { ServiceEvent } from "./event-log";

const event = (n: number): ServiceEvent => ({ at: "2020-01-01T00:00:00.000Z", type: "started", level: "info", message: `Event ${n}`, subject: n === 0 ? "quiet" : "busy" });

test("archive retains more than 10,000 events across reopen and filters before limiting", () => {
  const directory = mkdtempSync(join(tmpdir(), "event-history-"));
  const path = join(directory, "events.sqlite");
  let history = new EventHistory(path);
  try {
    for (let n = 0; n < 10_005; n++) history.save(event(n));
    history.save(event(0));
    history.close(); history = new EventHistory(path);
    expect(history.page(1, { where: { path: "/subject", op: "eq", value: "quiet" } }).events).toEqual([event(0)]);
    const seen = new Set<string>();
    let before: string | undefined;
    do {
      const page = history.page(200, {}, before);
      for (const row of page.events) { expect(seen.has(row.message)).toBe(false); seen.add(row.message); }
      before = page.nextCursor;
    } while (before);
    expect(seen.size).toBe(10_005);
    expect(() => history.page(20, {}, "bad-cursor")).toThrow("Invalid event cursor");
  } finally { history.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("pagination is stable when newer events arrive, including equal timestamps", () => {
  const history = new EventHistory(":memory:");
  try {
    for (let n = 0; n < 5; n++) history.save(event(n));
    const first = history.page(2);
    history.save({ ...event(6), at: "2026-01-01T00:00:00.000Z" });
    const rest = history.page(200, {}, first.nextCursor);
    expect([...first.events, ...rest.events]).toHaveLength(5);
    expect(new Set([...first.events, ...rest.events].map(row => row.message)).size).toBe(5);
    expect(rest.nextCursor).toBeUndefined();
  } finally { history.close(); }
});
