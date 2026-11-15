import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { ENPHASE_ENVOY, ENPHASE_ENVOY_CONFIG_SCHEMA, ENPHASE_ENVOY_SECRETS_SCHEMA, EnphaseEnvoy, type EnphaseEnvoyConfig, type EnphaseEnvoySecrets } from ".";
import { registeredView, summaryDetail } from "../../../site";
import { validators } from "../../../validation";
import type { EnphaseFetch } from "../../../protocols/enphase/token";
import { ENLIGHTEN_LOGIN_URL, ENTREZ_TOKENS_URL } from "../../../protocols/enphase/token";
import {
  CONTROLLER_SERIAL, ENSEMBLE_POWER, HOST, INFO_XML, INVERTERS, PRODUCTION, PRODUCTION_WITHOUT_METERS, SECCTRL, SERIAL,
  batterySerial, inventory, inverterSerial, ownerToken,
} from "../../../protocols/enphase/test-fixtures";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const TOKEN = ownerToken();

interface FakeGateway {
  readonly fetch: EnphaseFetch;
  readonly requests: string[];
  routes: Record<string, () => Response>;
}

function gateway(overrides: Record<string, () => Response> = {}, token = TOKEN): FakeGateway {
  const requests: string[] = [];
  const fake: FakeGateway = {
    requests,
    routes: {
      "/info": () => new Response(INFO_XML, { headers: { "content-type": "text/xml" } }),
      "/production.json?details=1": () => Response.json(PRODUCTION),
      "/api/v1/production/inverters": () => Response.json(INVERTERS),
      "/ivp/ensemble/inventory": () => Response.json(inventory()),
      "/ivp/ensemble/secctrl": () => Response.json(SECCTRL),
      "/ivp/ensemble/power": () => Response.json(ENSEMBLE_POWER),
      ...overrides,
    },
    fetch: async (url, init) => {
      expect(url.protocol).toBe("https:");
      expect(url.hostname).toBe(HOST);
      expect(init?.method).toBe("GET");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const path = url.pathname + url.search;
      requests.push(path);
      const auth = new Headers(init?.headers).get("authorization");
      if (path !== "/info" && auth !== `Bearer ${token}`) return new Response("", { status: 401 });
      const route = fake.routes[path];
      return route ? route() : new Response("", { status: 404 });
    },
  };
  return fake;
}

function make(fake: FakeGateway, config: Partial<EnphaseEnvoyConfig> = {}, secrets: EnphaseEnvoySecrets = { token: TOKEN }, cloudFetch?: EnphaseFetch) {
  return new EnphaseEnvoy({ id: "solar", name: "Solar" }, { host: HOST, ...config }, secrets, { fetch: fake.fetch, now: () => NOW, ...(cloudFetch ? { cloudFetch } : {}) });
}

const reading = (state: { sensors: readonly { id: string }[] }, id: string) => state.sensors.find((sensor) => sensor.id === id);

