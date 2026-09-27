import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { subscribeMatter } from "./client";
import type { MatterSnapshot } from "./snapshot";

function fixture(value = true): MatterSnapshot {
  return { observedAt: "2026-09-15T00:00:00.000Z", attributes: [{ endpoint: 2, cluster: 69, attribute: 0, value }] };
}

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stdin = { end: () => {}, on: () => {} };
  killed = false;
  kill(): void { this.killed = true; }
  writeLine(value: unknown): void { this.stdout.write(JSON.stringify(value) + "\n"); }
  exit(): void { this.emit("exit"); }
}

describe("subscribeMatter", () => {
  test("reports a well-formed snapshot line, ignores malformed and empty ones", async () => {
    const children: FakeChild[] = [];
    const reports: MatterSnapshot[] = [];
    const subscription = subscribeMatter("peer1", snapshot => reports.push(snapshot), {
      spawnWorker: (() => { const child = new FakeChild(); children.push(child); return child as unknown as ChildProcess; }) as never,
    });
    const child = children[0]!;
    child.writeLine(fixture(true));
    child.writeLine({ error: "Matter connection unavailable" });
    child.writeLine("not json{");
    child.writeLine("");
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(reports).toHaveLength(1);
    expect(reports[0]).toEqual(fixture(true));
    subscription.stop();
    expect(child.killed).toBe(true);
  });

  test("restarts the worker after an unexpected exit, and stop() prevents the restart", async () => {
    const children: FakeChild[] = [];
    const reports: MatterSnapshot[] = [];
    const subscription = subscribeMatter("peer1", snapshot => reports.push(snapshot), {
      spawnWorker: (() => { const child = new FakeChild(); children.push(child); return child as unknown as ChildProcess; }) as never,
    });
    expect(children).toHaveLength(1);
    children[0]!.exit();
    await new Promise(resolve => setTimeout(resolve, 2100));
    expect(children.length).toBeGreaterThan(1);
    subscription.stop();
    const countAfterStop = children.length;
    children.at(-1)!.exit();
    await new Promise(resolve => setTimeout(resolve, 2100));
    expect(children).toHaveLength(countAfterStop);
  }, 10_000);

  test("rejects an invalid peer id before spawning anything", () => {
    expect(() => subscribeMatter("../keys", () => {})).toThrow();
  });

  test("the watchdog kills a worker that never sends a report or an error line (stuck inside an unbounded SDK call)", async () => {
    const children: FakeChild[] = [];
    const errors: string[] = [];
    const subscription = subscribeMatter("peer1", () => {}, {
      spawnWorker: (() => { const child = new FakeChild(); children.push(child); return child as unknown as ChildProcess; }) as never,
      onError: detail => errors.push(detail),
      watchdogMs: 10,
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(children[0]!.killed).toBe(true);
    expect(errors).toHaveLength(1);
    subscription.stop();
  });

  test("a report before the watchdog fires cancels it: the worker is not killed", async () => {
    const children: FakeChild[] = [];
    const subscription = subscribeMatter("peer1", () => {}, {
      spawnWorker: (() => { const child = new FakeChild(); children.push(child); return child as unknown as ChildProcess; }) as never,
      watchdogMs: 30,
    });
    children[0]!.writeLine(fixture(true));
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(children[0]!.killed).toBe(false);
    subscription.stop();
  });
});
