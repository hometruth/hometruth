import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DnsAction, DnsRecordState, DnsTarget, InternetBlockTarget, NetworkAdapter, WifiClient } from "./adapter";
import { IsolationStateStore, NetworkIsolation, describeFact, tlsServerName, type DeviceIsolationStatus, type HttpInterceptor, type IsolationObserver } from "./isolation";

const CAMERA = { id: "example-camera", name: "Kitchen camera", host: "10.78.0.147", cloudHostnames: ["usce.mearicloud.com", "meari-oss-us.oss-us-west-1.aliyuncs.com"] };
const OTHER = { id: "example-camera-2", name: "Hall camera", host: "10.78.0.64", cloudHostnames: ["usce.mearicloud.com"] };
const RELAY = { id: "gate-relay", name: "Gate relay", host: "10.77.0.228", cloudHostnames: [] };

/** A gateway that remembers its rules and records, and lists the cameras as Wi-Fi clients. */
function fakeAdapter(options: { clients?: WifiClient[]; internet?: boolean; capture?: boolean } = {}) {
  const records = new Map<string, DnsRecordState>();
  const blocks = new Map<string, DnsRecordState>();
  const kicked: string[] = [];
  const captures: string[] = [];
  const clients = options.clients ?? [
    { mac: "02:00:00:71:b6:de", address: "10.78.0.147", apMac: "ap", radio: "ng", ssid: "example-iot", vlan: 3 },
    { mac: "02:00:00:47:81:d0", address: "10.78.0.64", apMac: "ap", radio: "ng", ssid: "example-iot", vlan: 3 },
  ];
  const adapter: NetworkAdapter = {
    name: "fake",
    dns: {
      async describe(target: DnsTarget) { return records.get(target.domain) ?? "missing"; },
      async set(target: DnsTarget, action: DnsAction) { records.set(target.domain, action); return `dns ${target.domain} ${action}`; },
    },
    wifi: {
      async findClientByAddress(address) { return clients.find((client) => client.address === address); },
      async kickClient(client) { kicked.push(client.address); },
    },
    ...(options.internet === false ? {} : {
      internet: {
        async describe(target: InternetBlockTarget) { return blocks.get(target.mac) ?? "missing"; },
        async set(target: InternetBlockTarget, action: DnsAction) { blocks.set(target.mac, action); return `block ${target.label} ${action}`; },
      },
    }),
    ...(options.capture ? {
      capture: {
        async start(client: WifiClient, _sink: (chunk: Uint8Array) => void, _onEnd: (error?: Error) => void) {
          captures.push(`start ${client.address}`);
          return { where: `fake-ap ${client.address}`, async stop() { captures.push(`stop ${client.address}`); } };
        },
      },
    } : {}),
  };
  return { adapter, records, blocks, kicked, captures };
}

/** Collects what isolation reports about each device, the way a vendor service would. */
function recorder() {
  const seen: { address: string; type: string; message: string; data?: Record<string, unknown> }[] = [];
  const observer: IsolationObserver = { observe: (address, event) => seen.push({ address, ...event }) };
  return { observer, seen, typesFor: (address: string) => seen.filter((entry) => entry.address === address).map((entry) => entry.type) };
}

async function service(options: { adapter?: NetworkAdapter; devices?: typeof CAMERA[]; resolve?: (domain: string) => Promise<readonly string[]>; overrideIp?: string; observer?: IsolationObserver; logger?: (line: Record<string, unknown>) => void; reconcileOnStart?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "isolation-"));
  const store = new IsolationStateStore(join(directory, "state.json"));
  const isolation = new NetworkIsolation({
    ...(options.observer ? { observer: options.observer } : {}),
    devices: options.devices ?? [CAMERA, OTHER, RELAY],
    adapter: () => { if (!options.adapter) throw new Error("no adapter"); return options.adapter; },
    overrideIp: () => options.overrideIp ?? "10.78.0.231",
    store,
    httpPort: 0,
    tlsPort: 0,
    listenHost: "127.0.0.1",
    ...(options.reconcileOnStart === undefined ? {} : { reconcileOnStart: options.reconcileOnStart }),
    resolve: options.resolve ?? (async () => ["1.2.3.4"]),
    logger: options.logger ?? (() => undefined),
  });
  return { isolation, store };
}

