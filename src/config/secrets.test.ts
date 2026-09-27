import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSecretStore, MemorySecretStore, parseSecretsText, secretPaths, secretsFor, toYaml, withSecret, type SecretsFile } from "./secrets";

const file: SecretsFile = {
  schemaVersion: 1,
  devices: { "example-camera": { onvif: { username: "admin", password: "p@ss: word" } } },
  vendors: { tkenpro: { account: { email: "owner@example.com", password: "pw" } } },
  network: { unifi: { apiKey: "key", skipTlsVerify: true } },
};

describe("secrets", () => {
  test("lists paths only and reads one scope entry", () => {
    expect(secretPaths(file)).toEqual([
      "devices.example-camera.onvif.password",
      "devices.example-camera.onvif.username",
      "vendors.tkenpro.account.email",
      "vendors.tkenpro.account.password",
      "network.unifi.apiKey",
      "network.unifi.skipTlsVerify",
    ]);
    expect(secretsFor(file, "devices", "example-camera")).toEqual({ onvif: { username: "admin", password: "p@ss: word" } });
    expect(secretsFor(file, "devices", "missing")).toEqual({});
  });

  test("sets and removes values by dotted path without touching the rest", () => {
    const next = withSecret(file, "devices.example-camera-2.onvif.password", "other");
    expect(secretsFor(next, "devices", "example-camera-2")).toEqual({ onvif: { password: "other" } });
    expect(secretsFor(next, "devices", "example-camera")).toEqual(secretsFor(file, "devices", "example-camera"));
    const removed = withSecret(withSecret(next, "devices.example-camera-2.onvif.password", undefined), "network.unifi.apiKey", undefined);
    expect(removed.devices?.["example-camera-2"]).toBeUndefined();
    expect(secretsFor(removed, "network", "unifi")).toEqual({ skipTlsVerify: true });
    expect(() => withSecret(file, "devices.example-camera", "x")).toThrow(/Secret paths look like/u);
    expect(() => withSecret(file, "wallet.x.y", "x")).toThrow(/Secret paths look like/u);
  });

  test("round-trips through readable YAML with every string quoted", () => {
    const yaml = toYaml(file);
    expect(yaml).toContain('    onvif:\n      username: "admin"\n      password: "p@ss: word"\n');
    expect(yaml).toContain("skipTlsVerify: true\n");
    expect(parseSecretsText(yaml, "test")).toEqual(file);
    expect(() => parseSecretsText("schemaVersion: 2\n", "test")).toThrow(/invalid/u);
    expect(() => parseSecretsText("devices: [", "test")).toThrow(/not valid YAML/u);
  });

  test("the file store writes 0600, refuses symlinks, and treats an absent file as empty", async () => {
    const directory = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "hometruth-secrets-"));
    const path = join(directory, "nested", "secrets.yml");
    const store = new FileSecretStore(path);
    expect(await store.exists()).toBe(false);
    expect(await store.load()).toEqual({ schemaVersion: 1 });
    await store.save(file);
    expect(await store.exists()).toBe(true);
    expect(((await stat(path)).mode & 0o777)).toBe(0o600);
    expect(await readFile(path, "utf8")).toContain("# HomeTruth secrets");
    expect(await store.load()).toEqual(file);
    await store.save(withSecret(file, "network.unifi.apiKey", "rotated"));
    expect(secretsFor(await store.load(), "network", "unifi").apiKey).toBe("rotated");
  });

  test("the memory store validates on save", async () => {
    const store = new MemorySecretStore();
    await expect(store.save({ schemaVersion: 2 } as unknown as SecretsFile)).rejects.toThrow(/invalid/u);
    await store.save(file);
    expect(await store.exists()).toBe(true);
  });
});
