import { networkEnvironment } from "../../network/config";
import { describe, expect, test } from "bun:test";
import { MemorySecretStore, secretPaths, secretsFor } from "../../config/secrets";
import { parseDevicesConfig } from "../../config/devices";
import type { CameraSetupStore } from "./setup-store";
import { SecretsCameraSetupStore, accountFromSecrets, hostCredentialsSaver, importLegacySecrets } from "./secrets";

const config = parseDevicesConfig(`
schemaVersion: 2
devices:
  - id: cam-a
    model: tkenpro-2k-pet-camera-treat-dispenser
    config: { host: 10.78.0.147 }
  - id: cam-b
    model: tkenpro-2k-pet-camera-treat-dispenser
    config: { host: 10.78.0.64 }
  - id: relay
    model: shelly-plus-1
    config: { host: 10.77.0.228 }
`);

const legacy: CameraSetupStore = {
  async load() {
    return { setup: { profile: "cloudedge", email: "owner@example.com", password: "pw", onvifUsername: "admin", onvifPassword: "admin" } };
  },
  async save() {},
  async clear() {},
};

describe("TKENPRO secrets", () => {
  test("imports the account, one ONVIF login per configured camera, and the router key, once", async () => {
    const store = new MemorySecretStore();
    const written = await importLegacySecrets(store, config, { env: { UNIFI_API_KEY: "key", UNIFI_SKIP_TLS_VERIFY: "1" }, legacy });
    expect(written).toEqual([
      "vendors.tkenpro.account.profile",
      "vendors.tkenpro.account.email",
      "vendors.tkenpro.account.password",
      "devices.cam-a.onvif.username",
      "devices.cam-a.onvif.password",
      "devices.cam-b.onvif.username",
      "devices.cam-b.onvif.password",
      "network.unifi.apiKey",
      "network.unifi.skipTlsVerify",
    ]);
    const file = await store.load();
    expect(secretsFor(file, "devices", "relay")).toEqual({});
    expect(accountFromSecrets(file)).toEqual({ profile: "cloudedge", email: "owner@example.com", password: "pw" });
    expect(networkEnvironment(file, { PATH: "/bin" })).toEqual({ PATH: "/bin", UNIFI_API_KEY: "key", UNIFI_SKIP_TLS_VERIFY: "1" });
    // A second import changes nothing and keeps a rotated value.
    await store.save({ ...file, network: { unifi: { apiKey: "rotated" } } });
    expect(await importLegacySecrets(store, config, { env: { UNIFI_API_KEY: "key" }, legacy })).toEqual([]);
    expect(secretsFor(await store.load(), "network", "unifi").apiKey).toBe("rotated");
  });

  test("the setup store reads and writes only the account, never ONVIF fields", async () => {
    const store = new MemorySecretStore();
    const setup = new SecretsCameraSetupStore(store);
    expect(await setup.load()).toBeUndefined();
    await setup.save({ setup: { profile: "tkenpro", email: "a@b.c", password: "pw", countryCode: "US", onvifUsername: "admin", onvifPassword: "admin" } });
    expect(secretPaths(await store.load())).toEqual([
      "vendors.tkenpro.account.countryCode",
      "vendors.tkenpro.account.email",
      "vendors.tkenpro.account.password",
      "vendors.tkenpro.account.profile",
    ]);
    expect((await setup.load())?.setup).toEqual({ profile: "tkenpro", email: "a@b.c", password: "pw", countryCode: "US" });
    await setup.clear();
    expect(await setup.load()).toBeUndefined();
    expect(secretPaths(await store.load())).toEqual([]);
  });

  test("ONVIF credentials from the form land under the camera configured at that address", async () => {
    const store = new MemorySecretStore();
    const save = hostCredentialsSaver(store, config);
    await save("10.78.0.64", { username: "admin", password: "new" });
    expect(secretsFor(await store.load(), "devices", "cam-b")).toEqual({ onvif: { username: "admin", password: "new" } });
    await expect(save("10.78.0.99", { username: "a", password: "b" })).rejects.toThrow(/No camera at 10\.78\.0\.99/u);
  });
});
