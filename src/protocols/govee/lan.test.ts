import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Socket } from "node:dgram";
import { assertGoveeHost, GoveeLanBus, parseGoveeScan, parseGoveeStatus } from "./lan";

export const SCAN = { ip: "10.77.0.80", sku: "H7021", device: "AA:BB:CC:DD:EE:FF:00:11", bleVersionHard: "3.01.01", bleVersionSoft: "1.00.14", wifiVersionHard: "1.00.10", wifiVersionSoft: "1.02.11" };
export const STATUS = { onOff: 1 as const, brightness: 100, color: { r: 255, g: 127, b: 0 }, colorTemInKelvin: 0 };

class DatagramSocket extends EventEmitter {
  readonly packets: { body: unknown; port: number; host: string }[] = [];
  bound = 0;
  bind(port: number, _address: string, callback: () => void) { this.bound = port; queueMicrotask(callback); }
  unref() {}
  close() {}
  send(bytes: Buffer, port: number, host: string, callback: (error?: Error) => void) { this.packets.push({ body: JSON.parse(bytes.toString()), port, host }); callback(); }
  reply(host: string, cmd: string, data: unknown) { this.emit("message", Buffer.from(JSON.stringify({ msg: { cmd, data } })), { address: host, port: 49155 }); }
}

describe("Govee local protocol", () => {
  test("decodes the observed discovery and status, rejects malformed replies and public hosts", () => {
    expect(parseGoveeScan(SCAN)).toEqual(SCAN);
    expect(parseGoveeStatus(STATUS)).toEqual(STATUS);
    for (const state of [null, [], {}, { ...STATUS, brightness: 101 }, { ...STATUS, onOff: true }, { ...STATUS, color: { r: 256, g: 0, b: 0 } }]) expect(() => parseGoveeStatus(state)).toThrow();
    expect(() => parseGoveeScan({ ...SCAN, sku: null })).toThrow();
    for (const host of ["8.8.8.8", "127.0.0.1", "govee.com", "10.77.0.80:4003", "192.168.999.1", "169.254.1.1"]) expect(() => assertGoveeHost(host)).toThrow();
    for (const host of ["10.77.0.80", "10.0.0.2", "172.16.0.2", "172.31.1.1"]) expect(() => assertGoveeHost(host)).not.toThrow();
  });
  test("one receiver matches the source IP and command, coalesces reads, and uses the correct ports", async () => {
    const socket = new DatagramSocket();
    const bus = new GoveeLanBus(() => socket as unknown as Socket);
    try {
      const first = bus.request(SCAN.ip, "scan", 1000);
      const second = bus.request(SCAN.ip, "scan", 1000);
      const status = bus.request("10.77.0.81", "devStatus", 1000);
      await Bun.sleep(1);
      expect(socket.bound).toBe(4002);
      expect(socket.packets).toEqual([
        { body: { msg: { cmd: "scan", data: { account_topic: "reserve" } } }, port: 4001, host: SCAN.ip },
        { body: { msg: { cmd: "devStatus", data: {} } }, port: 4003, host: "10.77.0.81" },
      ]);
      socket.reply("10.77.0.81", "scan", { incorrect: true });
      socket.emit("message", Buffer.from("not json"), { address: SCAN.ip });
      socket.reply(SCAN.ip, "scan", SCAN);
      socket.reply("10.77.0.81", "devStatus", STATUS);
      expect(await Promise.all([first, second, status])).toEqual([SCAN, SCAN, STATUS]);
      await bus.send(SCAN.ip, "turn", { value: 0 });
      expect(socket.packets.at(-1)).toEqual({ body: { msg: { cmd: "turn", data: { value: 0 } } }, port: 4003, host: SCAN.ip });
    } finally { bus.close(); }
  });
  test("times out and clears pending reads so a later request can recover", async () => {
    const socket = new DatagramSocket();
    const bus = new GoveeLanBus(() => socket as unknown as Socket);
    try {
      await expect(bus.request(SCAN.ip, "devStatus", 100)).rejects.toThrow("timed out");
      const next = bus.request(SCAN.ip, "devStatus", 100);
      await Bun.sleep(1); socket.reply(SCAN.ip, "devStatus", STATUS);
      expect(await next).toEqual(STATUS);
      await expect(bus.request("8.8.8.8", "scan", 100)).rejects.toThrow("private LAN");
    } finally { bus.close(); }
  });
});
