import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QUIET_PROFILES, UsbQuietCapture, quietIsActive, validateQuietRequest } from "./quiet-capture";
import { FileNrf24CaptureJournal } from "./capture-journal";
import { Nrf24BridgeClient } from "./client";

test("finite native recorder can use a separate process group from web workers", async () => {
  const child = Bun.spawn(["python3", "-c", "import os; print(os.getsid(0) == os.getpid())"],
    { detached: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  expect((await new Response(child.stdout).text()).trim()).toBe("True");
  expect(await child.exited).toBe(0);
});

test("quiet requests are bounded, explicit and require a condition note", () => {
  for (const profile of QUIET_PROFILES) {
    for (const channel of [null, 5, 40, 75]) for (const durationMs of [10000, 20000] as const) {
      expect(validateQuietRequest({ wifiOff: true, durationMs, channel, note: " car off ", profile }))
        .toEqual({ wifiOff: true, durationMs, channel, note: "car off", profile });
    }
  }
  for (const profile of [undefined, "xn297", "transmit", 3]) {
    expect(() => validateQuietRequest({ wifiOff: true, durationMs: 10000, note: "car off", profile })).toThrow();
  }
  const valid = { wifiOff: true, durationMs: 20000, channel: 40, note: "car off; remote off", profile: "esb-1000" };
  for (const channel of [undefined, -1, 0, 4, 76, 40.5, "40", NaN, Infinity]) {
    expect(() => validateQuietRequest({ ...valid, channel })).toThrow();
  }
  for (const durationMs of [undefined, 0, 1999, 2001, 10001, 30000, 60001, "2000", "20000", Infinity]) {
    expect(() => validateQuietRequest({ ...valid, durationMs })).toThrow();
  }
  for (const input of [null, {}, { wifiOff: true, durationMs: 30000, note: "x" },
    { wifiOff: "true", durationMs: 10000, note: "x" }, { wifiOff: true, durationMs: 10000, note: " " },
    { wifiOff: true, durationMs: 10000, note: "x", transmit: true }]) expect(() => validateQuietRequest(input)).toThrow();
});

test("guided session accepts only its documented capture settings", () => {
  const valid = { session: "tmnt-six-buttons", wifiOff: true, durationMs: 20000,
    channel: 40, profile: "esb-1000", note: "full session" } as const;
  expect(validateQuietRequest(valid)).toEqual(valid);
  for (const patch of [{ session: "unknown" }, { session: null }, { durationMs: 2000 },
    { channel: null }, { channel: 41 }, { wifiOff: false }, { profile: "xn297-1000" }]) {
    expect(() => validateQuietRequest({ ...valid, ...patch })).toThrow();
  }
});

test("USB status survives service replacement and stale jobs are not reported live", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tmnt-usb-test-"));
  try {
    const path = join(directory, "2026.status.json");
    const active = { captureId: "test", phase: "capturing", updatedAt: new Date().toISOString() };
    await writeFile(path, JSON.stringify(active));
    expect(quietIsActive(await new UsbQuietCapture(directory).status())).toBe(true);
    await writeFile(path, JSON.stringify({ ...active, updatedAt: "2020-01-01T00:00:00Z" }));
    expect(await new UsbQuietCapture(directory).status()).toMatchObject({ phase: "failed" });
  } finally { await rm(directory, { recursive: true }); }
});

test("active USB recording suppresses HTTP reads and all transmit/start/stop commands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tmnt-usb-guard-"));
  try {
    const journal = new FileNrf24CaptureJournal("test", "http://radio.local", directory);
    const usb = join(journal.directory, "usb");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(usb, { recursive: true });
    await writeFile(join(usb, "2026.status.json"), JSON.stringify({ captureId: "test", phase: "capturing", updatedAt: new Date().toISOString() }));
    let calls = 0;
    const client = new Nrf24BridgeClient({ baseUrl: "http://radio.local", journal, fetch: async () => { calls++; throw new Error("unexpected HTTP"); } });
    await expect(client.health()).rejects.toThrow("USB capture is active");
    await expect(client.listener()).rejects.toThrow("USB capture is active");
    await expect(client.startListening()).rejects.toThrow("USB capture is active");
    await expect(client.stopListening()).rejects.toThrow("USB capture is active");
    await expect(client.transmit({ channel: 54, dataRateKbps: 1000, address: "AABBCC", addressWidth: 3,
      payloadHex: "01", crcBytes: 2, repeatCount: 1 })).rejects.toThrow("USB capture is active");
    expect(calls).toBe(0);
  } finally { await rm(directory, { recursive: true }); }
});
