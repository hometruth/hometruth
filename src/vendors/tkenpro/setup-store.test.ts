import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CameraSetupStoreError,
  EnvCameraSetupStore,
  FileCameraSetupStore,
  LayeredCameraSetupStore,
  type SavedCameraConfiguration,
} from "./setup-store";

const configuration: SavedCameraConfiguration = {
  setup: {
    profile: "cloudedge",
    countryCode: "US",
    email: "owner@example.com",
    password: "p@ss word $1",
    onvifUsername: "admin",
    onvifPassword: "on'vif",
  },
  selectedDeviceId: "100000001",
};

const directories: string[] = [];
async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hometruth-setup-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("FileCameraSetupStore", () => {
  test("saves a private JSON file with exact secrets and the selected camera, never a camera address", async () => {
    const directory = await scratch();
    const store = new FileCameraSetupStore(join(directory, "nested", "camera-setup.json"));
    await store.save({ ...configuration, cameraHost: "10.78.0.64" });
    const mode = (await stat(store.path)).mode & 0o777;
    expect(mode).toBe(0o600);
    const document = JSON.parse(await readFile(store.path, "utf8")) as Record<string, unknown>;
    expect(document.version).toBe(1);
    expect(document.setup).toEqual(configuration.setup);
    expect(document.selectedDeviceId).toBe("100000001");
    expect(JSON.stringify(document)).not.toContain("10.78.0.64");
    expect(await store.load()).toEqual(configuration);
  });

  test("clear removes the file and load then reports nothing saved", async () => {
    const directory = await scratch();
    const store = new FileCameraSetupStore(join(directory, "camera-setup.json"));
    await store.save(configuration);
    await store.clear();
    expect(await store.load()).toBeUndefined();
    await store.clear(); // idempotent
  });

  test("rejects corrupt or foreign files without leaking values", async () => {
    const directory = await scratch();
    const path = join(directory, "camera-setup.json");
    await writeFile(path, "{not json", "utf8");
    await expect(new FileCameraSetupStore(path).load()).rejects.toThrow(CameraSetupStoreError);
    await writeFile(path, JSON.stringify({ version: 2, setup: {} }), "utf8");
    await expect(new FileCameraSetupStore(path).load()).rejects.toThrow("unsupported format");
  });

  test("refuses a symbolic link", async () => {
    const directory = await scratch();
    const target = join(directory, "real.json");
    await writeFile(target, JSON.stringify({ version: 1, setup: configuration.setup }), "utf8");
    const link = join(directory, "camera-setup.json");
    await symlink(target, link);
    await expect(new FileCameraSetupStore(link).load()).rejects.toThrow("symbolic link");
  });
});

describe("EnvCameraSetupStore", () => {
  test("reads the operator's environment and never writes .env.local", async () => {
    const directory = await scratch();
    const envFile = join(directory, ".env.local");
    const before = "UNIFI_API_KEY='keep-me'\nTKENPRO_EMAIL=owner@example.com\nTKENPRO_PASSWORD='secret'\n";
    await writeFile(envFile, before, "utf8");
    const env: Record<string, string | undefined> = {
      UNIFI_API_KEY: "keep-me",
      TKENPRO_EMAIL: "owner@example.com",
      TKENPRO_PASSWORD: "secret",
      TKENPRO_CAMERA_HOST: "10.78.0.64",
      TKENPRO_SERIAL: "100000002",
    };
    const store = new EnvCameraSetupStore({ env });
    const loaded = await store.load();
    expect(loaded?.setup.email).toBe("owner@example.com");
    expect(loaded?.setup.password).toBe("secret");
    expect(loaded?.cameraHost).toBe("10.78.0.64");
    expect(loaded?.selectedDeviceId).toBe("100000002");

    await store.save(configuration);
    await store.clear();
    expect(await readFile(envFile, "utf8")).toBe(before);
    expect(env.UNIFI_API_KEY).toBe("keep-me");
    expect(env.TKENPRO_PASSWORD).toBeUndefined();
  });

  test("validates environment pairs without including secret values in errors", async () => {
    const env = { TKENPRO_EMAIL: "owner@example.com" };
    await expect(new EnvCameraSetupStore({ env }).load()).rejects.toThrow(
      "Camera environment must include both TKENPRO_EMAIL and TKENPRO_PASSWORD",
    );
  });
});

describe("LayeredCameraSetupStore", () => {
  test("prefers the JSON file, falls back to the environment, and writes only the file", async () => {
    const directory = await scratch();
    const file = new FileCameraSetupStore(join(directory, "camera-setup.json"));
    const env: Record<string, string | undefined> = {
      TKENPRO_EMAIL: "env@example.com",
      TKENPRO_PASSWORD: "env-secret",
      UNIFI_API_KEY: "keep-me",
    };
    const store = new LayeredCameraSetupStore(file, new EnvCameraSetupStore({ env }));
    expect((await store.load())?.setup.email).toBe("env@example.com");
    await store.save(configuration);
    expect((await store.load())?.setup.email).toBe("owner@example.com");
    expect((await file.load())?.setup.email).toBe("owner@example.com");
    expect(env.UNIFI_API_KEY).toBe("keep-me");
    await store.clear();
    expect(await file.load()).toBeUndefined();
    expect(await store.load()).toBeUndefined();
  });
});
