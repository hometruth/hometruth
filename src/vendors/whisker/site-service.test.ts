import { describe, expect, test } from "bun:test";
import { WhiskerError, parseLr4Robot, type Lr4Robot } from "../../protocols/whisker/client";
import { PASSWORD, SERIAL, USERNAME, fakeWhisker, robotRecord } from "../../protocols/whisker/test-fixtures";
import type { SecretsFile } from "../../schemas";
import { WhiskerAccount, createWhiskerSiteService, type WhiskerTimers } from "./site-service";

const credentials = { username: USERNAME, password: PASSWORD };

class FakeTimers implements WhiskerTimers {
  readonly pending = new Map<number, () => void>();
  private next = 0;
  set(fn: () => void): unknown { const id = ++this.next; this.pending.set(id, fn); return id; }
  clear(handle: unknown): void { this.pending.delete(handle as number); }
  async fire(): Promise<void> {
    const due = [...this.pending.entries()];
    this.pending.clear();
    for (const [, fn] of due) fn();
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

function fakeClient(robots: () => Lr4Robot[] | Promise<Lr4Robot[]>) {
  const calls = { robots: 0, commands: [] as string[] };
  return {
    calls,
    client: {
      robots: async () => { calls.robots++; return robots(); },
      command: async (serial: string, command: string) => { calls.commands.push(`${serial}:${command}`); },
    },
  };
}

const robot = (overrides: Record<string, unknown> = {}) => parseLr4Robot(robotRecord(overrides))!;

describe("createWhiskerSiteService", () => {
  test("a site without both credentials has no Whisker service", () => {
    const empty: SecretsFile = { schemaVersion: 1 };
    expect(createWhiskerSiteService(empty)).toBeUndefined();
    expect(createWhiskerSiteService({ schemaVersion: 1, vendors: { whisker: { username: USERNAME } } })).toBeUndefined();
    expect(createWhiskerSiteService({ schemaVersion: 1, vendors: { whisker: { username: "  ", password: PASSWORD } } })).toBeUndefined();
    expect(createWhiskerSiteService({ schemaVersion: 1, vendors: { whisker: { username: USERNAME, password: PASSWORD } } })).toBeInstanceOf(WhiskerAccount);
  });

  test("signs in with the stored account on first read", async () => {
    const fake = fakeWhisker();
    const account = createWhiskerSiteService({ schemaVersion: 1, vendors: { whisker: { username: USERNAME, password: PASSWORD } } }, { fetch: fake.fetch })!;
    expect((await account.robot(SERIAL)).serial).toBe(SERIAL);
    expect(fake.cognito()[0]!.body.AuthParameters).toEqual({ USERNAME, PASSWORD });
  });
});

describe("WhiskerAccount", () => {
  test("concurrent and recent reads share one fetch; an old snapshot is refetched", async () => {
    let now = 0;
    const { client, calls } = fakeClient(() => [robot()]);
    const account = new WhiskerAccount(credentials, { client, now: () => now, maxAgeMs: 30_000 });
    await Promise.all([account.robot(SERIAL), account.robot(SERIAL), account.robots()]);
    now = 29_000;
    await account.robot(SERIAL.toLowerCase());
    expect(calls.robots).toBe(1);
    now = 31_000;
    await account.robot(SERIAL);
    expect(calls.robots).toBe(2);
  });

  test("a failed fetch is not hidden behind the last good snapshot", async () => {
    let now = 0;
    let fail = false;
    const { client, calls } = fakeClient(() => { if (fail) throw new WhiskerError("down", "unreachable"); return [robot()]; });
    const account = new WhiskerAccount(credentials, { client, now: () => now, maxAgeMs: 10 });
    await account.robot(SERIAL);
    fail = true;
    now = 20;
    await expect(account.robot(SERIAL)).rejects.toThrow("down");
    await expect(account.robot(SERIAL)).rejects.toThrow("down");
    expect(calls.robots).toBe(3);
  });

  test("an unknown serial is not_found", async () => {
    const { client } = fakeClient(() => [robot()]);
    const account = new WhiskerAccount(credentials, { client });
    await expect(account.robot("LR4C999999")).rejects.toMatchObject({ code: "not_found" });
  });

  test("a command makes the next read fetch fresh state", async () => {
    const { client, calls } = fakeClient(() => [robot()]);
    const account = new WhiskerAccount(credentials, { client, maxAgeMs: 60_000 });
    await account.robot(SERIAL);
    await account.command(SERIAL, "cleanCycle");
    await account.robot(SERIAL);
    expect(calls.commands).toEqual([`${SERIAL}:cleanCycle`]);
    expect(calls.robots).toBe(2);
  });

  test("polls only while watched and active, and tells watchers about changes", async () => {
    let now = 0;
    let status = "ROBOT_IDLE";
    const timers = new FakeTimers();
    const { client, calls } = fakeClient(() => [robot({ robotStatus: status })]);
    const account = new WhiskerAccount(credentials, { client, timers, now: () => now, maxAgeMs: 1_000, pollIntervalMs: 60_000 });
    expect(timers.pending.size).toBe(0);

    let active = true;
    let changes = 0;
    const release = account.subscribe(() => changes++, () => active);
    expect(timers.pending.size).toBe(1);

    now = 60_000;
    await timers.fire();
    expect(calls.robots).toBe(1);
    expect(changes).toBe(0);

    status = "ROBOT_CLEAN";
    now = 120_000;
    await timers.fire();
    expect(calls.robots).toBe(2);
    expect(changes).toBe(1);

    now = 180_000;
    await timers.fire();
    expect(changes).toBe(1);

    active = false;
    now = 240_000;
    await timers.fire();
    expect(calls.robots).toBe(3);
    expect(timers.pending.size).toBe(1);

    release();
    expect(timers.pending.size).toBe(0);
  });

  test("a poll failure is announced once, and stop ends polling", async () => {
    let now = 0;
    let fail = false;
    const timers = new FakeTimers();
    const { client } = fakeClient(() => { if (fail) throw new WhiskerError("down", "unreachable"); return [robot()]; });
    const account = new WhiskerAccount(credentials, { client, timers, now: () => now, maxAgeMs: 1 });
    let changes = 0;
    account.subscribe(() => changes++);
    now = 10; await timers.fire();
    fail = true;
    now = 20; await timers.fire();
    now = 30; await timers.fire();
    expect(changes).toBe(1);
    account.stop();
    expect(timers.pending.size).toBe(0);
  });
});
