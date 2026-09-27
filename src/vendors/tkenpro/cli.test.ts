import { describe, expect, test } from "bun:test";
import { runCli, type CliDependencies } from "./cli.ts";
import type { OnvifClientConfig, OnvifProfile } from "../../protocols/onvif/client";
import type { MeariClientConfig } from "../../protocols/tkenpro/types.ts";

function outputCapture(): { readonly write: (text: string) => void; readonly text: () => string } {
  let value = "";
  return {
    write(text) {
      value += text;
    },
    text() {
      return value;
    },
  };
}

function profile(overrides: Partial<OnvifProfile> = {}): OnvifProfile {
  return {
    token: "profile-main",
    name: "Main",
    videoSourceConfigurationToken: "video-source",
    ptzConfigurationToken: "ptz-config",
    rawXml: "<secret-vendor-xml/>",
    ...overrides,
  };
}

function onvifFactory(overrides: Record<string, unknown> = {}): NonNullable<CliDependencies["createOnvifClient"]> {
  return (_config: OnvifClientConfig) => ({
    serviceUrls: { device: "http://10.78.0.147:8000/onvif/device_service" },
    async getDeviceInformation() {
      return { manufacturer: "Meari", model: "Pet 3T", firmwareVersion: "5.7.3", serialNumber: "100000001", hardwareId: "pet3t" };
    },
    async getCapabilities() {
      return { media: "http://10.78.0.147:8000/onvif/media_service", rawXml: "<capabilities/>" };
    },
    async getProfiles() {
      return [profile()];
    },
    async getStreamUri() {
      return { uri: "rtsp://10.78.0.147:8554/profile0" };
    },
    async getSnapshotUri() {
      return { uri: "http://10.78.0.147/snapshot.jpg" };
    },
    async continuousMove() {},
    async stop() {},
    async gotoHomePosition() {},
    ...overrides,
  });
}

function cloudFactory(overrides: Record<string, unknown> = {}): NonNullable<CliDependencies["createCloudClient"]> {
  return (_config: MeariClientConfig) => ({
    async login() {
      return {
        devices: [{
          snNum: "ppsl0000000100000001",
          deviceName: "Pet 3T",
          deviceID: "device-1",
          deviceSignature: "must-not-print",
          _category: "ipc",
        }],
      };
    },
    async getDeviceStatus() {
      return "online";
    },
    async getAllIotValues() {
      return {};
    },
    async getIotValues() {
      return {};
    },
    async configureOnvif() {
      return {};
    },
    async setControl() {
      return {};
    },
    ...overrides,
  });
}

const cloudEnvironment = {
  TKENPRO_EMAIL: "owner@example.test",
  TKENPRO_PASSWORD: "app-password-secret",
};

