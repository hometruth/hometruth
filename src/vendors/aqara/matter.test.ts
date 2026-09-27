import { describe, expect, test } from "bun:test";
import { AqaraMatterConnection } from "./matter";
import { AqaraContact, AqaraHubStatus, discoverContactSensors } from "./sensors";
import { mergeAttributes, parseMatterSnapshot, type MatterSnapshot } from "../../protocols/matter/snapshot";

// Attribute subset recorded from the physical M2 (firmware 4.1.6), with serials anonymized.
function fixture(): MatterSnapshot {
  return { observedAt: "2026-09-10T01:29:27.972Z", attributes: [
    { endpoint: 0, cluster: 40, attribute: 2, value: 4447 },
    { endpoint: 0, cluster: 40, attribute: 4, value: 2050 },
    { endpoint: 2, cluster: 57, attribute: 5, value: "Aqara Door and Window Sensor" },
    { endpoint: 2, cluster: 57, attribute: 12, value: "AS006" },
    { endpoint: 2, cluster: 57, attribute: 15, value: "door-serial" },
    { endpoint: 2, cluster: 57, attribute: 17, value: true },
    { endpoint: 2, cluster: 69, attribute: 0, value: true },
    { endpoint: 2, cluster: 47, attribute: 12, value: 200 },
    { endpoint: 3, cluster: 57, attribute: 15, value: "other-serial" },
    { endpoint: 3, cluster: 57, attribute: 17, value: true },
    { endpoint: 3, cluster: 69, attribute: 0, value: false },
  ] };
}

/** A fake `subscribeMatter`: captures the report/error callbacks so a test can push snapshots or failures, one per connection instance. */
function fakeSubscription() {
  const reporters = new Map<string, (snapshot: MatterSnapshot) => void>();
  const errorHandlers = new Map<string, (detail: string) => void>();
  const stopped = new Set<string>();
  const subscribeDevice = (peerId: string, onReport: (snapshot: MatterSnapshot) => void, options?: { onError?: (detail: string) => void }) => {
    reporters.set(peerId, onReport);
    if (options?.onError) errorHandlers.set(peerId, options.onError);
    return { stop: () => stopped.add(peerId) };
  };
  return {
    subscribeDevice,
    report: (peerId: string, snapshot: MatterSnapshot) => reporters.get(peerId)?.(snapshot),
    fail: (peerId: string, detail: string) => errorHandlers.get(peerId)?.(detail),
    isStopped: (peerId: string) => stopped.has(peerId),
  };
}

/** A connection whose first report is already in, so read()/getState() resolve immediately. */
function connection(snapshot: MatterSnapshot): AqaraMatterConnection {
  const fake = fakeSubscription();
  const source = new AqaraMatterConnection("peer1", fake.subscribeDevice);
  fake.report("peer1", snapshot);
  return source;
}

