/** A fake Rachio cloud for tests: synthetic ids, no network. */
import type { RachioFetch } from "./client";

export const PERSON_ID = "person-0000-example";
export const DEVICE_ID = "device-0000-example";

export interface FakeRachioCall {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly body?: unknown;
}

export function fakeZones(count = 16): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `zone-${index + 1}-example`, zoneNumber: index + 1, name: `Example zone ${index + 1}`, enabled: index !== 15,
    maxRuntime: 10_800, lastWateredDate: 1_790_000_000_000,
  }));
}

export function fakeController(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: DEVICE_ID, name: "Example controller", status: "ONLINE", on: true, serialNumber: "EXAMPLE-SERIAL",
    model: "GENERATION3_16ZONE", rainSensorTripped: false, zones: fakeZones(), ...overrides,
  };
}

export interface FakeRachioCloud {
  readonly fetch: RachioFetch;
  readonly calls: FakeRachioCall[];
  controller: Record<string, unknown>;
  schedule: Record<string, unknown>;
  /** Answer every request with this status instead. */
  status?: number;
  /** Throw from fetch, as a network failure does. */
  down?: boolean;
  headers: Record<string, string>;
  count(method: string, path: string): number;
}

export function fakeRachioCloud(): FakeRachioCloud {
  const cloud: FakeRachioCloud = {
    calls: [],
    controller: fakeController(),
    schedule: {},
    headers: {},
    count(method, path) { return cloud.calls.filter(call => call.method === method && call.path === path).length; },
    fetch: async (url, init) => {
      const method = init?.method ?? "GET";
      const path = url.pathname.replace(/^\/1\/public\//u, "");
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
      cloud.calls.push({ method, path, authorization: headers.get("authorization"), ...(body !== undefined ? { body } : {}) });
      if (cloud.down) throw new TypeError("fetch failed");
      const reply = (value: unknown, status = 200) => new Response(value === undefined ? null : JSON.stringify(value), { status, headers: cloud.headers });
      if (cloud.status) return reply({ error: "synthetic" }, cloud.status);
      if (method === "GET" && path === "person/info") return reply({ id: PERSON_ID });
      if (method === "GET" && path === `person/${PERSON_ID}`) return reply({ id: PERSON_ID, devices: [cloud.controller, { id: "deleted-example", deleted: true }] });
      if (method === "GET" && path === `device/${DEVICE_ID}/current_schedule`) return reply(cloud.schedule);
      if (method === "PUT" && ["zone/start", "device/stop_water", "device/on", "device/off", "device/rain_delay"].includes(path)) return reply(undefined, 204);
      return reply({ error: "not found" }, 404);
    },
  };
  return cloud;
}

/** What `current_schedule` says while `zoneNumber` waters. */
export function wateringSchedule(zoneNumber: number): Record<string, unknown> {
  return {
    type: "MANUAL", status: "PROCESSING", deviceId: DEVICE_ID, zoneId: `zone-${zoneNumber}-example`, zoneNum: zoneNumber,
    startDate: 1_790_000_000_000, zoneStartDate: 1_790_000_000_000, zoneDuration: 600, duration: 600,
  };
}
