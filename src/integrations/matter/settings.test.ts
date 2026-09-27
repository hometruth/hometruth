import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileMatterSettingsSource } from "./settings";

const directories = new Set<string>();

async function temporaryStorage(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hometruth-matter-settings-"));
  directories.add(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of directories) {
    await rm(directory, { recursive: true, force: true });
    directories.delete(directory);
  }
});

describe("FileMatterSettingsSource", () => {
  test("returns no bridge settings before the bridge has created its status", async () => {
    expect(await new FileMatterSettingsSource(await temporaryStorage()).read()).toBeUndefined();
  });

  test("reads the switch inventory and embeds the private pairing image", async () => {
    const directory = await temporaryStorage();
    await writeFile(join(directory, "status.json"), JSON.stringify({
      running: true,
      pid: process.pid,
      commissioned: false,
      updatedAt: "2026-09-08T20:00:00.000Z",
      manualPairingCode: "12345678901",
      switches: [{ id: "gate-relay" }, { id: "candles" }],
    }));
    await writeFile(join(directory, "pairing.png"), new Uint8Array([1, 2, 3]));
    await writeFile(join(directory, "bridge.pid"), String(process.pid));

    expect(await new FileMatterSettingsSource(directory).read()).toEqual({
      running: true,
      commissioned: false,
      updatedAt: "2026-09-08T20:00:00.000Z",
      manualPairingCode: "12345678901",
      switchIds: ["gate-relay", "candles"],
      qrCodeDataUrl: "data:image/png;base64,AQID",
    });
  });

  test("rejects malformed bridge status instead of rendering untrusted fields", async () => {
    const directory = await temporaryStorage();
    await writeFile(join(directory, "status.json"), JSON.stringify({ running: "yes", switches: [] }));
    await expect(new FileMatterSettingsSource(directory).read()).rejects.toThrow("invalid");
  });

  test("a saved running status is stopped when its process lock is gone", async () => {
    const directory = await temporaryStorage();
    await writeFile(join(directory, "status.json"), JSON.stringify({ running: true, pid: process.pid, commissioned: true, switches: [] }));
    expect((await new FileMatterSettingsSource(directory).read())?.running).toBe(false);
  });

  test("a different process owning the lock cannot make an old status look live", async () => {
    const directory = await temporaryStorage();
    await writeFile(join(directory, "status.json"), JSON.stringify({ running: true, pid: process.pid + 1, commissioned: true, switches: [] }));
    await writeFile(join(directory, "bridge.pid"), String(process.pid));
    expect((await new FileMatterSettingsSource(directory).read())?.running).toBe(false);
  });
});