describe("TKENPRO CLI", () => {
  test("discovers explicit private hosts and CIDRs without credentials", async () => {
    const stdout = outputCapture();
    let received: unknown;
    const code = await runCli([
      "discover", "--host", "10.78.0.147", "--cidr", "10.78.0.0/24", "--timeout-ms", "900", "--json",
    ], {
      env: {},
      stdout: stdout.write,
      async discover(options) {
        received = options;
        return { cameras: [{ id: "camera", host: "10.78.0.147", sources: [], types: [], scopes: [], locations: [], onvifEndpoints: [], openPorts: [8000] }], errors: [], elapsedMs: 5 };
      },
    });

    expect(code).toBe(0);
    expect(received).toMatchObject({
      hosts: ["10.78.0.147"],
      cidrs: ["10.78.0.0/24"],
      multicastTimeoutMs: 900,
      probeTimeoutMs: 900,
    });
    expect(JSON.parse(stdout.text())).toMatchObject({ cameras: [{ host: "10.78.0.147" }] });
  });

  test("returns direct ONVIF information without raw XML or URL credentials", async () => {
    const stdout = outputCapture();
    const code = await runCli(["info", "--host", "10.78.0.147", "--json"], {
      env: { ONVIF_PASSWORD: "camera-password-secret" },
      stdout: stdout.write,
      createOnvifClient: onvifFactory({
        serviceUrls: { media: "http://admin:camera-password-secret@10.78.0.147:8000/onvif/media_service" },
        async getCapabilities() {
          return {
            media: "http://admin:camera-password-secret@10.78.0.147:8000/onvif/media_service",
            rawXml: "<secret-capabilities-xml/>",
          };
        },
      }),
    });

    expect(code).toBe(0);
    expect(stdout.text()).toContain("Pet 3T");
    expect(stdout.text()).not.toContain("camera-password-secret");
    expect(stdout.text()).not.toContain("secret-capabilities-xml");
    expect(stdout.text()).not.toContain("secret-vendor-xml");
  });

  test("lists the complete control catalog and destructive confirmation literals", async () => {
    const stdout = outputCapture();
    const code = await runCli(["controls", "--json"], { stdout: stdout.write });

    expect(code).toBe(0);
    const result = JSON.parse(stdout.text()) as { count: number; controls: Array<Record<string, unknown>> };
    expect(result.count).toBeGreaterThanOrEqual(100);
    expect(result.controls.find((control) => control.id === "formatStorage")).toMatchObject({
      safety: "destructive",
      confirmation: "FORMAT_STORAGE",
    });
  });

  test("rejects command-line passwords before connecting", async () => {
    const stderr = outputCapture();
    let connected = false;
    const code = await runCli(["status", "--password", "leaky-value"], {
      env: cloudEnvironment,
      stderr: stderr.write,
      createCloudClient: (config) => {
        connected = true;
        return cloudFactory()(config);
      },
    });

    expect(code).toBe(2);
    expect(connected).toBeFalse();
    expect(stderr.text()).toContain("command-line secrets can leak");
    expect(stderr.text()).not.toContain("leaky-value");
  });

  test("requires exact confirmations before caution or destructive controls connect", async () => {
    const cautionError = outputCapture();
    const destructiveError = outputCapture();
    let connections = 0;
    const createCloudClient: NonNullable<CliDependencies["createCloudClient"]> = (config) => {
      connections += 1;
      return cloudFactory()(config);
    };

    const cautionCode = await runCli(["set", "feed", "1"], {
      env: cloudEnvironment,
      stderr: cautionError.write,
      createCloudClient,
    });
    const destructiveCode = await runCli(["set", "formatStorage", "{}", "--confirm", "formatStorage"], {
      env: cloudEnvironment,
      stderr: destructiveError.write,
      createCloudClient,
    });

    expect(cautionCode).toBe(2);
    expect(cautionError.text()).toContain("--confirm feed");
    expect(destructiveCode).toBe(2);
    expect(destructiveError.text()).toContain("--confirm FORMAT_STORAGE");
    expect(connections).toBe(0);
  });

  test("passes the registered destructive literal through to the library", async () => {
    const stdout = outputCapture();
    let write: { controlId: string; value: unknown; confirmation: unknown } | undefined;
    const code = await runCli([
      "set", "formatStorage", "{}", "--confirm", "FORMAT_STORAGE", "--json",
    ], {
      env: cloudEnvironment,
      stdout: stdout.write,
      createCloudClient: cloudFactory({
        async setControl(_serial: string, controlId: string, value: unknown, options: { confirmation?: unknown }) {
          write = { controlId, value, confirmation: options.confirmation };
          return {};
        },
      }),
    });

    expect(code).toBe(0);
    expect(write).toEqual({ controlId: "formatStorage", value: {}, confirmation: "FORMAT_STORAGE" });
    expect(stdout.text()).not.toContain("app-password-secret");
  });

  test("enables ONVIF with the paired camera password operation", async () => {
    const stdout = outputCapture();
    let configuration: { enabled: boolean; password: string } | undefined;
    const code = await runCli([
      "set", "onvif", "true", "--confirm", "onvif", "--camera-password-env", "LOCAL_CAMERA_CREDENTIAL", "--json",
    ], {
      env: { ...cloudEnvironment, LOCAL_CAMERA_CREDENTIAL: "local-camera-secret" },
      stdout: stdout.write,
      createCloudClient: cloudFactory({
        async configureOnvif(_serial: string, value: { enabled: boolean; password: string }) {
          configuration = value;
          return {};
        },
      }),
    });

    expect(code).toBe(0);
    expect(configuration).toEqual({ enabled: true, password: "local-camera-secret" });
    expect(stdout.text()).not.toContain("local-camera-secret");
  });

  test("redacts secrets stored under custom environment variable names", async () => {
    const stderr = outputCapture();
    const code = await runCli([
      "status", "--app-password-env", "CUSTOM_CREDENTIAL", "--json",
    ], {
      env: { TKENPRO_EMAIL: "owner@example.test", CUSTOM_CREDENTIAL: "custom-app-secret" },
      stderr: stderr.write,
      createCloudClient: cloudFactory({
        async login() {
          throw new Error("vendor echoed custom-app-secret");
        },
      }),
    });

    expect(code).toBe(1);
    expect(stderr.text()).not.toContain("custom-app-secret");
    expect(stderr.text()).toContain("[redacted]");
  });

  test("redacts camera credentials from media URLs", async () => {
    const stdout = outputCapture();
    const code = await runCli(["media", "--host", "10.78.0.147", "--json"], {
      env: { ONVIF_PASSWORD: "camera-password-secret" },
      stdout: stdout.write,
      createOnvifClient: onvifFactory({
        async getStreamUri() {
          return { uri: "rtsp://admin:camera-password-secret@10.78.0.147:8554/profile0" };
        },
        async getSnapshotUri() {
          return { uri: "http://admin:camera-password-secret@10.78.0.147/snapshot.jpg" };
        },
      }),
    });

    expect(code).toBe(0);
    expect(stdout.text()).not.toContain("camera-password-secret");
    expect(stdout.text()).toContain("redacted");
    expect(stdout.text()).not.toContain("secret-vendor-xml");
  });

  test("redacts ONVIF password data points and nested credential fields", async () => {
    const stdout = outputCapture();
    const code = await runCli(["get", "--json"], {
      env: cloudEnvironment,
      stdout: stdout.write,
      createCloudClient: cloudFactory({
        async getAllIotValues() {
          return {
            "122": "Y2FtZXJhLXBhc3N3b3Jk",
            "123": "rtsp://admin:camera-password-secret@10.78.0.147:8554/profile0",
            "999": { password: "nested-secret", enabled: true },
          };
        },
      }),
    });

    expect(code).toBe(0);
    expect(stdout.text()).not.toContain("Y2FtZXJhLXBhc3N3b3Jk");
    expect(stdout.text()).not.toContain("camera-password-secret");
    expect(stdout.text()).not.toContain("nested-secret");
    expect(stdout.text()).toContain("[redacted]");
  });

  test("accepts a local nine-digit serial when selecting a cloud camera", async () => {
    const stdout = outputCapture();
    const code = await runCli(["status", "--serial", "100000001", "--json"], {
      env: cloudEnvironment,
      stdout: stdout.write,
      createCloudClient: cloudFactory(),
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout.text())).toMatchObject({
      device: { serialNumber: "ppsl0000000100000001" },
      status: "online",
    });
    expect(stdout.text()).not.toContain("must-not-print");
    expect(stdout.text()).not.toContain("app-password-secret");
  });

  test("matches a nine-digit hardware ID stored as the CloudEdge device name", async () => {
    const stdout = outputCapture();
    let statusSerial = "";
    const code = await runCli(["status", "--serial", "100000001", "--json"], {
      env: cloudEnvironment,
      stdout: stdout.write,
      createCloudClient: cloudFactory({
        async login() {
          return {
            devices: [{
              snNum: "ppsc455e451302b64366947d44f2afef93ee",
              deviceName: "100000001",
              deviceID: "opaque-device",
              _category: "ipc",
            }],
          };
        },
        async getDeviceStatus(serial: string) {
          statusSerial = serial;
          return "online";
        },
      }),
    });

    expect(code).toBe(0);
    expect(statusSerial).toBe("ppsc455e451302b64366947d44f2afef93ee");
    expect(JSON.parse(stdout.text())).toMatchObject({
      device: {
        serialNumber: "ppsc455e451302b64366947d44f2afef93ee",
        name: "100000001",
      },
      status: "online",
    });
  });

  test("does not fuzzy-match a nine-digit ID embedded in a friendly device name", async () => {
    const stderr = outputCapture();
    const code = await runCli(["status", "--serial", "100000001"], {
      env: cloudEnvironment,
      stderr: stderr.write,
      createCloudClient: cloudFactory({
        async login() {
          return {
            devices: [{
              snNum: "ppsc455e451302b64366947d44f2afef93ee",
              deviceName: "Pet 100000001",
              _category: "ipc",
            }],
          };
        },
      }),
    });

    expect(code).toBe(2);
    expect(stderr.text()).toContain("was not found");
  });

  test("always stops a leased PTZ movement when waiting fails", async () => {
    const stderr = outputCapture();
    let moves = 0;
    let stops = 0;
    const code = await runCli([
      "ptz", "left", "--host", "10.78.0.147", "--duration-ms", "250",
    ], {
      env: { ONVIF_PASSWORD: "camera-password-secret" },
      stderr: stderr.write,
      createOnvifClient: onvifFactory({
        async continuousMove() {
          moves += 1;
        },
        async stop() {
          stops += 1;
        },
      }),
      async sleep() {
        throw new Error("timer failed");
      },
    });

    expect(code).toBe(1);
    expect(moves).toBe(1);
    expect(stops).toBe(1);
    expect(stderr.text()).toContain("timer failed");
    expect(stderr.text()).not.toContain("camera-password-secret");
  });

  test("refuses to overwrite snapshots without --force", async () => {
    const stderr = outputCapture();
    let wrote = false;
    const code = await runCli([
      "snapshot", "--host", "10.78.0.147", "--output", "existing.jpg",
    ], {
      env: { ONVIF_PASSWORD: "camera-password-secret" },
      stderr: stderr.write,
      cwd: "/tmp/tkenpro-cli-test",
      createOnvifClient: onvifFactory(),
      async fileExists() {
        return true;
      },
      async writeFile() {
        wrote = true;
        return 1;
      },
    });

    expect(code).toBe(2);
    expect(wrote).toBeFalse();
    expect(stderr.text()).toContain("--force");
  });

  test("captures a snapshot with credentials kept out of output", async () => {
    const stdout = outputCapture();
    let captureSource: unknown;
    let writtenPath = "";
    const code = await runCli([
      "snapshot", "--host", "10.78.0.147", "--output", "snapshot.jpg", "--force", "--json",
    ], {
      env: { ONVIF_PASSWORD: "camera-password-secret" },
      stdout: stdout.write,
      cwd: "/tmp/tkenpro-cli-test",
      createOnvifClient: onvifFactory(),
      async fileExists() {
        return true;
      },
      async captureSnapshot(source) {
        captureSource = source;
        return new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
      },
      async writeFile(path, bytes) {
        writtenPath = path;
        return bytes.byteLength;
      },
    });

    expect(code).toBe(0);
    expect(captureSource).toMatchObject({
      streamUri: "rtsp://10.78.0.147:8554/profile0",
      username: "admin",
      password: "camera-password-secret",
    });
    expect(writtenPath).toBe("/tmp/tkenpro-cli-test/snapshot.jpg");
    expect(stdout.text()).not.toContain("camera-password-secret");
    expect(JSON.parse(stdout.text())).toMatchObject({ bytes: 4, profile: "profile-main" });
  });
});