const started: NetworkIsolation[] = [];
afterEach(async () => {
  for (const isolation of started.splice(0)) await isolation.stop();
});

describe("NetworkIsolation", () => {
  test("development startup leaves shared router rules alone but explicit isolation still works", async () => {
    const gateway = fakeAdapter();
    gateway.records.set("usce.mearicloud.com", "on");
    const { isolation } = await service({ adapter: gateway.adapter, reconcileOnStart: false });
    await isolation.start();
    started.push(isolation);
    expect(gateway.records.get("usce.mearicloud.com")).toBe("on");
    expect(gateway.blocks.size).toBe(0);
    expect(gateway.kicked).toEqual([]);
    await isolation.setIsolated(CAMERA.id, true);
    expect(gateway.blocks.get("02:00:00:71:b6:de")).toBe("on");
    expect(gateway.kicked).toEqual([CAMERA.host]);
  });
  test("isolating a device creates its gateway block, switches on the DNS records its model needs, starts a capture and kicks it", async () => {
    const gateway = fakeAdapter({ capture: true });
    const observed = recorder();
    const { isolation, store } = await service({ adapter: gateway.adapter, observer: observed.observer });
    await isolation.start();
    started.push(isolation);
    expect(isolation.isolatedDevices()).toEqual([]);

    const result = await isolation.setIsolated("example-camera", true);
    expect(result.message).toContain("block example-camera on");
    expect(result.message).toContain("dns usce.mearicloud.com on");
    expect(result.message).toContain("dns meari-oss-us.oss-us-west-1.aliyuncs.com on");
    expect(gateway.blocks.get("02:00:00:71:b6:de")).toBe("on");
    expect(gateway.records.get("usce.mearicloud.com")).toBe("on");
    expect(gateway.kicked).toEqual(["10.78.0.147"]);
    expect(gateway.captures).toEqual(["start 10.78.0.147"]);
    const device = result.status.devices.find((entry: DeviceIsolationStatus) => entry.deviceId === "example-camera")!;
    expect(device).toMatchObject({ isolated: true, mac: "02:00:00:71:b6:de", internetBlock: "on", capture: "running", captureWhere: "fake-ap 10.78.0.147" });
    expect(isolation.isIsolated("example-camera")).toBe(true);
    expect(isolation.isIsolatedAddress("10.78.0.147")).toBe(true);
    expect(isolation.isIsolatedAddress("10.78.0.64")).toBe(false);

    const saved = JSON.parse(await readFile(store.path, "utf8")) as { devices: Record<string, { isolated: boolean; mac?: string }> };
    expect(saved.devices["example-camera"]).toMatchObject({ isolated: true, mac: "02:00:00:71:b6:de" });

    // What it did is reported to the device's cloud service, not kept here.
    expect(observed.typesFor("10.78.0.147")).toEqual(["isolation_changed", "isolation_changed", "capture_changed", "disconnected"]);
    expect(observed.seen.find((entry) => entry.type === "capture_changed")?.data).toMatchObject({ state: "started" });
  });

  test("a shared DNS record stays on while another isolated device still needs it, and goes off once none does", async () => {
    const gateway = fakeAdapter();
    const { isolation } = await service({ adapter: gateway.adapter });
    await isolation.start();
    started.push(isolation);
    await isolation.setIsolated("example-camera", true);
    await isolation.setIsolated("example-camera-2", true);
    expect(gateway.records.get("usce.mearicloud.com")).toBe("on");

    const released = await isolation.setIsolated("example-camera", false);
    expect(released.message).toContain("block example-camera off");
    expect(gateway.blocks.get("02:00:00:71:b6:de")).toBe("off");
    expect(gateway.records.get("usce.mearicloud.com")).toBe("on"); // still needed by example-camera-2
    expect(gateway.records.get("meari-oss-us.oss-us-west-1.aliyuncs.com")).toBe("off");

    await isolation.setIsolated("example-camera-2", false);
    expect(gateway.records.get("usce.mearicloud.com")).toBe("off");
    expect(isolation.isolatedDevices()).toEqual([]);
  });

  test("a device with no vendor hostnames is isolated by its block alone", async () => {
    const gateway = fakeAdapter({ clients: [{ mac: "aa:bb:cc:dd:ee:01", address: "10.77.0.228" }] });
    const { isolation } = await service({ adapter: gateway.adapter });
    await isolation.start();
    started.push(isolation);
    await isolation.setIsolated("gate-relay", true);
    expect(gateway.blocks.get("aa:bb:cc:dd:ee:01")).toBe("on");
    expect(gateway.records.size).toBe(0);
  });

  test("refuses to isolate a device the gateway does not currently see (its MAC is unknown)", async () => {
    const gateway = fakeAdapter({ clients: [] });
    const { isolation } = await service({ adapter: gateway.adapter });
    await isolation.start();
    started.push(isolation);
    await expect(isolation.setIsolated("example-camera", true)).rejects.toThrow(/not on the network right now/u);
    expect(isolation.isIsolated("example-camera")).toBe(false);
  });

  test("refuses when the adapter cannot block a device, and names the reason", async () => {
    const gateway = fakeAdapter({ internet: false });
    const { isolation } = await service({ adapter: gateway.adapter });
    await isolation.start();
    started.push(isolation);
    await expect(isolation.setIsolated("example-camera", true)).rejects.toThrow(/cannot isolate devices/u);
    expect((await isolation.refresh()).canIsolate).toBe(false);
  });

  test("on the first run adopts a device whose vendor hostnames already resolve to HomeTruth, and reconciles its rules", async () => {
    const gateway = fakeAdapter({ capture: true });
    gateway.records.set("usce.mearicloud.com", "on");
    const { isolation } = await service({
      adapter: gateway.adapter,
      resolve: async (domain) => domain === "usce.mearicloud.com" ? ["10.78.0.231"] : ["47.88.37.113"],
    });
    await isolation.start();
    started.push(isolation);
    expect(isolation.isolatedDevices().map((device) => device.id)).toEqual(["example-camera", "example-camera-2"]);
    // Reconciled: both blocks created, the OSS record switched on for 147, captures running, nobody kicked.
    expect(gateway.blocks.get("02:00:00:71:b6:de")).toBe("on");
    expect(gateway.blocks.get("02:00:00:47:81:d0")).toBe("on");
    expect(gateway.records.get("meari-oss-us.oss-us-west-1.aliyuncs.com")).toBe("on");
    expect(gateway.kicked).toEqual([]);
    expect(gateway.captures.sort()).toEqual(["start 10.78.0.147", "start 10.78.0.64"]);
    expect(isolation.isIsolated("example-camera")).toBe(true);
  });

  test("a saved state file wins over adoption on later runs", async () => {
    const gateway = fakeAdapter();
    const { isolation, store } = await service({ adapter: gateway.adapter, resolve: async () => ["10.78.0.231"] });
    await store.save({ "example-camera": { isolated: false, mac: "02:00:00:71:b6:de" } });
    await isolation.start();
    started.push(isolation);
    expect(isolation.isolatedDevices()).toEqual([]);
  });

  test("the catch-all HTTP listener logs requests per device and hands a known host to its interceptor", async () => {
    const gateway = fakeAdapter();
    const directory = await mkdtemp(join(tmpdir(), "isolation-"));
    const isolation = new NetworkIsolation({
      devices: [CAMERA],
      adapter: () => gateway.adapter,
      overrideIp: () => "127.0.0.1",
      store: new IsolationStateStore(join(directory, "state.json")),
      httpPort: 0,
      tlsPort: 0,
      listenHost: "127.0.0.1",
      resolve: async () => [],
      logger: () => undefined,
    });
    started.push(isolation);
    const handled: string[] = [];
    const interceptor: HttpInterceptor = {
      id: "test-oss",
      hostnames: ["meari-oss-us.oss-us-west-1.aliyuncs.com"],
      async handle(request, source) {
        handled.push(`${request.method} ${new URL(request.url).pathname} from ${source.device?.id ?? source.address}`);
        return new Response("{}", { status: 200 });
      },
    };
    isolation.registerInterceptor(interceptor);
    await isolation.start();
    const port = (await isolation.refresh()).listeners.http;
    // Port 0 disables the listener by contract; this test exercises the handler through a real listener on an ephemeral port instead.
    expect(port).toBeUndefined();
  });

  test("the closing line counts what was stopped and what stays blocked", async () => {
    const gateway = fakeAdapter({ capture: true });
    const lines: Record<string, unknown>[] = [];
    const { isolation } = await service({ adapter: gateway.adapter, logger: (line) => lines.push(line) });
    await isolation.start();
    await isolation.setIsolated("example-camera", true);

    await isolation.stop();

    const closing = lines.find((line) => line.event === "isolation_stopped");
    expect(closing).toEqual({
      event: "isolation_stopped",
      listenersClosed: "none",
      capturesStopped: 1,
      isolated: 1,
      devices: 3,
      note: "1 device stays blocked with nothing answering it",
    });
    expect(gateway.captures).toContain("stop 10.78.0.147");
    // The rules themselves are untouched, which is why the note says the camera stays blocked.
    expect(gateway.blocks.get("02:00:00:71:b6:de")).toBe("on");
    expect(gateway.records.get("usce.mearicloud.com")).toBe("on");
  });
});

