import { describe, expect, test } from "bun:test";
import { parseTokenSubject, parseValue, runHt } from "./index.ts";
import { boundsText } from "./elements.ts";
import { MemorySecretStore } from "../config/secrets";

interface Call { method: string; path: string; body?: unknown; authorization?: string }

function fixture(responses: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const fakeFetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    calls.push({ method, path: url.pathname, ...(headers.get("authorization") ? { authorization: headers.get("authorization")! } : {}), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    // A query string may be answered separately; without one the path answers every query.
    const response = responses[`${method} ${url.pathname}${url.search}`] ?? responses[`${method} ${url.pathname}`];
    if (response === undefined) return new Response(JSON.stringify({ error: { code: "not_found", message: "Route not found" } }), { status: 404 });
    return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const run = (argv: string[], extra = {}) => runHt(argv, {
    fetch: fakeFetch,
    env: { HOMETRUTH_URL: "http://hometruth.test" },
    // Hermetic on purpose: without this the client reads the developer's own
    // .hometruth/secrets.yml for `api.cli.token`, and these assertions would
    // pass or fail depending on whose machine ran them.
    secretStore: new MemorySecretStore(),
    stdout: (text) => { out.push(text); },
    stderr: (text) => { err.push(text); },
    ...extra,
  });
  return { run, calls, out: () => out.join(""), err: () => err.join("") };
}

/** A light as an install publishes it: config, the live document, and the controls it accepts. */
const DESK = {
  id: "desk",
  name: "Desk",
  room: "Study",
  model: { title: "Elgato Key Light Air", manufacturer: "Elgato", capabilities: ["light"], connectionTypes: ["direct-local"] },
  config: { host: "10.77.0.153" },
  controls: ["turnOn", "turnOff", "toggle", "setBrightness", "setColorTemperature", "getState"],
  enabled: true,
  object: {
    status: "online",
    capabilities: {
      light: {
        state: { availability: "online", on: true, brightnessPercent: 40 },
        actions: {
          turnOn: {}, turnOff: {}, toggle: {},
          setBrightness: { minimumPercent: 0, maximumPercent: 100 },
          setColorTemperature: { minimumKelvin: 2900, maximumKelvin: 7000 },
        },
      },
    },
  },
};

describe("ht", () => {
  test("--for speaks the group builder's vocabulary", () => {
    expect(parseTokenSubject("all")).toEqual({ all: true });
    expect(parseTokenSubject("device:gate-relay")).toEqual({ device: "gate-relay" });
    expect(parseTokenSubject("group:automatic:cameras")).toEqual({ group: "automatic:cameras" });
    expect(parseTokenSubject("room:Kitchen")).toEqual({ criteria: { room: "Kitchen" } });
    expect(parseTokenSubject("room:Kitchen, tag:abc, tag:def"))
      .toEqual({ criteria: { room: "Kitchen", tagIds: ["abc", "def"] } });
    expect(() => parseTokenSubject("colour:red")).toThrow(/does not understand/u);
    expect(() => parseTokenSubject("")).toThrow(/--for takes/u);
  });

  test("every request carries the token, from the environment", async () => {
    const { run, calls } = fixture({ "GET /api/devices": { devices: [] } });
    expect(await run(["ls"], { env: { HOMETRUTH_URL: "http://hometruth.test", HOMETRUTH_TOKEN: "ht_abc_def" } })).toBe(0);
    expect(calls[0]?.authorization).toBe("Bearer ht_abc_def");
  });

  test("a refusal names the token, not the route", async () => {
    const { run, err } = fixture();
    const denied = (async () => new Response(JSON.stringify({ error: { code: "unauthenticated", message: "This request needs an API token" } }),
      { status: 401, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    expect(await run(["ls"], { fetch: denied })).not.toBe(0);
    expect(err()).toContain("HOMETRUTH_TOKEN");
  });

  test("with no arguments it says what the install is and what is in it", async () => {
    const { run, out } = fixture({
      "GET /api/health": { status: "ok", runtime: { name: "bun", version: "1.3.12" } },
      "GET /api/devices": { devices: [{ id: "a", availability: "online" }, { id: "b", availability: "offline" }] },
      "GET /api/device-groups": { groups: [{ id: "g" }] },
      "GET /api/services": { services: [{ id: "s", availability: "online" }] },
      "GET /api/models": { models: [{ id: "m" }, { id: "n" }] },
    });
    expect(await run([])).toBe(0);
    expect(out()).toContain("HomeTruth at http://hometruth.test");
    expect(out()).toContain("devices   2  1 online · 1 offline");
    expect(out()).toContain("models    2");
  });

  test("the models come from the install, not from this build", async () => {
    const { run, calls, out } = fixture({
      "GET /api/models": { models: [{ id: "some-future-thing", title: "Something new", capabilities: ["light"], connectionTypes: ["direct-local"], configSchema: { properties: { host: {} } } }] },
    });
    expect(await run(["ls", "model"])).toBe(0);
    expect(calls.map((call) => call.path)).toEqual(["/api/models"]);
    expect(out()).toContain("some-future-thing");
    expect(out()).toContain("Something new");
    expect(out()).toContain("host");
  });

  test("ls lists devices by default and any other element kind from the graph", async () => {
    const { run, calls, out } = fixture({
      "GET /api/devices": { devices: [{ id: "relay", name: "Relay", modelTitle: "Shelly Plus 1", model: "shelly-plus-1", room: "Hall", availability: "online", detail: "On", enabled: true }] },
      "GET /api/graph": { nodes: [{ id: "k", side: "instance", kind: "scene", name: "Evening", context: "Hue bridge", ids: ["hue", "evening"] }] },
    });
    expect(await run(["ls"])).toBe(0);
    expect(out()).toContain("relay");
    expect(out()).toContain("Hall");
    expect(out()).toContain("online · On");
    expect(await run(["ls", "scene"])).toBe(0);
    expect(calls.map((call) => call.path)).toEqual(["/api/devices", "/api/graph"]);
    expect(out()).toContain("hue/evening");
    expect(out()).toContain("Evening");
  });

  test("a kind this install does not publish says which kinds it does", async () => {
    const { run, err } = fixture({
      "GET /api/graph?side=instance&kind=gadget": { nodes: [] },
      "GET /api/graph": { nodes: [{ id: "k", side: "instance", kind: "scene", name: "Evening", context: "", ids: ["e"] }] },
    });
    expect(await run(["ls", "gadget"])).toBe(2);
    expect(err()).toContain('no instance element of kind "gadget"');
    expect(err()).toContain("scene");
  });

  test("find matches an element by id, name or where it sits", async () => {
    const { run, out } = fixture({
      "GET /api/graph": { nodes: [
        { id: "a", side: "instance", kind: "device", name: "Vanity Lights", context: "Master Bathroom", ids: ["lutron-vanity-lights"] },
        { id: "b", side: "instance", kind: "device", name: "Exhaust Fan", context: "Master Bathroom", ids: ["lutron-exhaust-fan"] },
        { id: "c", side: "schema", kind: "model", name: "Shelly Plus 1", context: "", ids: ["shelly-plus-1"] },
      ] },
    });
    expect(await run(["find", "bathroom"])).toBe(0);
    expect(out()).toContain("lutron-vanity-lights");
    expect(out()).toContain("lutron-exhaust-fan");
    expect(out()).not.toContain("shelly-plus-1");
  });

  test("an element shows its state and every control with the bounds the install published", async () => {
    const { run, calls, out } = fixture({ "GET /api/devices/desk": DESK });
    expect(await run(["desk"])).toBe(0);
    expect(calls.map((call) => call.path)).toEqual(["/api/devices/desk"]);
    expect(out()).toContain("Desk  device · Elgato Key Light Air · online");
    expect(out()).toContain("Elgato · light · direct-local · Study · host 10.77.0.153");
    expect(out()).toContain("brightnessPercent  40");
    expect(out()).toContain("brightness         0–100 percent");
    expect(out()).toContain("color-temperature  2900–7000 kelvin");
    // A control the capability accepts but does not advertise still appears.
    expect(out()).toContain("state");
  });

  test("an action that asks to be confirmed says so", async () => {
    const { run, out } = fixture({
      "GET /api/devices/petcam": {
        id: "petcam", name: "Pet camera", model: { title: "Pet cam", capabilities: ["treatDispenser"] }, enabled: true,
        controls: ["dispense"],
        object: { status: "online", capabilities: { treatDispenser: { state: { availability: "online" }, actions: { dispense: { minimumPortions: 1, maximumPortions: 1, step: 1, confirmation: "confirm" } } } } },
      },
    });
    expect(await run(["petcam"])).toBe(0);
    expect(out()).toContain("dispense  1–1 portions, step 1, needs --confirm");
  });

  test("a friendly command resolves its control and prints the state it left behind", async () => {
    const { run, calls, out } = fixture({
      "GET /api/devices/desk": DESK,
      "POST /api/devices/desk/controls/setBrightness": { ...DESK, object: { ...DESK.object, capabilities: { light: { state: { availability: "online", on: true, brightnessPercent: 70 }, actions: DESK.object.capabilities.light.actions } } } },
    });
    expect(await run(["desk", "brightness", "70", "--confirm"])).toBe(0);
    expect(calls).toEqual([{ method: "GET", path: "/api/devices/desk" }, { method: "POST", path: "/api/devices/desk/controls/setBrightness", body: { value: 70, confirmed: true } }]);
    expect(out()).toContain("brightness sent to Desk · online");
    expect(out()).toContain("brightnessPercent  70");
    // The old capability-first spelling would silently invoke the wrong control.
    expect(await run(["desk", "light", "setBrightness", "70"])).toBe(2);
    expect(parseValue("true")).toBe(true);
    expect(parseValue('{"a":1}')).toEqual({ a: 1 });
    expect(parseValue("hello")).toBe("hello");
    expect(parseValue(undefined)).toBeUndefined();
  });

  test("an id that is not a device is looked up as a group, and its control goes to the group route", async () => {
    const group = {
      id: "primary-bath", name: "Primary Bath", availability: "online",
      members: [{ id: "fan", name: "Exhaust Fan", availability: "online" }, { id: "vanity", name: "Vanity Lights", availability: "online" }],
      properties: [{ id: "power.on", status: "shared", value: false }],
      actions: [{ id: "power.toggle", control: "toggle", input: "none", bounds: {}, confirmation: false }],
    };
    const { run, calls, out } = fixture({
      "GET /api/device-groups/primary-bath": group,
      "POST /api/device-groups/primary-bath/controls/power.toggle": { ok: true, group: { ...group, properties: [{ id: "power.on", status: "shared", value: true }] } },
    });
    expect(await run(["primary-bath"])).toBe(0);
    expect(out()).toContain("Primary Bath  group · group of 2 · online");
    expect(out()).toContain("toggle");
    expect(await run(["primary-bath", "toggle"])).toBe(0);
    expect(calls.map((call) => call.path)).toEqual([
      "/api/devices/primary-bath",
      "/api/device-groups/primary-bath",
      "/api/devices/primary-bath",
      "/api/device-groups/primary-bath",
      "/api/device-groups/primary-bath/controls/power.toggle",
    ]);
    expect(out()).toContain("toggle sent to Primary Bath");
    expect(out()).toContain("power.on  true");
  });

  test("a service is an element too: its actions come from the install and are invoked by name", async () => {
    const { run, calls, out } = fixture({
      "GET /api/services": { services: [{ id: "hue-proxy", title: "Hue bridge proxy", availability: "online", detail: "Listening; pairing closed", actions: [{ id: "link-button", until: "2026-09-18T16:00:00.000Z" }] }] },
      "POST /api/services/hue-proxy/actions/link-button": { serviceId: "hue-proxy", action: "link-button", detail: "Pairing open for 30 s" },
    });
    expect(await run(["hue-proxy"])).toBe(0);
    expect(out()).toContain("Hue bridge proxy  service · online");
    expect(out()).toContain(`link-button  standing until ${new Date("2026-09-18T16:00:00.000Z").toTimeString().slice(0, 8)}`);
    expect(await run(["hue-proxy", "link-button"])).toBe(0);
    expect(calls.at(-1)).toEqual({ method: "POST", path: "/api/services/hue-proxy/actions/link-button", body: {} });
    expect(out()).toContain("link-button on hue-proxy: Pairing open for 30 s");
  });

  test("an unknown command prints native names without attempting a write", async () => {
    const { run, calls, err } = fixture({
      "GET /api/devices/desk": { ...DESK, page: "/lights/desk" },
      "GET /lights/desk/openapi.json": { paths: { "/api/devices/desk/controls/turnOn": { post: { "x-hometruth-cli": { name: "on" } } } } },
    });
    expect(await run(["desk", "fly"])).toBe(2);
    expect(err()).toContain('has no command "fly"');
    expect(err()).toContain("Commands: on");
    expect(calls.every(call => call.method === "GET")).toBe(true);
    expect(await run(["desk", "turnOn"])).toBe(2);
  });

  test("an id nothing here uses says how to look", async () => {
    const { run, err } = fixture({ "GET /api/services": { services: [] } });
    expect(await run(["nope"])).toBe(2);
    expect(err()).toContain('Nothing here is called "nope"');
    expect(err()).toContain("ht ls");
  });

  test("watch subscribes to the state stream and prints each change", async () => {
    const frames = [
      'event: hello\ndata: {"generation":"g1","tier":"live","nodes":["device/desk"],"keepaliveMs":15000}\n\n',
      ': keepalive\n\n',
      'event: state\ndata: {"node":"device/desk","version":2,"updatedAt":"2026-09-18T16:04:05.000Z","value":{"status":"online","capabilities":{"light":{"state":{"availability":"online","on":true,"brightnessPercent":70,"observedAt":"x"}}}}}\n\n',
      'event: state\ndata: {"node":"device/desk","version":3,"updatedAt":"2026-09-18T16:04:09.000Z","fault":{"code":"unreachable","message":"Desk did not answer"}}\n\n',
    ];
    const streaming = (async (input: URL | RequestInfo) => {
      const url = input instanceof URL ? input : new URL(String(input));
      if (url.pathname === "/api/devices/desk") return new Response(JSON.stringify(DESK), { status: 200, headers: { "content-type": "application/json" } });
      if (url.pathname !== "/api/state/stream") return new Response(JSON.stringify({ error: { code: "not_found", message: "no" } }), { status: 404 });
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
          controller.close();
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const { run, out } = fixture();
    expect(await run(["watch", "desk"], { fetch: streaming })).toBe(0);
    // Printed in local time, so the expectation is computed the same way.
    const at = (iso: string) => new Date(iso).toTimeString().slice(0, 8);
    expect(out()).toContain("watching device/desk");
    expect(out()).toContain(`${at("2026-09-18T16:04:05.000Z")}  device/desk  online  light on true, brightnessPercent 70`);
    expect(out()).toContain(`${at("2026-09-18T16:04:09.000Z")}  device/desk  unreachable: Desk did not answer`);
  });

  test("issuing prints the token once and says what it can do", async () => {
    const { run, out, calls } = fixture({
      "POST /api/tokens": { token: "ht_0123_secret", kid: "0123", name: "Kindle", permissions: ["read"], reaches: "room Kitchen", createdAt: "2026-09-17T00:00:00.000Z" },
    });
    expect(await run(["tokens", "issue", "Kindle", "--can", "read", "--for", "room:Kitchen"],
      { env: { HOMETRUTH_URL: "http://hometruth.test", HOMETRUTH_TOKEN: "ht_admin_x" } })).toBe(0);
    expect(calls[0]?.body).toEqual({ name: "Kindle", permissions: ["read"], subject: { criteria: { room: "Kitchen" } } });
    expect(out()).toContain("ht_0123_secret");
    expect(out()).toContain("cannot be shown again");
  });

  test("issuing without --can or --for is a usage error, not a dead token", async () => {
    const { run, err } = fixture();
    expect(await run(["tokens", "issue", "Nameless"])).toBe(2);
    expect(err()).toContain("--can");
  });

  test("issuing admin access to one device uses the current scope and rejects removed levels", async () => {
    const { run, calls } = fixture({
      "POST /api/tokens": { token: "ht_0123_secret", kid: "0123", name: "Gate administrator", permissions: ["admin"], reaches: "gate-relay" },
    });
    expect(await run(["tokens", "issue", "Gate administrator", "--can", "admin", "--for", "device:gate-relay"])).toBe(0);
    expect(calls[0]?.body).toEqual({ name: "Gate administrator", permissions: ["admin"], subject: { device: "gate-relay" } });
    for (const removed of ["control", "media", "events"]) {
      expect(await run(["tokens", "issue", "Gate administrator", "--can", removed, "--for", "device:gate-relay"])).toBe(2);
    }
    expect(calls).toHaveLength(1);
  });

  test("runs one-client Wi-Fi admission with bounded options and reports the result", async () => {
    const { run, out, err, calls } = fixture();
    const options: unknown[] = [];
    const wifiAdmission = async (value: unknown, _env: unknown, report: (message: string) => void) => {
      options.push(value);
      report("MAC restriction restored");
      return { status: "accepted", ssid: "Test IoT", allowedCount: 2, filterEnabled: true,
        client: { mac: "02:00:00:00:00:02", ssid: "Test IoT", address: "10.78.0.50" } } as const;
    };
    expect(await run(["network", "accept-next", "Test IoT", "--timeout", "120"], { wifiAdmission })).toBe(0);
    expect(options).toEqual([{ ssid: "Test IoT", timeoutMs: 120000, dryRun: false, recover: false }]);
    expect(out()).toContain("10.78.0.50");
    expect(err()).toContain("restriction restored");
    expect(calls).toEqual([]);
    expect(await run(["network", "accept-next"], { wifiAdmission })).toBe(2);
    expect(await run(["network", "accept-next", "Test IoT", "--timeout", "601"], { wifiAdmission })).toBe(2);
    expect(await run(["network", "accept-next", "Test IoT", "--recover", "--dry-run"], { wifiAdmission })).toBe(2);
    expect(await run(["network", "accept-next", "Test IoT", "--typo"], { wifiAdmission })).toBe(2);
    expect(options).toHaveLength(1);
  });

  test("enables and disables a device through the install", async () => {
    const { run, calls, out } = fixture({
      "POST /api/devices/relay/disable": false,
      "POST /api/devices/relay/enable": true,
    });
    expect(await run(["disable", "relay"])).toBe(0);
    expect(calls).toEqual([{ method: "POST", path: "/api/devices/relay/disable" }]);
    expect(out()).toContain("relay is now disabled");
    expect(await run(["enable", "relay", "--json"])).toBe(0);
    expect(calls.at(-1)).toEqual({ method: "POST", path: "/api/devices/relay/enable" });
    expect(out()).toEndWith("true\n");
    expect(await run(["enable"])).toBe(2);
  });

  test("reboots through the install, or directly when asked", async () => {
    const { run, calls, out } = fixture({ "POST /api/devices/cam/reboot": { object: { status: "online" } } });
    expect(await run(["reboot", "cam"])).toBe(0);
    expect(calls[0]?.path).toBe("/api/devices/cam/reboot");
    expect(out()).toContain("Rebooted cam; status online");
    const direct: string[] = [];
    const { run: runDirect, calls: directCalls, out: directOut } = fixture();
    expect(await runDirect(["reboot", "10.78.0.147", "--direct", "--timeout", "30"], {
      directReboot: async (target: string, options: { locateOnly: boolean; timeoutMs: number }) => { direct.push(`${target}:${options.locateOnly}:${options.timeoutMs}`); return "done"; },
    })).toBe(0);
    expect(direct).toEqual(["10.78.0.147:false:30000"]);
    expect(directCalls).toEqual([]);
    expect(directOut()).toBe("done\n");
  });

  test("rescans every device by MAC through the install and lists what changed", async () => {
    const { run, calls, out } = fixture({
      "POST /api/network/rescan": {
        message: "Rescanned 2 devices: 1 moved, 0 identified, 0 missing",
        results: [
          { deviceId: "keylight", name: "Key Light", outcome: "unchanged", address: "10.77.0.50", detail: "Key Light is at 10.77.0.50" },
          { deviceId: "sonos-kitchen", name: "Kitchen Sonos", outcome: "moved", address: "10.77.0.149", currentAddress: "10.78.0.148", mac: "02:00:00:e9:b0:24", detail: "Kitchen Sonos moved from 10.77.0.149 to 10.78.0.148 (example-iot)" },
        ],
      },
    });
    expect(await run(["rescan"])).toBe(0);
    expect(calls).toEqual([{ method: "POST", path: "/api/network/rescan", body: {} }]);
    expect(out()).toContain("Rescanned 2 devices: 1 moved");
    expect(out()).toContain("moved        sonos-kitchen");
    expect(out()).not.toContain("keylight");
    const one = fixture({ "POST /api/devices/sonos-kitchen/network/rescan": { message: "Kitchen Sonos is at 10.78.0.148", result: { deviceId: "sonos-kitchen", name: "Kitchen Sonos", outcome: "unchanged", address: "10.78.0.148", detail: "Kitchen Sonos is at 10.78.0.148" } } });
    expect(await one.run(["rescan", "sonos-kitchen"])).toBe(0);
    expect(one.calls).toEqual([{ method: "POST", path: "/api/devices/sonos-kitchen/network/rescan", body: {} }]);
    expect(one.out()).toContain("Kitchen Sonos is at 10.78.0.148");
  });

  test("reconnects one device through the install", async () => {
    const { run, calls, out } = fixture({
      "POST /api/devices/keylight/network/reconnect": { message: "Asked the gateway to reconnect Key Light" },
    });
    expect(await run(["reconnect", "keylight"])).toBe(0);
    expect(calls).toEqual([{ method: "POST", path: "/api/devices/keylight/network/reconnect", body: {} }]);
    expect(out()).toContain("Asked the gateway to reconnect Key Light");
    expect(await run(["reconnect"])).toBe(2);
  });

  test("switches the DNS override and kicks the cameras through the install", async () => {
    const { run, calls } = fixture({
      "POST /api/camera/network/dns-override": { ok: true, message: "enabled" },
      "POST /api/camera/network/reconnect": { ok: true, message: "kicked" },
    });
    expect(await run(["network", "off"])).toBe(0);
    expect(await run(["network", "kick"])).toBe(0);
    expect(calls.map((call) => [call.path, call.body])).toEqual([
      ["/api/camera/network/dns-override", { action: "off" }],
      ["/api/camera/network/reconnect", {}],
    ]);
  });

  test("hands tkenpro arguments over untouched", async () => {
    const seen: string[][] = [];
    const { run } = fixture();
    expect(await run(["tkenpro", "discover", "--cidr", "10.78.0.0/24", "--json"], {
      tkenpro: async (argv: readonly string[]) => { seen.push([...argv]); return 0; },
    })).toBe(0);
    expect(seen).toEqual([["discover", "--cidr", "10.78.0.0/24", "--json"]]);
  });

  test("lists, sets, unsets, and imports secrets without ever printing a value", async () => {
    const secretStore = new MemorySecretStore({ schemaVersion: 1, network: { unifi: { apiKey: "k3y" } } });
    const { run, out } = fixture();
    const deps = { secretStore, readSecret: async () => "hunter2\n", importSecrets: async () => ["devices.cam.onvif.password"] };
    expect(await run(["secrets", "set", "devices.cam.onvif.password"], deps)).toBe(0);
    expect(await run(["secrets", "list"], deps)).toBe(0);
    expect(out()).toContain("devices.cam.onvif.password\nnetwork.unifi.apiKey");
    expect(out()).not.toContain("hunter2");
    expect(out()).not.toContain("k3y");
    expect(await run(["secrets", "unset", "devices.cam.onvif.password"], deps)).toBe(0);
    expect((await secretStore.load()).devices).toBeUndefined();
    expect(await run(["secrets", "import"], deps)).toBe(0);
    expect(out()).toContain("Imported:\ndevices.cam.onvif.password");
    expect(await run(["secrets", "set", "bogus"], deps)).toBe(1);
    expect(await run(["secrets", "frob"], deps)).toBe(2);
  });

  test("bounds are read by shape, so a capability may add one without changing ht", async () => {
    expect(boundsText({})).toBeUndefined();
    expect(boundsText({ minimumPercent: 0, maximumPercent: 100 })).toBe("0–100 percent");
    expect(boundsText({ minLeaseMs: 100, maxLeaseMs: 3000 })).toBe("100–3000 lease ms");
    expect(boundsText({ formats: ["hex", "rgb"] })).toBe("formats hex, rgb");
    // A bound this build has never seen still reads as a bound.
    expect(boundsText({ minimumFlurgs: 2, maximumFlurgs: 9, confirmation: "confirm" })).toBe("2–9 flurgs");
  });

  test("explains usage errors and install errors", async () => {
    const { run, err } = fixture();
    expect(await run(["graph"])).toBe(2);
    expect(err()).toContain("graph needs an element id");
    expect(await run(["network", "sideways"])).toBe(2);
    expect(await run(["reboot", "x", "--timeout", "1"])).toBe(2);
    expect(await run(["ls", "--side", "sideways"])).toBe(2);
    expect(await run(["frobnicate"])).toBe(1);
    expect(err()).toContain("HomeTruth answered 404 not_found: Route not found");
  });
});
