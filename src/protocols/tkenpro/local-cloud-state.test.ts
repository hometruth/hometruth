import { describe, expect, test } from "bun:test";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeariLocalCloudStateStore, persistableMeariIotState } from "./local-cloud-state.ts";

describe("Meari local cloud state", () => {
  test("retains controls while removing credentials and network identity", () => {
    expect(persistableMeariIotState({
      "3": "device-secret",
      "56": "00:11:22:33:44:55",
      "103": 1,
      "122": "onvif-secret",
      "123": "rtsp://admin:secret@192.0.2.1/live",
      "126": "192.0.2.1",
      "246": JSON.stringify({ w: { s: "private-network", p: "private-password" } }),
      "999999": "unknown",
    })).toEqual({ "103": 1 });
  });

  test("round-trips a permission-restricted state file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hometruth-state-test-"));
    const path = join(directory, "private", "state.json");
    const store = new MeariLocalCloudStateStore(path);
    expect(await store.load()).toEqual(new Map());
    await store.save(new Map([
      ["camera-1", { "103": 1, "122": "not-saved", "246": "not-saved" }],
    ]));
    expect(await store.load()).toEqual(new Map([
      ["camera-1", { "103": 1 }],
    ]));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, "private"))).mode & 0o777).toBe(0o700);
  });
});