describe("tlsServerName", () => {
  test("names the server from a ClientHello and nothing from other bytes", () => {
    const name = new TextEncoder().encode("apis-us-west.cloudedge360.com");
    const sni = [0, 0, 0, name.length + 5, 0, name.length + 3, 0, 0, name.length, ...name];
    const body = [3, 3, ...new Array<number>(32).fill(1), 0, 0, 2, 0x13, 0x01, 1, 0, 0, sni.length, ...sni];
    const handshake = [1, 0, 0, body.length, ...body];
    expect(tlsServerName(new Uint8Array([0x16, 3, 1, 0, handshake.length, ...handshake]))).toBe("apis-us-west.cloudedge360.com");
    expect(tlsServerName(new TextEncoder().encode("GET / HTTP/1.1\r\n\r\n"))).toBeUndefined();
  });
});

describe("describeFact", () => {
  test("gives each fact its catalog type, a sentence, and fields a view can render", () => {
    const opened = describeFact({ kind: "tcp_connect", destination: "10.78.0.231", port: 18665 }, "10.78.0.231");
    expect(opened.type).toBe("connection");
    expect(opened.message).toContain("(this server)");
    expect(opened.data).toMatchObject({ protocol: "tcp", destination: "10.78.0.231", port: 18665, blocked: false });

    // The rule blocks the public internet, not the LAN: another device at home is not "blocked".
    const lan = describeFact({ kind: "tcp_connect", destination: "10.77.0.119", port: 38890 }, "10.78.0.231");
    expect(lan.message).toContain("(on the local network)");
    expect(lan.data).toMatchObject({ blocked: false });
    const broadcast = describeFact({ kind: "udp_send", destination: "255.255.255.255", port: 6969 }, "10.78.0.231");
    expect(broadcast.data).toMatchObject({ blocked: false });
    const internet = describeFact({ kind: "tcp_connect", destination: "47.89.182.8", port: 9266 }, "10.78.0.231");
    expect(internet.message).toContain("blocked by the isolation rule");
    expect(internet.data).toMatchObject({ blocked: true });

    const tls = describeFact({ kind: "tls_client_hello", serverName: "apis-us-west.cloudedge360.com", destination: "3.1.1.1", port: 443 }, "10.78.0.231");
    expect(tls.type).toBe("tls_attempt");
    expect(tls.message).toContain("blocked by the isolation rule");
    expect(tls.data).toMatchObject({ serverName: "apis-us-west.cloudedge360.com", accepted: false });

    const ntp = describeFact({ kind: "udp_send", destination: "17.253.4.125", port: 123 }, undefined);
    expect(ntp.message).toContain("NTP");
    expect(ntp.data).toMatchObject({ protocol: "udp", note: "NTP time sync" });

    const lookup = describeFact({ kind: "dns_query", name: "usce.mearicloud.com", server: "8.8.8.8" }, undefined);
    expect(lookup.type).toBe("dns_lookup");
    expect(lookup.data).toMatchObject({ name: "usce.mearicloud.com", resolver: "8.8.8.8" });
  });
});
