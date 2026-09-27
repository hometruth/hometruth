import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeariLocalCloudAuthStore } from "./local-cloud-auth.ts";
import { MeariLocalCloudRuntime } from "./local-cloud-runtime.ts";
import { MeariLocalCloudStateStore } from "./local-cloud-state.ts";

describe("Meari local cloud runtime state", () => {
  test("loads authorized cached state and persists camera updates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hometruth-runtime-state-test-"));
    const authPath = join(directory, "auth.json");
    const statePath = join(directory, "state.json");
    const uuid = "camera-1";
    await new MeariLocalCloudAuthStore(authPath).save([{
      uuid,
      registrationPasswordSha256: createHash("sha256").update("secret").digest("hex"),
      sourceAddress: "192.0.2.10",
    }]);
    await new MeariLocalCloudStateStore(statePath).save(new Map([
      [uuid, { "103": 1 }],
      ["not-authorized", { "103": 0 }],
    ]));

    const runtime = await MeariLocalCloudRuntime.create({
      authPath,
      statePath,
      advertisedHost: "192.0.2.20",
    });
    expect(runtime.emulator.getDeviceState(uuid)).toEqual({ "103": 1 });
    expect(runtime.emulator.getDeviceState("not-authorized")).toEqual({});

    runtime.emulator.mergeState(uuid, { "103": 0, "122": "not-saved", "246": "not-saved" }, "sync");
    await runtime.stop();
    expect(await new MeariLocalCloudStateStore(statePath).load()).toEqual(new Map([
      [uuid, { "103": 0 }],
    ]));
  });
});
