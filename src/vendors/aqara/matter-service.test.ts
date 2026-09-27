import { describe, expect, test } from "bun:test";
import type { MatterSnapshot } from "../../protocols/matter/snapshot";
import { MatterService, type SubscribeMatter } from "./matter-service";
import { AqaraMatterConnection } from "./matter";

function fixture(): MatterSnapshot {
  return { observedAt: "2026-09-15T00:00:00.000Z", attributes: [
    { endpoint: 0, cluster: 40, attribute: 2, value: 4447 },
    { endpoint: 0, cluster: 40, attribute: 4, value: 2050 },
  ] };
}

function fakeSubscribeDevice(): { subscribeDevice: SubscribeMatter; report: (peerId: string, snapshot: MatterSnapshot) => void; isStopped: (peerId: string) => boolean } {
  const reporters = new Map<string, (snapshot: MatterSnapshot) => void>();
  const stopped = new Set<string>();
  const subscribeDevice: SubscribeMatter = (peerId, onReport) => {
    reporters.set(peerId, onReport);
    return { stop: () => stopped.add(peerId) };
  };
  return { subscribeDevice, report: (peerId, snapshot) => reporters.get(peerId)?.(snapshot), isStopped: peerId => stopped.has(peerId) };
}

describe("MatterService", () => {
  test("opens one connection per configured peer immediately, deduplicated", () => {
    const { subscribeDevice } = fakeSubscribeDevice();
    let subscribeCalls = 0;
    const counting: SubscribeMatter = (peerId, onReport) => { subscribeCalls++; return subscribeDevice(peerId, onReport); };
    const service = new MatterService(["peer1", "peer2", "peer1"], () => {}, counting);
    expect(subscribeCalls).toBe(2);
    expect(service.connectionFor("peer1")).toBeInstanceOf(AqaraMatterConnection);
    expect(service.connectionFor("peer2")).toBeInstanceOf(AqaraMatterConnection);
    expect(service.connectionFor("peer3")).toBeUndefined();
  });

  test("calls onChange with the peer id and state on every report", async () => {
    const { subscribeDevice, report } = fakeSubscribeDevice();
    const changes: [string, string][] = [];
    const service = new MatterService(["peer1"], (peerId, state) => changes.push([peerId, state.availability]), subscribeDevice);
    report("peer1", fixture());
    expect(changes).toEqual([["peer1", "online"]]);
    await service.connectionFor("peer1")!.read();
  });

  test("status() is unknown with no peers, unknown until any peer has reported, online once every reporting peer agrees, degraded on a mix", () => {
    const empty = new MatterService([], () => {});
    expect(empty.status().availability).toBe("unknown");

    const { subscribeDevice, report } = fakeSubscribeDevice();
    const service = new MatterService(["peer1", "peer2"], () => {}, subscribeDevice);
    expect(service.status().availability).toBe("unknown");
    report("peer1", fixture());
    // peer2 has not reported yet, so it does not count against peer1's good report.
    expect(service.status().availability).toBe("online");
    const wrongHub = fixture();
    wrongHub.attributes[0]!.value = 1;
    report("peer2", wrongHub);
    expect(service.status().availability).toBe("degraded");
  });

  test("records an event per report: matter_state_changed when online, matter_connection_degraded otherwise", () => {
    const { subscribeDevice, report } = fakeSubscribeDevice();
    const service = new MatterService(["peer1"], () => {}, subscribeDevice);
    report("peer1", fixture());
    const wrongHub = fixture();
    wrongHub.attributes[0]!.value = 1;
    report("peer1", wrongHub);
    const events = service.events();
    expect(events.map(event => event.type)).toEqual(["matter_connection_degraded", "matter_state_changed"]);
    expect(events.every(event => event.subject === "peer1")).toBe(true);
  });

  test("subjects() lists every configured peer", async () => {
    const { subscribeDevice } = fakeSubscribeDevice();
    const service = new MatterService(["peer1", "peer2"], () => {}, subscribeDevice);
    expect(service.subjects()).toEqual(["peer1", "peer2"]);
    await service.stop();
  });

  test("stop() ends every peer's subscription and reports offline afterward", async () => {
    const { subscribeDevice, isStopped } = fakeSubscribeDevice();
    const service = new MatterService(["peer1", "peer2"], () => {}, subscribeDevice);
    await service.stop();
    expect(isStopped("peer1")).toBe(true);
    expect(isStopped("peer2")).toBe(true);
    expect(service.status()).toEqual({ availability: "offline", detail: "Stopped" });
  });
});
