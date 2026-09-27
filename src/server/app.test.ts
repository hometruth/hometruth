import { describe, expect, test } from "bun:test";
import app, { createApp } from "./app";
import { CameraService } from "../vendors/tkenpro/camera-service";
import type { MeariPeerCommandResponse } from "../protocols/tkenpro/peer-command-session";
import type { CameraNetworkStatusView } from "../ui/dashboard";

function cameraApiFixture() {
  const calls: string[] = [];
  const service = new CameraService({
    async connectCloud() { return { async discover() { return []; } }; },
    async discoverLocal() {
      return [{
        view: {
          id: "pet3t-api",
          name: "Treat Cam",
          status: "online" as const,
          stream: "unknown" as const,
          snapshot: "unknown" as const,
          capabilities: [
            {
              id: "device.statusLed",
              category: "privacy" as const,
              label: "Status LED",
              kind: "toggle" as const,
              availability: "available" as const,
              value: true,
              confirmation: "none" as const,
            },
            {
              id: "video.brightness",
              category: "video" as const,
              label: "Brightness",
              kind: "range" as const,
              availability: "available" as const,
              min: 0,
              max: 100,
              step: 1,
              confirmation: "none" as const,
            },
            {
              id: "camera.ptz",
              category: "movement" as const,
              label: "Move camera",
              kind: "ptz" as const,
              availability: "available" as const,
              confirmation: "none" as const,
            },
            {
              id: "feed.portions",
              category: "feeding" as const,
              label: "Dispense treats",
              kind: "treat" as const,
              availability: "available" as const,
              min: 1,
              max: 10,
              confirmation: "confirm" as const,
            },
            {
              id: "device.wake",
              category: "advanced" as const,
              label: "Wake camera",
              kind: "action" as const,
              availability: "available" as const,
              confirmation: "none" as const,
            },
            {
              id: "audio.talk",
              category: "audio" as const,
              label: "Talk",
              kind: "momentary" as const,
              availability: "available" as const,
              confirmation: "none" as const,
            },
            {
              id: "storage.playback",
              category: "storage" as const,
              label: "Local recordings",
              kind: "status" as const,
              availability: "available" as const,
              readOnly: true,
            },
          ],
        },
        controller: {
          async control(id: string, value: unknown) { calls.push(`control:${id}:${String(value)}`); },
          async ptzStart(direction: string) { calls.push(`start:${direction}`); },
          async ptzStop() { calls.push("stop"); },
          async localCommand(request: { action: string; deviceurl: string }): Promise<MeariPeerCommandResponse> {
            calls.push(`local:${request.action}:${request.deviceurl}`);
            return {
              http: { status: 200, statusText: "OK", bodyText: JSON.stringify({ local: true }) },
            } as unknown as MeariPeerCommandResponse;
          },
          async localIot(values: Record<string, unknown>) {
            calls.push(`iot:${JSON.stringify(values)}`);
            return { sid: "local", cmd: "rsp" };
          },
        },
        talkback: {
          async start() { calls.push("talk:start"); },
          sendPcm(pcm: Int16Array) { calls.push(`talk:audio:${[...pcm].join(",")}`); },
          async stop() { calls.push("talk:stop"); },
        },
        playback: {
          async start(timestamp: string) {
            calls.push(`playback:start:${timestamp}`);
            return new ReadableStream();
          },
          pause() { calls.push("playback:pause"); },
          resume() { calls.push("playback:resume"); },
          seek(timestamp: string) { calls.push(`playback:seek:${timestamp}`); },
          async stop() { calls.push("playback:stop"); },
        },
      }];
    },
  });
  return { app: createApp(service), calls, service };
}