describe("Enphase IQ Gateway", () => {
  test("reads production, consumption, grid, battery and grid status in one validated document", async () => {
    const fake = gateway();
    const device = make(fake, { serialNumber: SERIAL });
    const [object, identity] = await Promise.all([device.describe(), device.probe()]);
    expect(validators.homeTruthObject(object)).toBe(true);
    expect(identity).toEqual({ serialNumber: SERIAL, model: "IQ Gateway 800-00654-r08", firmwareVersion: "8.2.4499" });
    expect(object).toMatchObject({ status: "online", manufacturer: "Enphase", serialNumber: SERIAL, firmwareVersion: "8.2.4499" });
    const state = object.capabilities.sensor!.state;
    expect(state.availability).toBe("online");
    expect(state.sensors.map((sensor) => sensor.id)).toEqual([
      "solar-power", "home-power", "grid-power", "battery-charge", "battery-power", "grid-status",
      "solar-energy-today", "solar-energy-lifetime", "home-energy-today", "home-energy-lifetime", "battery-energy-available", "inverters-active",
    ]);
    expect(reading(state, "solar-power")).toMatchObject({ value: 6123.4, unit: "W", quantity: "power", source: "productionMeter", observedAt: new Date(NOW).toISOString() });
    expect(reading(state, "home-power")).toMatchObject({ value: 3376.2, unit: "W" });
    // Import positive, export negative.
    expect(reading(state, "grid-power")).toMatchObject({ value: -2747.2, unit: "W" });
    expect(reading(state, "solar-energy-today")).toMatchObject({ value: 18.457, unit: "kWh" });
    expect(reading(state, "solar-energy-lifetime")).toMatchObject({ value: 41387.513, unit: "kWh" });
    expect(reading(state, "home-energy-today")).toMatchObject({ value: 12.035, unit: "kWh" });
    expect(reading(state, "battery-charge")).toMatchObject({ value: 82, unit: "%", quantity: "stateOfCharge", source: "secctrl" });
    // Charging is negative.
    expect(reading(state, "battery-power")).toMatchObject({ value: -1500, unit: "W" });
    expect(reading(state, "battery-energy-available")).toMatchObject({ value: 16.531, unit: "kWh" });
    expect(reading(state, "grid-status")).toMatchObject({ value: 1, detail: "On grid", availability: "online" });
    expect(reading(state, "inverters-active")).toMatchObject({ value: 30 });
    // One round of requests for the page and the probe together; per-inverter data is not asked for by default.
    expect(fake.requests.filter((path) => path === "/production.json?details=1")).toHaveLength(1);
    expect(fake.requests).not.toContain("/api/v1/production/inverters");
    expect(summaryDetail(object)).toContain("Solar production 6123.4 W");
    expect(registeredView(device).kind).toBe("sensor");
    expect(device.controls()).toEqual(["getState"]);
    await expect(device.invoke("sensor", "setBatteryMode")).rejects.toThrow("has no control");
  });

  test("off grid reads 0 with its word", async () => {
    const device = make(gateway({ "/ivp/ensemble/inventory": () => Response.json(inventory("open")) }));
    const state = await device.getState();
    expect(reading(state, "grid-status")).toMatchObject({ value: 0, detail: "Off grid", availability: "online" });
  });

  test("unit readings add one row per IQ Battery and microinverter, timed by their own reports", async () => {
    const fake = gateway();
    const device = make(fake, { unitReadings: true });
    const object = await device.describe();
    expect(validators.homeTruthObject(object)).toBe(true);
    const state = object.capabilities.sensor!.state;
    expect(state.sensors).toHaveLength(12 + 6 + 30);
    expect(reading(state, `battery-${batterySerial(5)}`)).toMatchObject({ value: 86, unit: "%", quantity: "stateOfCharge" });
    expect(reading(state, `inverter-${inverterSerial(0)}`)).toMatchObject({
      value: 200, unit: "W", source: "lastReportWatts", observedAt: new Date(INVERTERS[0]!.lastReportDate * 1000).toISOString(),
    });
    expect(state.sensors.slice(-30).every((sensor) => sensor.id.startsWith("inverter-"))).toBe(true);
    expect(state.sensors.some((sensor) => sensor.id === `battery-${CONTROLLER_SERIAL}`)).toBe(false);
  });

  test("a system without CTs or batteries lists only what it has", async () => {
    const device = make(gateway({
      "/production.json?details=1": () => Response.json(PRODUCTION_WITHOUT_METERS),
      "/ivp/ensemble/inventory": () => new Response("", { status: 404 }),
    }));
    const state = await device.getState();
    expect(state.availability).toBe("online");
    expect(state.sensors.map((sensor) => sensor.id)).toEqual(["solar-power", "solar-energy-lifetime", "inverters-active"]);
    expect(reading(state, "solar-power")).toMatchObject({ value: 6012, source: "inverters" });
  });

  test("battery charge falls back to the capacity-weighted unit mean without secctrl", async () => {
    const device = make(gateway({ "/ivp/ensemble/secctrl": () => new Response("", { status: 404 }) }));
    const state = await device.getState();
    expect(reading(state, "battery-charge")).toMatchObject({ value: 82.7, source: "inventory" });
    expect(reading(state, "battery-energy-available")).toMatchObject({ availability: "unknown" });
    expect(reading(state, "battery-energy-available")!).not.toHaveProperty("value");
    expect(state.availability).toBe("degraded");
  });

  test("an unreachable gateway is offline with every row unavailable, never zeros", async () => {
    const fake = gateway();
    const device = make(fake);
    await device.describe();
    fake.routes = {};
    const down = make({ ...fake, fetch: async () => { throw new TypeError("connect EHOSTUNREACH"); } });
    const object = await down.describe();
    expect(validators.homeTruthObject(object)).toBe(true);
    expect(object.status).toBe("offline");
    const state = object.capabilities.sensor!.state;
    expect(state.availability).toBe("offline");
    expect(state.detail).toContain("unreachable");
    expect(state.sensors.length).toBeGreaterThan(0);
    expect(state.sensors.every((sensor) => sensor.availability === "offline" && sensor.value === undefined)).toBe(true);
    await expect(down.probe()).rejects.toMatchObject({ code: "unreachable" });
  });

  test("after a good read, an outage keeps the same rows and marks them offline", async () => {
    let up = true;
    const fake = gateway();
    const device = make({ ...fake, fetch: async (url, init) => { if (!up) throw new TypeError("timeout"); return fake.fetch(url, init); } });
    const before = await device.getState();
    up = false;
    const after = await device.getState();
    expect(after.sensors.map((sensor) => sensor.id)).toEqual(before.sensors.map((sensor) => sensor.id));
    expect(after.sensors.every((sensor) => sensor.availability === "offline" && sensor.value === undefined)).toBe(true);
  });

  test("a failed battery read degrades only the battery rows", async () => {
    const device = make(gateway({ "/ivp/ensemble/inventory": () => new Response("busy", { status: 503 }) }));
    const state = await device.getState();
    expect(state.availability).toBe("degraded");
    expect(reading(state, "solar-power")).toMatchObject({ availability: "online" });
    expect(reading(state, "battery-charge")).toMatchObject({ availability: "offline" });
    expect(reading(state, "battery-charge")).not.toHaveProperty("value");
    expect(state.detail).toContain("HTTP 503");
  });

  test("a refused token is offline, names the problem, and never shows the token", async () => {
    const device = make(gateway({}, ownerToken(1_893_456_000, "00000000-0000-4000-8000-0000000000ff")));
    const object = await device.describe();
    const state = object.capabilities.sensor!.state;
    expect(state.availability).toBe("offline");
    expect(state.detail).toBe("Enphase gateway refused the owner token");
    expect(JSON.stringify(object)).not.toContain(TOKEN);
  });

  test("an expired pasted token says so", async () => {
    const expired = ownerToken(Math.floor(NOW / 1000) - 60);
    const device = make(gateway({}, expired), {}, { token: expired });
    const state = await device.getState();
    expect(state.availability).toBe("offline");
    expect(state.detail).toContain("expired on 2026-10-29; replace it in the secrets file");
  });

  test("a different gateway at the configured host gets no token", async () => {
    const fake = gateway();
    const device = make(fake, { serialNumber: "202599999999" });
    const state = await device.getState();
    expect(state.availability).toBe("offline");
    expect(state.detail).toContain("not the configured 202599999999");
    expect(fake.requests).toEqual(["/info"]);
  });

  test("an Enlighten login fetches a token for the gateway's own serial", async () => {
    const cloud: string[] = [];
    const cloudFetch: EnphaseFetch = async (url, init) => {
      cloud.push(url.href);
      if (url.href === ENLIGHTEN_LOGIN_URL) return Response.json({ message: "success", session_id: "synthetic-session" });
      if (url.href === ENTREZ_TOKENS_URL) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ serial_num: SERIAL });
        return new Response(TOKEN);
      }
      return new Response("", { status: 404 });
    };
    const fake = gateway();
    const device = make(fake, {}, { username: "owner@example.com", password: "correct horse" }, cloudFetch);
    expect((await device.getState()).availability).toBe("online");
    expect((await device.getState()).availability).toBe("online");
    expect(cloud).toEqual([ENLIGHTEN_LOGIN_URL, ENTREZ_TOKENS_URL]);
    expect(fake.requests[0]).toBe("/info");
  });

  test("health follows the readings and performs no control", async () => {
    const fake = gateway();
    expect((await make(fake).checkHealth()).status).toBe("healthy");
    expect(fake.requests.every((path) => !path.includes("relay") && !path.includes("tariff"))).toBe(true);
    const offline = make({ ...fake, fetch: async () => { throw new TypeError("down"); } });
    expect((await offline.checkHealth()).status).toBe("unhealthy");
    const disabled = make(gateway());
    disabled.enabled = false;
    expect((await disabled.checkHealth()).status).toBe("disabled");
    const degraded = make(gateway({ "/ivp/ensemble/power": () => new Response("", { status: 500 }) }));
    expect((await degraded.checkHealth()).status).not.toBe("healthy");
  });
});