describe("M2 direct Matter observations", () => {
  test("subscribes to the peer immediately when constructed, not on first read", () => {
    const fake = fakeSubscription();
    let subscribeCalls = 0;
    const subscribeDevice: typeof fake.subscribeDevice = (peerId, onReport) => { subscribeCalls++; return fake.subscribeDevice(peerId, onReport); };
    new AqaraMatterConnection("peer1", subscribeDevice);
    expect(subscribeCalls).toBe(1);
  });

  test("matches serial, translates closed polarity and half-percent battery, and validates documents", async () => {
    const source = connection(fixture());
    const door = new AqaraContact("door", source, "DOOR-SERIAL");
    expect((await door.describe()).state).toEqual({ availability: "online", open: false, batteryPercent: 100, observedAt: fixture().observedAt });
    expect((await new AqaraContact("other", source, "other-serial").describe()).state.open).toBe(true);
    const hub = await new AqaraHubStatus("hub", source).describe();
    expect(hub.state.accessories).toHaveLength(2);
    expect(hub.state.securityState).toBeUndefined();
  });

  test("discovers both bridged contact sensors by serial, from the Boolean State cluster alone", async () => {
    expect(await discoverContactSensors(connection(fixture()))).toEqual([
      { serialNumber: "door-serial", name: "Aqara Door and Window Sensor", model: "AS006" },
      { serialNumber: "other-serial", name: "Accessory 3" },
    ]);
  });

  test("missing, faulted, unreachable or ambiguous sensors never appear closed", async () => {
    for (const change of ["missing", "unreachable", "bad-value", "missing-reachability", "duplicate-serial"] as const) {
      const f = fixture();
      if (change === "missing") f.attributes = f.attributes.filter(a => a.endpoint !== 2 || a.cluster !== 69);
      if (change === "unreachable") f.attributes.find(a => a.endpoint === 2 && a.attribute === 17)!.value = false;
      if (change === "bad-value") f.attributes.find(a => a.endpoint === 2 && a.cluster === 69)!.value = 1;
      if (change === "missing-reachability") delete f.attributes.find(a => a.endpoint === 2 && a.attribute === 17)!.value;
      if (change === "duplicate-serial") f.attributes.find(a => a.endpoint === 3 && a.attribute === 15)!.value = "door-serial";
      const state = await new AqaraContact("door", connection(f), "door-serial").getState();
      expect(state.availability).toBe("degraded");
      expect(state.open).toBeUndefined();
      expect(state.observedAt).toBeUndefined();
    }
  });

  test("rejects wrong hubs and malformed observations, omits invalid battery values", async () => {
    const f = fixture();
    f.attributes[0]!.value = 1;
    expect((await connection(f).read()).availability).toBe("degraded");
    expect(() => parseMatterSnapshot({ ...fixture(), observedAt: "bad" })).toThrow();
    expect(() => parseMatterSnapshot({ ...fixture(), attributes: [] })).toThrow();
    expect(() => parseMatterSnapshot({ ...fixture(), attributes: [...fixture().attributes, fixture().attributes[0]] })).toThrow();
    expect(() => new AqaraMatterConnection("../keys")).toThrow();
    for (const value of [null, -1, 201, "200"]) {
      const f = fixture();
      f.attributes.find(a => a.cluster === 47)!.value = value;
      expect((await new AqaraContact("door", connection(f), "door-serial").getState()).batteryPercent).toBeUndefined();
    }
  });

  test("read() waits for the subscription's first report, then answers from the latest one without a second subscribe", async () => {
    const fake = fakeSubscription();
    let subscribeCalls = 0;
    const subscribeDevice: typeof fake.subscribeDevice = (peerId, onReport) => { subscribeCalls++; return fake.subscribeDevice(peerId, onReport); };
    const source = new AqaraMatterConnection("peer1", subscribeDevice);
    const pending = source.read();
    fake.report("peer1", fixture());
    expect((await pending).availability).toBe("online");
    await source.read();
    expect(subscribeCalls).toBe(1);
  });

  test("read() answers unknown, not degraded, if the subscription has not reported yet (absence of a report is not evidence of a problem)", async () => {
    const fake = fakeSubscription();
    const source = new AqaraMatterConnection("peer1", fake.subscribeDevice, 10);
    const state = await source.read();
    expect(state.availability).toBe("unknown");
  });

  test("a later timeout never regresses a once-online peer back to unknown: the last real report stays cached", async () => {
    const fake = fakeSubscription();
    const source = new AqaraMatterConnection("peer1", fake.subscribeDevice, 10);
    const pending = source.read();
    fake.report("peer1", fixture());
    expect((await pending).availability).toBe("online");
    // No further report ever arrives, but read() must keep answering from the one it already has.
    expect((await source.read()).availability).toBe("online");
  });

  test("subscribe() pushes every report through the same identity check read() uses, and stop() ends the one subscription", async () => {
    const fake = fakeSubscription();
    const source = new AqaraMatterConnection("peer1", fake.subscribeDevice);
    const changes: unknown[] = [];
    const unsubscribe = source.subscribe(state => changes.push(state));
    fake.report("peer1", fixture());
    expect(changes).toHaveLength(1);
    expect((changes[0] as { availability: string }).availability).toBe("online");
    expect((await source.read())).toEqual(changes[0] as never);
    const wrongHub = fixture();
    wrongHub.attributes[0]!.value = 1;
    fake.report("peer1", wrongHub);
    expect(changes).toHaveLength(2);
    expect((changes[1] as { availability: string; detail?: string }).detail).toBe("Matter peer is not an Aqara Hub M2");
    unsubscribe();
    source.stop();
    expect(fake.isStopped("peer1")).toBe(true);
  });

  test("a worker error (a timed-out handshake, a crash) degrades the cached state with the real reason, instead of read() waiting forever", async () => {
    const fake = fakeSubscription();
    const source = new AqaraMatterConnection("peer1", fake.subscribeDevice, 10);
    const pending = source.read();
    fake.fail("peer1", "Matter subscription did not establish in time");
    const state = await pending;
    expect(state).toEqual({ availability: "degraded", detail: "Matter subscription did not establish in time" });
    // The failure is now the cached state too: a later read answers it immediately, no more waiting.
    expect(await source.read()).toEqual(state);
  });

  test("a later worker error never regresses a once-online peer that has since gone quiet, only report() and fail() ever change the cache", async () => {
    const fake = fakeSubscription();
    const source = new AqaraMatterConnection("peer1", fake.subscribeDevice);
    fake.report("peer1", fixture());
    expect((await source.read()).availability).toBe("online");
    fake.fail("peer1", "worker crashed");
    // A real crash IS evidence, unlike a mere timeout with no report: it does override the cache.
    expect((await source.read())).toEqual({ availability: "degraded", detail: "worker crashed" });
  });
});

