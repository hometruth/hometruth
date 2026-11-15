import { afterEach, describe, expect, test } from "bun:test";
import { KasaClient, kasaTcpTransport, parseKasaRealtime, parseKasaSysinfo, type KasaTransport } from "./client";
import { decodeKasaFrame, encodeKasaFrame, KasaError } from "./codec";

const DEVICE_ID = "0123456789ABCDEF0123456789ABCDEF01234567";

function fakeTransport(answer: (request: Record<string, unknown>) => unknown) {
  const sent: { host: string; port: number; timeoutMs: number; request: Record<string, unknown> }[] = [];
  const transport: KasaTransport = async (host, port, frame, timeoutMs) => {
    const request = decodeKasaFrame(frame);
    sent.push({ host, port, timeoutMs, request });
    return encodeKasaFrame(answer(request));
  };
  return { transport, sent };
}

describe("KasaClient", () => {
  test("sends to port 9999 with a 5 s timeout by default", async () => {
    const fake = fakeTransport(() => ({ system: { get_sysinfo: { model: "EP10(US)", sw_ver: "1.0", hw_ver: "1.0", deviceId: DEVICE_ID, relay_state: 1, err_code: 0 } } }));
    const info = await new KasaClient("192.168.50.10", { transport: fake.transport }).getSysinfo();
    expect(fake.sent[0]).toEqual({ host: "192.168.50.10", port: 9999, timeoutMs: 5000, request: { system: { get_sysinfo: {} } } });
    expect(info).toMatchObject({ model: "EP10(US)", on: true });
  });

  test("addresses a child outlet with context first", async () => {
    const fake = fakeTransport(() => ({ system: { set_relay_state: { err_code: 0 } } }));
    await new KasaClient("192.168.50.10", { transport: fake.transport }).setRelayState(true, `${DEVICE_ID}01`);
    const request = fake.sent[0]!.request;
    expect(Object.keys(request)).toEqual(["context", "system"]);
    expect(request).toEqual({ context: { child_ids: [`${DEVICE_ID}01`] }, system: { set_relay_state: { state: 1 } } });
  });

  test("a method err_code is a device error", async () => {
    const fake = fakeTransport(() => ({ system: { set_relay_state: { err_code: -3, err_msg: "invalid argument" } } }));
    const failure = new KasaClient("192.168.50.10", { transport: fake.transport }).setRelayState(false);
    await expect(failure).rejects.toMatchObject({ code: "device_error", message: expect.stringContaining("invalid argument") });
  });

  test("a module-level err_code (module not support) is a device error", async () => {
    const fake = fakeTransport(() => ({ emeter: { err_code: -1, err_msg: "module not support" } }));
    await expect(new KasaClient("192.168.50.10", { transport: fake.transport }).getRealtime()).rejects.toMatchObject({ code: "device_error" });
  });

  test("a response missing the requested section is a protocol error", async () => {
    const fake = fakeTransport(() => ({ other: {} }));
    await expect(new KasaClient("192.168.50.10", { transport: fake.transport }).getSysinfo()).rejects.toMatchObject({ code: "protocol" });
    const empty = fakeTransport(() => ({ system: { err_code: 0 } }));
    await expect(new KasaClient("192.168.50.10", { transport: empty.transport }).getSysinfo()).rejects.toMatchObject({ code: "protocol" });
  });

  test("serializes requests per host across clients, but not across hosts", async () => {
    const order: string[] = [];
    const releases: (() => void)[] = [];
    const transport: KasaTransport = async (host, _port, frame) => {
      const tag = `${host}:${JSON.stringify(decodeKasaFrame(frame))}`;
      order.push(`start ${tag}`);
      await new Promise<void>((resolve) => releases.push(resolve));
      order.push(`end ${tag}`);
      return encodeKasaFrame({ system: { set_relay_state: { err_code: 0 } } });
    };
    const a = new KasaClient("192.168.50.20", { transport });
    const b = new KasaClient("192.168.50.20", { transport });
    const other = new KasaClient("192.168.50.21", { transport });
    const first = a.setRelayState(true);
    const second = b.setRelayState(false);
    const third = other.setRelayState(true);
    await Bun.sleep(1);
    expect(order).toEqual([
      'start 192.168.50.20:{"system":{"set_relay_state":{"state":1}}}',
      'start 192.168.50.21:{"system":{"set_relay_state":{"state":1}}}',
    ]);
    releases.shift()!();
    await first;
    await Bun.sleep(1);
    expect(order.at(-1)).toBe('start 192.168.50.20:{"system":{"set_relay_state":{"state":0}}}');
    releases.splice(0).forEach((release) => release());
    await Promise.all([second, third]);
  });

  test("a failed request does not block the next one", async () => {
    let calls = 0;
    const transport: KasaTransport = async () => {
      if (calls++ === 0) throw new KasaError("down", "unreachable");
      return encodeKasaFrame({ system: { set_relay_state: { err_code: 0 } } });
    };
    const client = new KasaClient("192.168.50.22", { transport });
    await expect(client.setRelayState(true)).rejects.toMatchObject({ code: "unreachable" });
    await client.setRelayState(true);
  });
});