describe("Enphase IQ Gateway schemas", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
  addFormats(ajv);
  const config = ajv.compile(ENPHASE_ENVOY_CONFIG_SCHEMA);
  const secrets = ajv.compile(ENPHASE_ENVOY_SECRETS_SCHEMA);

  test("config accepts the example and rejects public hosts and unknown keys", () => {
    expect(config({ host: HOST })).toBe(true);
    expect(config({ host: "envoy.local", serialNumber: SERIAL, unitReadings: true, timeoutMs: 5000 })).toBe(true);
    expect(config({ host: "https://8.8.8.8/" })).toBe(false);
    expect(config({ host: HOST, token: TOKEN })).toBe(false);
    expect(config({ host: HOST, password: "x" })).toBe(false);
    expect(config({})).toBe(false);
    expect(() => make(gateway(), { host: "8.8.8.8" })).toThrow("private LAN address");
  });

  test("secrets take exactly a token or a login", () => {
    expect(secrets({ token: TOKEN })).toBe(true);
    expect(secrets({ username: "owner@example.com", password: "correct horse" })).toBe(true);
    expect(secrets({})).toBe(false);
    expect(secrets({ username: "owner@example.com" })).toBe(false);
    expect(secrets({ token: TOKEN, username: "owner@example.com", password: "correct horse" })).toBe(false);
    expect(secrets({ token: "not a token" })).toBe(false);
    expect(secrets({ token: TOKEN, extra: 1 })).toBe(false);
  });

  test("the model record", () => {
    expect(ENPHASE_ENVOY).toMatchObject({ id: "enphase-envoy", capabilities: ["sensor"], connectionTypes: ["direct-local"] });
    const device = ENPHASE_ENVOY.create({ id: "solar", name: "Solar" }, { host: HOST }, {}, { token: TOKEN });
    expect(device).toBeInstanceOf(EnphaseEnvoy);
  });
});