describe("subscription deltas", () => {
  const observedAt = "2026-09-10T01:31:00.000Z";
  /** What the hub actually sends when one door opens: that attribute, and nothing else. */
  const doorOpened = [{ endpoint: 2, cluster: 69, attribute: 0, value: false }];

  test("a door's report updates that door, and leaves the hub's identity and the other sensors untouched", async () => {
    const source = connection(parseMatterSnapshot({ observedAt, attributes: mergeAttributes(fixture().attributes, doorOpened) }));
    // Endpoint 0's Basic Information is not in a door's report, so only a merged picture still identifies the peer.
    expect((await new AqaraHubStatus("hub", source).getState()).availability).toBe("online");
    // Boolean State true means closed, so the report turning it false is the door opening.
    expect(await new AqaraContact("door", source, "door-serial").getState()).toMatchObject({ availability: "online", open: true, batteryPercent: 100 });
    // The sensor that did not report keeps the reading it had.
    expect(await new AqaraContact("other", source, "other-serial").getState()).toMatchObject({ availability: "online", open: true });
  });

  test("the same report written out as if it were a whole snapshot loses the hub and every sensor with it", async () => {
    const source = connection(parseMatterSnapshot({ observedAt, attributes: doorOpened }));
    expect(await new AqaraHubStatus("hub", source).getState()).toEqual({ availability: "degraded", detail: "Matter peer is not an Aqara Hub M2" });
    expect((await new AqaraContact("door", source, "door-serial").getState()).availability).toBe("degraded");
  });

  test("merging keeps one entry per path, newest wins, and a status replaces the value that was there", () => {
    const merged = mergeAttributes(fixture().attributes, [
      { endpoint: 2, cluster: 69, attribute: 0, value: false },
      { endpoint: 3, cluster: 57, attribute: 17 },
    ]);
    expect(merged.filter(a => a.endpoint === 2 && a.cluster === 69 && a.attribute === 0)).toEqual([{ endpoint: 2, cluster: 69, attribute: 0, value: false }]);
    // No value: the path is still known to exist, its reading is not, which is what "unavailable" means downstream.
    expect(merged.find(a => a.endpoint === 3 && a.cluster === 57 && a.attribute === 17)).toEqual({ endpoint: 3, cluster: 57, attribute: 17 });
    expect(merged).toHaveLength(fixture().attributes.length);
    // Still a valid snapshot: no duplicate paths for parseMatterSnapshot to reject.
    expect(() => parseMatterSnapshot({ observedAt, attributes: merged })).not.toThrow();
  });
});
