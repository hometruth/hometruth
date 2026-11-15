import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Button } from "../../../models/button";
import { OptimisticButtonSwitch } from ".";
import { SqliteOptimisticSwitchStateStore } from "./state-store";

class TestButton extends Button {
  presses = 0;
  fail = false;
  protected async performPress() {
    if (this.fail) throw new Error("send failed");
    this.presses++;
  }
}

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const AT = "2026-09-03T20:00:00.000Z";
function path() {
  const directory = mkdtempSync(join(tmpdir(), "hometruth-switch-state-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "switches.sqlite");
}
function open(file: string, on = new TestButton("on"), off = new TestButton("off"), initial?: "on" | "off") {
  const store = new SqliteOptimisticSwitchStateStore(file);
  const device = new OptimisticButtonSwitch("lamp", on, off, store, () => "online", initial, () => new Date(AT));
  let closed = false;
  const close = () => { if (!closed) { device.close(); store.close(); closed = true; } };
  cleanups.push(close);
  return { store, device, on, off, close };
}

test("an uncommanded switch remains unknown after reopening storage", async () => {
  const file = path(), first = open(file);
  expect((await first.device.describe()).state).toEqual({ availability: "online" });
  first.close();
  const next = open(file);
  await expect(next.device.getState()).rejects.toThrow("unknown");
  expect(next.on.presses + next.off.presses).toBe(0);
});

test("a direct successful button press survives restart with its original command time", async () => {
  const file = path(), first = open(file);
  await first.on.press();
  await first.off.press();
  first.close();
  const next = open(file, undefined, undefined, "on");
  expect((await next.device.describe()).state).toEqual({ availability: "online", value: "off", stateSource: "commanded", commandedAt: AT });
  expect(next.on.presses + next.off.presses).toBe(0);
});

test("failed commands preserve the last successful command across restart", async () => {
  const file = path(), first = open(file);
  await first.device.turnOn();
  first.off.fail = true;
  await expect(first.device.turnOff()).rejects.toThrow("send failed");
  first.close();
  expect(await open(file).device.getState()).toBe("on");
});

test("a candidate mapping does not mutate active state, and a command replaces the remembered mapping", async () => {
  const file = path(), active = open(file);
  await active.on.press();
  const candidate = new OptimisticButtonSwitch("lamp", new TestButton("other-on"), new TestButton("other-off"), active.store, () => "online", "off");
  expect((await candidate.describe()).state.stateSource).toBe("assumed");
  expect(active.store.forSwitch("lamp", "other-on", "other-off").get()).toBeUndefined();
  expect(await active.device.getState()).toBe("on");
  candidate.close();
  active.close();
  const reopened = open(file);
  expect(await reopened.device.getState()).toBe("on");
  const changed = new OptimisticButtonSwitch("lamp", new TestButton("other-on"), new TestButton("other-off"), reopened.store, () => "online");
  await expect(changed.getState()).rejects.toThrow("unknown");
  await changed.turnOff();
  expect(await changed.getState()).toBe("off");
  expect(reopened.store.forSwitch("lamp", "on", "off").get()).toBeUndefined();
  changed.close();
  reopened.close();
  const final = open(file, new TestButton("other-on"), new TestButton("other-off"));
  expect(await final.device.getState()).toBe("off");
  expect(final.store.forSwitch("lamp", "on", "off").get()).toBeUndefined();
});

test("a successful command remains current in memory if persistence fails", async () => {
  const file = path(), active = open(file);
  await active.device.turnOff();
  active.store.close();
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await active.on.press();
    expect(await active.device.getState()).toBe("on");
    expect(warning).toHaveBeenCalledWith(JSON.stringify({ event: "optimistic_switch_state_save_failed", id: "lamp" }));
  } finally { warning.mockRestore(); }
});