describe("parseKasaSysinfo", () => {
  const base = { model: "EP40(US)", sw_ver: "1.0.2 Build 000000 Rel.000000", hw_ver: "1.0", deviceId: DEVICE_ID, alias: "Strip", mac: "00:11:22:33:44:55", err_code: 0 };

  test("reads full child ids, aliases and states in order", () => {
    const info = parseKasaSysinfo({ ...base, children: [{ id: `${DEVICE_ID}00`, alias: "Fountain", state: 0 }, { id: `${DEVICE_ID}01`, alias: "Plug 2", state: 1 }] });
    expect(info.children).toEqual([{ id: `${DEVICE_ID}00`, alias: "Fountain", on: false }, { id: `${DEVICE_ID}01`, alias: "Plug 2", on: true }]);
    expect(info.on).toBeUndefined();
    expect(info.mac).toBe("00:11:22:33:44:55");
  });

  test("expands two-digit child ids to full ids", () => {
    const info = parseKasaSysinfo({ ...base, children: [{ id: "00", state: 0 }, { id: "01", state: 0 }] });
    expect(info.children!.map((child) => child.id)).toEqual([`${DEVICE_ID}00`, `${DEVICE_ID}01`]);
  });

  test("rejects missing or non-binary relay states", () => {
    expect(() => parseKasaSysinfo({ ...base })).toThrow(KasaError);
    expect(() => parseKasaSysinfo({ ...base, relay_state: 2 })).toThrow(KasaError);
    expect(() => parseKasaSysinfo({ ...base, children: [{ id: "00", state: "on" }] })).toThrow(KasaError);
    expect(() => parseKasaSysinfo({ ...base, children: [] })).toThrow(KasaError);
    expect(() => parseKasaSysinfo({ ...base, model: undefined, relay_state: 1 })).toThrow(KasaError);
  });
});

describe("parseKasaRealtime", () => {
  test("converts current milli-unit fields", () => {
    expect(parseKasaRealtime({ power_mw: 12345, voltage_mv: 120500, current_ma: 103, total_wh: 4567, err_code: 0 }))
      .toEqual({ powerW: 12.345, voltageV: 120.5, currentA: 0.103, energyKWh: 4.567 });
  });

  test("accepts older float fields in W, V, A and kWh", () => {
    expect(parseKasaRealtime({ power: 12.3, voltage: 120.1, current: 0.1, total: 4.5, err_code: 0 }))
      .toEqual({ powerW: 12.3, voltageV: 120.1, currentA: 0.1, energyKWh: 4.5 });
  });

  test("omits missing or non-numeric fields", () => {
    expect(parseKasaRealtime({ power_mw: 0, voltage: "x", err_code: 0 })).toEqual({ powerW: 0 });
  });
});

describe("kasaTcpTransport (loopback)", () => {
  let server: { stop(force?: boolean): void } | undefined;
  afterEach(() => { server?.stop(true); server = undefined; });
  const listen = (data: (socket: { write(bytes: Uint8Array): number; end(): void }) => void): number => {
    const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data } });
    server = listener;
    return listener.port;
  };

  test("reassembles a response delivered in pieces", async () => {
    const response = encodeKasaFrame({ system: { get_sysinfo: { err_code: 0, alias: "x".repeat(3000) } } });
    const port = listen((socket) => {
      socket.write(response.subarray(0, 2));
      setTimeout(() => { socket.write(response.subarray(2, 1500)); }, 5);
      setTimeout(() => { socket.write(response.subarray(1500)); }, 10);
    });
    const frame = await kasaTcpTransport("127.0.0.1", port, encodeKasaFrame({ system: { get_sysinfo: {} } }), 2000);
    expect(decodeKasaFrame(frame)).toEqual({ system: { get_sysinfo: { err_code: 0, alias: "x".repeat(3000) } } });
  });

  test("times out as unreachable when the device never answers", async () => {
    const port = listen(() => { /* silent */ });
    await expect(kasaTcpTransport("127.0.0.1", port, encodeKasaFrame({}), 100)).rejects.toMatchObject({ code: "unreachable" });
  });

  test("a connection closed mid-frame is unreachable", async () => {
    const port = listen((socket) => { socket.write(new Uint8Array([0, 0, 0, 50, 1, 2])); socket.end(); });
    await expect(kasaTcpTransport("127.0.0.1", port, encodeKasaFrame({}), 2000)).rejects.toMatchObject({ code: "unreachable" });
  });
});
