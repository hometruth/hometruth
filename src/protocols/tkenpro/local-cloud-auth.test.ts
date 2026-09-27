import { describe, expect, test } from "bun:test";
import { mkdtemp, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MeariLocalCloudAuthStore,
  createMeariRegistrationAuthorizer,
  type MeariLocalCameraAuthorization,
} from "./local-cloud-auth.ts";

const authorization: MeariLocalCameraAuthorization = {
  uuid: "0123456789abcdef",
  registrationPasswordSha256: "2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b",
  sourceAddress: "192.0.2.10",
  clientId: "camera-model",
  peer: {
    hostKey: "0123456789abcdef0123456789abcdef",
    protocolVersion: 2,
    licenceId: "00000000000100000001",
    clientUuid: "fedcba9876543210",
  },
  capabilityFlags: { bowl: 0, pet: 1, pfp: 1, pms: 1, ptz2: 3 },
};

describe("Meari local cloud authorization", () => {
  test("authenticates the exact camera identity and proof", () => {
    const authorize = createMeariRegistrationAuthorizer([authorization]);
    const base = {
      uuid: authorization.uuid,
      password: "secret",
      clientId: "camera-model",
      version: 15_213,
      runtime: 1,
      remoteAddress: "192.0.2.10",
    };
    expect(authorize(base)).toBe(true);
    expect(authorize({ ...base, password: "wrong" })).toBe(false);
    expect(authorize({ ...base, uuid: "different" })).toBe(false);
    expect(authorize({ ...base, remoteAddress: "192.0.2.11" })).toBe(false);
  });

  test("round-trips a permission-restricted authorization file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hometruth-auth-test-"));
    const path = join(directory, "private", "auth.json");
    const store = new MeariLocalCloudAuthStore(path);
    await store.save([authorization]);
    expect(await store.load()).toEqual({ version: 2, devices: [authorization] });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, "private"))).mode & 0o777).toBe(0o700);
  });

  test("loads and upgrades a version-one authorization document", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hometruth-auth-v1-test-"));
    const path = join(directory, "auth.json");
    await Bun.write(path, JSON.stringify({
      version: 1,
      devices: [{
        uuid: authorization.uuid,
        registrationPasswordSha256: authorization.registrationPasswordSha256,
      }],
    }));
    const loaded = await new MeariLocalCloudAuthStore(path).load();
    expect(loaded.version).toBe(2);
    expect(loaded.devices[0]?.peer).toBeUndefined();
  });
});