describe("app routes", () => {
  test("returns a healthy, non-cacheable response", async () => {
    const response = await app.request("/api/health");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({ status: "ok", runtime: { name: "bun" } });
  });

  test("rejects data outside the request schema", async () => {
    const response = await app.request("/api/camera/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId: "pet-camera",
        capabilityId: "video.flip",
        value: true,
        extra: true,
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
  });

  test("blocks cross-site and form-style camera changes", async () => {
    const fixture = cameraApiFixture();
    const formPost = await fixture.app.request("/api/camera/discover", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    expect(formPost.status).toBe(415);

    const crossSite = await fixture.app.request("http://hometruth.local/api/camera/discover", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://example.com",
      },
      body: "{}",
    });
    expect(crossSite.status).toBe(403);
    expect(fixture.calls).toEqual([]);
  });

  test("allows camera changes from the stable local Dev Hub origin", async () => {
    const fixture = cameraApiFixture();
    const response = await fixture.app.request("http://127.0.0.1:3000/api/camera/discover", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://hometruth.localhost:43900",
      },
      body: "{}",
    });

    expect(response.status).toBe(200);
    expect(fixture.calls).toEqual([]);
  });

  test("exposes discovery, state, validated controls, and bounded PTZ through Hono", async () => {
    const fixture = cameraApiFixture();
    const discover = await fixture.app.request("/api/camera/discover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(discover.status).toBe(200);
    expect(await discover.json()).toMatchObject({
      ok: true,
      state: { selectedDeviceId: "pet3t-api", discovery: { status: "ready" } },
    });

    const invalidControl = await fixture.app.request("/api/camera/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId: "pet3t-api",
        capabilityId: "video.brightness",
        value: 101,
      }),
    });
    expect(invalidControl.status).toBe(400);
    expect(await invalidControl.json()).toMatchObject({ error: { code: "invalid_control" } });

    const control = await fixture.app.request("/api/camera/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId: "pet3t-api",
        capabilityId: "device.statusLed",
        value: false,
      }),
    });
    expect(control.status).toBe(200);

    const ptz = await fixture.app.request("/api/camera/ptz", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId: "pet3t-api",
        action: "start",
        direction: "right",
        leaseMs: 100,
        commandId: "api-test",
      }),
    });
    expect(ptz.status).toBe(200);

    const wake = await fixture.app.request("/api/camera/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId: "pet3t-api",
        capabilityId: "device.wake",
        value: true,
      }),
    });
    expect(wake.status).toBe(200);
    await Bun.sleep(140);
    expect(fixture.calls).toEqual([
      "control:device.statusLed:false",
      "start:right",
      "control:device.wake:true",
      "stop",
    ]);

    const state = await fixture.app.request("/api/camera/state");
    expect(state.status).toBe(200);
    expect(await state.json()).toMatchObject({
      devices: [expect.objectContaining({ id: "pet3t-api" })],
    });
  });

  test("returns a sanitized media error when no local stream is available", async () => {
    const fixture = cameraApiFixture();
    await fixture.app.request("/api/camera/discover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    const response = await fixture.app.request("/api/camera/devices/pet3t-api/snapshot");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: "not_supported",
        message: "Local video is not available for this camera",
      },
    });
  });

  test("accepts bounded little-endian PCM only while local talkback is active", async () => {
    const fixture = cameraApiFixture();
    await fixture.app.request("/api/camera/discover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const path = "/api/camera/devices/pet3t-api/talkback";
    const start = await fixture.app.request(`${path}/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(start.status).toBe(200);

    const audio = await fixture.app.request(`${path}/audio`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array([1, 0, 254, 255]),
    });
    expect(audio.status).toBe(204);

    const malformed = await fixture.app.request(`${path}/audio`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array([1]),
    });
    expect(malformed.status).toBe(400);

    const stop = await fixture.app.request(`${path}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(stop.status).toBe(200);
    expect(fixture.calls).toEqual(["talk:start", "talk:audio:1,-2", "talk:stop"]);
  });

  test("routes pause, seek, resume, and stop to the active local playback session", async () => {
    const fixture = cameraApiFixture();
    await fixture.app.request("/api/camera/discover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    await fixture.service.startPlayback("pet3t-api", "20260902093000");
    const base = "/api/camera/devices/pet3t-api/playback";
    const send = (path: string, body = "{}") => fixture.app.request(`${base}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    expect((await send("pause")).status).toBe(200);
    expect((await send("seek", JSON.stringify({ timestamp: "20260902094530" }))).status).toBe(200);
    expect((await send("resume")).status).toBe(200);
    expect((await send("stop")).status).toBe(200);
    expect(fixture.calls).toEqual([
      "playback:start:20260902093000",
      "playback:pause",
      "playback:seek:20260902094530",
      "playback:resume",
      "playback:stop",
    ]);
  });

  test("never dispatches treats until the API receives explicit confirmation", async () => {
    const fixture = cameraApiFixture();
    await fixture.app.request("/api/camera/discover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    const unconfirmed = await fixture.app.request("/api/camera/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId: "pet3t-api",
        capabilityId: "feed.portions",
        value: 1,
      }),
    });
    expect(unconfirmed.status).toBe(409);
    expect(await unconfirmed.json()).toMatchObject({
      error: { code: "confirmation_required" },
    });
    expect(fixture.calls).toEqual([]);

    const confirmed = await fixture.app.request("/api/camera/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deviceId: "pet3t-api",
        capabilityId: "feed.portions",
        value: 1,
        confirmed: true,
      }),
    });
    expect(confirmed.status).toBe(200);
    expect(fixture.calls).toEqual(["control:feed.portions:1"]);
  });

  test("exposes recovered common commands locally and guards destructive paths", async () => {
    const fixture = cameraApiFixture();
    await fixture.app.request("/api/camera/discover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    const read = await fixture.app.request("/api/camera/devices/pet3t-api/local-command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "GET",
        deviceurl: "http://127.0.0.1/devices/settings",
      }),
    });
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ ok: true, status: 200, body: { local: true } });

    const blocked = await fixture.app.request("/api/camera/devices/pet3t-api/local-command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "POST",
        deviceurl: "http://127.0.0.1/devices/reboot",
      }),
    });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: { code: "confirmation_required" } });
    expect(fixture.calls).toContain("local:GET:http://127.0.0.1/devices/settings");
    expect(fixture.calls).not.toContain("local:POST:http://127.0.0.1/devices/reboot");
  });

  test("writes raw IoT properties locally and guards destructive codes", async () => {
    const fixture = cameraApiFixture();
    await fixture.app.request("/api/camera/discover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const write = await fixture.app.request("/api/camera/devices/pet3t-api/local-iot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values: { "103": 1, "999999": "future-firmware-property" } }),
    });
    expect(write.status).toBe(200);
    expect(await write.json()).toMatchObject({ ok: true, result: { cmd: "rsp" } });

    const blocked = await fixture.app.request("/api/camera/devices/pet3t-api/local-iot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values: { "800": "1" } }),
    });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: { code: "confirmation_required" } });
    expect(fixture.calls).not.toContain('iot:{"800":"1"}');
  });
});

describe("camera network mode routes", () => {
  function networkFixture() {
    const calls: string[] = [];
    const status: CameraNetworkStatusView = {
      mode: "local",
      dnsOverride: "on",
      domain: "usce.mearicloud.com",
      overrideIp: "10.78.0.231",
      resolvedTo: "10.78.0.231",
      checkedAt: "2026-09-05T03:00:00.000Z",
      canToggle: true,
    };
    let current = status;
    const service = new CameraService({
      async connectCloud() { return { async discover() { return []; } }; },
      async discoverLocal() { return []; },
      networkMode: {
        snapshot() { calls.push("snapshot"); return current; },
        async refresh() { calls.push("refresh"); return current; },
        async set(action) {
          calls.push(`set:${action}`);
          if (action === "fail" as string) throw new Error("boom");
          current = { ...current, mode: action === "on" ? "local" : "cloud", dnsOverride: action, resolvedTo: action === "on" ? "10.78.0.231" : "47.89.182.8" };
          return { message: `${action === "on" ? "enabled" : "disabled"} shared override`, status: current };
        },
      },
    });
    return { app: createApp(service), calls };
  }

  test("GET /api/camera/network re-checks and returns the model with network status", async () => {
    const { app, calls } = networkFixture();
    const response = await app.request("/api/camera/network");
    expect(response.status).toBe(200);
    const body = await response.json() as { network?: { mode: string; dnsOverride: string } };
    expect(body.network?.mode).toBe("local");
    expect(body.network?.dnsOverride).toBe("on");
    expect(calls).toContain("refresh");
  });

  test("POST /api/camera/network/dns-override switches the record and reports UniFi's message", async () => {
    const { app, calls } = networkFixture();
    const response = await app.request("/api/camera/network/dns-override", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "off" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; message?: string; state: { network?: { mode: string } } };
    expect(body.ok).toBe(true);
    expect(body.message).toBe("disabled shared override");
    expect(body.state.network?.mode).toBe("cloud");
    expect(calls).toContain("set:off");
  });

  test("POST /api/camera/network/dns-override rejects an unknown action", async () => {
    const { app } = networkFixture();
    const response = await app.request("/api/camera/network/dns-override", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "maybe" }),
    });
    expect(response.status).toBe(400);
  });

  function reconnectFixture(options: { mode?: "local" | "cloud"; registerAfterMs?: number; alreadyRegistered?: boolean } = {}) {
    const calls: string[] = [];
    let current: CameraNetworkStatusView = {
      mode: options.mode ?? "local",
      dnsOverride: options.mode === "cloud" ? "off" : "on",
      domain: "usce.mearicloud.com",
      overrideIp: "10.78.0.231",
      resolvedTo: options.mode === "cloud" ? "47.89.182.8" : "10.78.0.231",
      checkedAt: "2026-09-05T03:00:00.000Z",
      canToggle: true,
    };
    let registered = options.alreadyRegistered ?? false;
    const service = new CameraService({
      async connectCloud() { return { async discover() { return []; } }; },
      async discoverLocal(request) {
        calls.push(`discover:${(request.hosts ?? []).join(",")}`);
        return [];
      },
      cameraHosts: ["10.78.0.64"],
      networkMode: {
        snapshot() { return current; },
        async refresh() { return current; },
        async set(action) {
          calls.push(`set:${action}`);
          current = { ...current, mode: action === "on" ? "local" : "cloud", dnsOverride: action, resolvedTo: action === "on" ? "10.78.0.231" : "47.89.182.8" };
          return { message: `${action === "on" ? "enabled" : "disabled"} shared override`, status: current };
        },
        async kick(addresses) {
          calls.push(`kick:${addresses.join(",")}`);
          if (options.registerAfterMs !== undefined) setTimeout(() => { registered = true; }, options.registerAfterMs);
          return addresses.map((address) => ({ address, kicked: address === "10.78.0.64", detail: address === "10.78.0.64" ? "kicked pet-cam-white" : `${address} is not associated with the UniFi Wi-Fi right now` }));
        },
      },
      localRegistration: {
        cameraAddresses: ["10.78.0.64", "10.78.0.147"],
        isRegistered(address) { return address === "10.78.0.64" && registered; },
        async waitForEvent(address, kind, timeoutMs) {
          calls.push(`wait:${address}:${kind}:${timeoutMs}`);
          const started = Date.now();
          while (Date.now() - started < Math.min(timeoutMs, 500)) {
            if (registered) return Date.now() - started;
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          return undefined;
        },
      },
    });
    return { app: createApp(service), calls };
  }

  test("POST /api/camera/network/reconnect kicks every known camera and waits for the local registration", async () => {
    const { app, calls } = reconnectFixture({ registerAfterMs: 20 });
    const response = await app.request("/api/camera/network/reconnect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; message?: string };
    expect(body.ok).toBe(true);
    expect(body.message).toContain("10.78.0.64 re-registered with the local emulator");
    expect(body.message).toContain("10.78.0.147 is not associated");
    // The wait is armed before the kick so a fast re-registration is never missed.
    expect(calls.indexOf("wait:10.78.0.64:registered:45000")).toBeLessThan(calls.indexOf("kick:10.78.0.64,10.78.0.147"));
    expect(calls).toContain("discover:10.78.0.64,10.78.0.147");
  });

  test("POST /api/camera/network/reconnect leaves a camera that is already registered locally alone", async () => {
    const { app, calls } = reconnectFixture({ alreadyRegistered: true });
    const response = await app.request("/api/camera/network/reconnect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = await response.json() as { message?: string };
    expect(body.message).toContain("10.78.0.64 is already registered with the local emulator; not kicked");
    // Only the camera that is not registered gets kicked.
    expect(calls).toContain("kick:10.78.0.147");
    expect(calls.some((call) => call.startsWith("kick:10.78.0.64"))).toBe(false);
  });

  test("POST /api/camera/network/reconnect reports a camera that never comes back", async () => {
    const { app } = reconnectFixture();
    const response = await app.request("/api/camera/network/reconnect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { message?: string };
    expect(body.message).toContain("has not re-registered with the local emulator after 45 s");
  });

  test("POST /api/camera/network/reconnect rejects an unknown camera id", async () => {
    const { app } = reconnectFixture();
    const response = await app.request("/api/camera/network/reconnect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: "nope" }),
    });
    expect(response.status).toBe(404);
  });

  test("POST /api/camera/network/dns-override kicks the cameras after switching unless told not to", async () => {
    const { app, calls } = reconnectFixture({ mode: "local", alreadyRegistered: true });
    const response = await app.request("/api/camera/network/dns-override", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "off" }),
    });
    const body = await response.json() as { message?: string };
    expect(body.message).toContain("disabled shared override. ");
    expect(body.message).toContain("re-attaches to the vendor cloud");
    expect(body.message).toContain("10.78.0.147 is not on the local emulator");
    expect(calls).toContain("set:off");
    // Only the camera that was registered locally needs to move.
    expect(calls).toContain("kick:10.78.0.64");

    const quiet = reconnectFixture();
    await quiet.app.request("/api/camera/network/dns-override", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "off", reconnect: false }),
    });
    expect(quiet.calls).toEqual(["set:off"]);
  });

  function rebootFixture(options: { cloudHost?: string; answeringAt?: string; withRecovery?: boolean; registerAfterMs?: number } = {}) {
    const calls: string[] = [];
    let clock = 0;
    let rebootedAtClock: number | undefined;
    let registered = false;
    const network: CameraNetworkStatusView = {
      mode: "local",
      dnsOverride: "on",
      domain: "usce.mearicloud.com",
      overrideIp: "10.78.0.231",
      resolvedTo: "10.78.0.231",
      checkedAt: "2026-09-05T03:00:00.000Z",
      canToggle: true,
    };
    const service = new CameraService({
      async connectCloud() { return { async discover() { return []; } }; },
      async discoverLocal(request) {
        calls.push(`discover:${(request.hosts ?? []).join(",")}`);
        return [];
      },
      cameraHosts: ["10.78.0.147"],
      setupStore: {
        async load() {
          return { setup: { profile: "cloudedge", email: "owner@example.com", password: "pw", onvifUsername: "admin", onvifPassword: "admin" } };
        },
        async save() {},
        async clear() {},
      },
      networkMode: {
        snapshot() { return network; },
        async refresh() { return network; },
        async set() { throw new Error("not used"); },
      },
      localRegistration: {
        cameraAddresses: ["10.78.0.147"],
        isRegistered() { return registered; },
        async waitForEvent(address, kind, timeoutMs) {
          calls.push(`wait:${address}:${kind}:${timeoutMs}`);
          const started = Date.now();
          while (Date.now() - started < 500) {
            if (registered) return Date.now() - started;
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          return undefined;
        },
      },
      ...(options.withRecovery === false ? {} : {
        cameraRecovery: {
          async probe(host, credentials) {
            calls.push(`probe:${host}:${credentials.username ?? ""}`);
            const backHome = rebootedAtClock !== undefined && clock - rebootedAtClock >= 30_000;
            if (host === options.answeringAt || (backHome && host === "10.78.0.147")) return { serialNumber: "100000001", model: "Pet 3T" };
            throw new Error("connect ETIMEDOUT");
          },
          async reboot(host) {
            calls.push(`reboot:${host}`);
            rebootedAtClock = clock;
            if (options.registerAfterMs !== undefined) setTimeout(() => { registered = true; }, options.registerAfterMs);
          },
          async locate(identity, account) {
            calls.push(`locate:${identity.serialNumber ?? "-"}:${account.email}`);
            return options.cloudHost ? { host: options.cloudHost, gateway: "10.0.0.1" } : undefined;
          },
          async sleep(ms) { clock += ms; },
          now: () => clock,
        },
      }),
    });
    return { app: createApp(service), service, calls };
  }

  test("POST /api/camera/reboot finds a camera that moved to its backup Wi-Fi, reboots it there, and waits for it to come home", async () => {
    const { app, service, calls } = rebootFixture({ answeringAt: "10.0.0.82", cloudHost: "10.0.0.82", registerAfterMs: 20 });
    await service.restore();
    const response = await app.request("/api/camera/reboot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ host: "10.78.0.147" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; message?: string };
    expect(body.ok).toBe(true);
    expect(body.message).toContain("10.78.0.147 did not answer ONVIF (connect ETIMEDOUT)");
    expect(body.message).toContain("the vendor cloud reported it at 10.0.0.82 (gateway 10.0.0.1, so it joined its backup Wi-Fi)");
    expect(body.message).toContain("rebooted it at 10.0.0.82; it answered at 10.78.0.147 again 30 s later");
    expect(body.message).toContain("re-registered with the local emulator");
    expect(calls).toContain("probe:10.0.0.82:admin");
    expect(calls).toContain("locate:-:owner@example.com");
    // The registration wait is armed before the reboot so a fast re-registration is never missed.
    expect(calls.indexOf("wait:10.78.0.147:registered:150000")).toBeLessThan(calls.indexOf("reboot:10.0.0.82"));
    expect(calls).toContain("discover:10.78.0.147");
  });

  test("POST /api/camera/reboot explains a camera that is not reachable anywhere", async () => {
    const { app, service, calls } = rebootFixture({});
    await service.restore();
    const response = await app.request("/api/camera/reboot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ host: "10.78.0.147", timeoutSeconds: 30 }),
    });
    expect(response.status).toBe(502);
    const body = await response.json() as { error?: { code: string; message: string } };
    expect(body.error?.code).toBe("camera_error");
    expect(body.error?.message).toContain("the vendor cloud does not list this camera");
    expect(calls.some((call) => call.startsWith("reboot:"))).toBe(false);
  });

  test("POST /api/camera/reboot needs a camera id or address, and rejects an unknown id", async () => {
    const { app } = rebootFixture({ answeringAt: "10.78.0.147" });
    const empty = await app.request("/api/camera/reboot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(400);
    const unknown = await app.request("/api/camera/reboot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: "nope" }),
    });
    expect(unknown.status).toBe(404);
    const malformed = await app.request("/api/camera/reboot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ host: "10.78.0.147", timeoutSeconds: 1 }),
    });
    expect(malformed.status).toBe(400);
  });

  test("POST /api/camera/reboot is unsupported when the server has no recovery path", async () => {
    const { app } = rebootFixture({ withRecovery: false });
    const response = await app.request("/api/camera/reboot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ host: "10.78.0.147" }),
    });
    expect(response.status).toBe(409);
  });

  test("POST /api/camera/network/reconnect is unsupported when the gateway cannot kick clients", async () => {
    const { app } = networkFixture();
    const response = await app.request("/api/camera/network/reconnect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(409);
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe("not_supported");
    expect(body.error.message).toContain("cannot kick Wi-Fi clients");
  });

  test("POST /api/camera/network/dns-override is unsupported without a network-mode dependency", async () => {
    const service = new CameraService({
      async connectCloud() { return { async discover() { return []; } }; },
      async discoverLocal() { return []; },
    });
    const response = await createApp(service).request("/api/camera/network/dns-override", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "on" }),
    });
    expect(response.status).toBe(409);
    const body = await response.json() as { error: { code: string } };
    expect(body.error.code).toBe("not_supported");
  });
});
