import { describe, expect, test } from "bun:test";
import { RingAssetConnection, flattenDeviceDocument } from "./asset-socket";
import { RingClient, RingError, RING_OAUTH } from "./client";
import { FakeRingSocket, RING_ASSET, RING_LOCATION, beamLight, oauthResponse, storedToken, ticketResponse } from "./test-fixtures";

function fixture(options: { assets?: unknown[] } = {}) {
  const sockets: FakeRingSocket[] = [];
  const reconnects: (() => void)[] = [];
  const client = new RingClient(storedToken("refresh-1"), {
    fetch: async url => {
      if (url.href === RING_OAUTH) return oauthResponse();
      if (url.pathname.endsWith("/clap/tickets")) return ticketResponse(options.assets);
      return new Response(null, { status: 500 });
    },
  });
  const connection = new RingAssetConnection(client, RING_LOCATION, {
    socket: url => { const socket = new FakeRingSocket(url); sockets.push(socket); return socket; },
    schedule: run => { reconnects.push(run); },
    now: () => new Date("2026-09-18T12:00:00.000Z"),
  });
  return { connection, sockets, reconnects, socket: () => sockets[sockets.length - 1]! };
}

/** The socket only exists after the ticket round-trip, so wait for it rather than counting ticks. */
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** Drive a connection to online with the given devices, the way Ring's handshake goes. */
async function connect(f: ReturnType<typeof fixture>, documents: unknown[]) {
  const before = f.sockets.length;
  const ready = f.connection.ready();
  await until(() => f.sockets.length > before, "a socket");
  f.socket().open();
  f.socket().deviceList(documents);
  await ready;
}

describe("flattenDeviceDocument", () => {
  test("unions general.v2 and device.v1, which is where Ring splits a device", () => {
    expect(flattenDeviceDocument(beamLight("zid-1", "Spotlight", { on: true, level: 0.5 })))
      .toEqual({ zid: "zid-1", name: "Spotlight", deviceType: "switch.multilevel.beams", on: true, level: 0.5 });
  });

  test("keeps a partial update partial, so a merge cannot erase what it omits", () => {
    expect(flattenDeviceDocument({ general: { v2: { zid: "zid-1" } }, device: { v1: { on: false } } })).toEqual({ zid: "zid-1", on: false });
  });

  test("anything without a zid is not a device", () => {
    expect(flattenDeviceDocument({ device: { v1: { on: true } } })).toBeUndefined();
    expect(flattenDeviceDocument("nonsense")).toBeUndefined();
  });
});

describe("RingAssetConnection", () => {
  test("asks each hub for its devices and comes online once they answer", async () => {
    const f = fixture();
    await connect(f, [beamLight("zid-1", "Spotlight", { on: false, level: 0.4 })]);
    expect(f.socket().url).toBe("wss://ws.example.ring.com/ws?authcode=ticket-1&ack=false");
    expect(f.socket().frames()[0]!.msg).toMatchObject({ msg: "DeviceInfoDocGetList", dst: RING_ASSET });
    const state = f.connection.state();
    expect(state.availability).toBe("online");
    expect(state.observedAt).toBe("2026-09-18T12:00:00.000Z");
    expect(f.connection.device("zid-1")).toEqual({ zid: "zid-1", name: "Spotlight", deviceType: "switch.multilevel.beams", on: false, level: 0.4 });
  });

  test("merges a partial update onto what it already knows, and tells subscribers", async () => {
    const f = fixture();
    await connect(f, [beamLight("zid-1", "Spotlight", { on: false, level: 0.4 })]);
    let changes = 0;
    f.connection.subscribe(() => { changes++; });
    f.socket().dataUpdate([{ general: { v2: { zid: "zid-1" } }, device: { v1: { on: true } } }]);
    expect(changes).toBe(1);
    // The name and type survive an update that mentioned neither.
    expect(f.connection.device("zid-1")).toEqual({ zid: "zid-1", name: "Spotlight", deviceType: "switch.multilevel.beams", on: true, level: 0.4 });
  });

  test("ignores an update for a device it cannot classify, rather than half-inventing one", async () => {
    const f = fixture();
    await connect(f, []);
    let changes = 0;
    f.connection.subscribe(() => { changes++; });
    f.socket().dataUpdate([{ general: { v2: { zid: "ghost" } }, device: { v1: { on: true } } }]);
    expect(changes).toBe(0);
    expect(f.connection.device("ghost")).toBeUndefined();
  });

  test("a dropped socket is an outage: no last-known values are served from it", async () => {
    const f = fixture();
    await connect(f, [beamLight("zid-1", "Spotlight", { on: true })]);
    let changes = 0;
    f.connection.subscribe(() => { changes++; });
    f.socket().close();
    expect(changes).toBe(1);
    const state = f.connection.state();
    expect(state.availability).toBe("offline");
    expect(state.detail).toBe("The Ring connection closed");
    expect(state.devices.size).toBe(0);
    expect(f.connection.device("zid-1")).toBeUndefined();
  });

  test("schedules a reconnect after a drop and comes back on it", async () => {
    const f = fixture();
    await connect(f, [beamLight("zid-1", "Spotlight", { on: true })]);
    f.socket().close();
    expect(f.reconnects).toHaveLength(1);
    f.reconnects[0]!();
    await until(() => f.sockets.length === 2, "a second socket");
    f.socket().open();
    f.socket().deviceList([beamLight("zid-1", "Spotlight", { on: false })]);
    await until(() => f.connection.state().availability === "online", "the connection to come back");
    expect(f.connection.device("zid-1")).toMatchObject({ on: false });
  });

  test("addresses a write to the bridge that reported the device", async () => {
    const f = fixture();
    await connect(f, [beamLight("zid-1", "Spotlight", { on: false })]);
    await f.connection.setDevice("zid-1", { on: true });
    const last = f.socket().frames().at(-1)!;
    expect(last.channel).toBe("message");
    expect(last.msg).toMatchObject({ msg: "DeviceInfoSet", datatype: "DeviceInfoSetType", dst: RING_ASSET, body: [{ zid: "zid-1", device: { v1: { on: true } } }] });
  });

  test("gives every frame its own sequence number", async () => {
    const f = fixture();
    await connect(f, []);
    await f.connection.setDevice("zid-1", { on: true });
    await f.connection.setDevice("zid-1", { on: false });
    const seqs = f.socket().frames().map(frame => (frame.msg as { seq?: number }).seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  test("a location with no Bridge says so instead of opening a socket", async () => {
    const f = fixture({ assets: [] });
    const error = await f.connection.ready().catch((e: unknown) => e) as RingError;
    expect(error).toBeInstanceOf(RingError);
    expect(error.message).toContain("no Bridge");
    expect(f.sockets).toHaveLength(0);
  });

  test("survives a frame that is not JSON", async () => {
    const f = fixture();
    await connect(f, [beamLight("zid-1", "Spotlight", { on: true })]);
    f.socket().deliver("<html>rate limited</html>");
    expect(f.connection.state().availability).toBe("online");
  });

  test("closing stops it answering and stops it reconnecting", async () => {
    const f = fixture();
    await connect(f, [beamLight("zid-1", "Spotlight", { on: true })]);
    f.connection.close();
    expect(f.connection.state().availability).toBe("unknown");
    expect(f.reconnects).toHaveLength(0);
    await expect(f.connection.ready()).rejects.toThrow(RingError);
  });
});
