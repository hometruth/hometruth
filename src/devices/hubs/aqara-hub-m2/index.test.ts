import { describe, expect, test } from "bun:test";
import type { ConnectionState } from "../../../vendors/aqara/connection";
import type { MatterSnapshot } from "../../../protocols/matter/snapshot";
import { MatterService, type SubscribeMatter } from "../../../vendors/aqara/matter-service";
import { AqaraMatterConnection } from "../../../vendors/aqara/matter";
import { AqaraHubM2 } from "./index";

function fixture(): MatterSnapshot {
  return { observedAt: "2026-09-15T00:00:00.000Z", attributes: [
    { endpoint: 0, cluster: 40, attribute: 2, value: 4447 },
    { endpoint: 0, cluster: 40, attribute: 4, value: 2050 },
  ] };
}

/** A fake `subscribeMatter`: captures the report callback so a test can push snapshots. */
function fakeSubscribeDevice(): { subscribeDevice: SubscribeMatter; report: (peerId: string, snapshot: MatterSnapshot) => void } {
  const reporters = new Map<string, (snapshot: MatterSnapshot) => void>();
  const subscribeDevice: SubscribeMatter = (peerId, onReport) => {
    reporters.set(peerId, onReport);
    return { stop: () => {} };
  };
  return { subscribeDevice, report: (peerId, snapshot) => reporters.get(peerId)?.(snapshot) };
}

describe("AqaraHubM2 reading from the site-wide MatterService", () => {
  test("reads through the service's connection for its configured peer", async () => {
    const { subscribeDevice, report } = fakeSubscribeDevice();
    const changes: [string, ConnectionState][] = [];
    const service = new MatterService(["peer1"], (peerId, state) => changes.push([peerId, state]), subscribeDevice);
    const hub = new AqaraHubM2({ id: "hub", name: "Hub" }, { matterPeerId: "peer1" }, undefined, service);
    expect(hub.source).toBe(service.connectionFor("peer1")!);
    const pending = hub.source.read();
    report("peer1", fixture());
    expect((await pending).availability).toBe("online");
    expect(changes).toEqual([["peer1", { availability: "online", matter: fixture() }]]);
  });

  test("a hub whose peer the service was never given gets a dormant source, never a new connection", async () => {
    const service = new MatterService([], () => {});
    const hub = new AqaraHubM2({ id: "hub", name: "Hub" }, { matterPeerId: "peer1" }, undefined, service);
    expect(hub.source).not.toBeInstanceOf(AqaraMatterConnection);
    expect((await hub.source.read()).availability).toBe("unknown");
  });

  test("a hub built without any MatterService (the preview site) gets a dormant source", async () => {
    const hub = new AqaraHubM2({ id: "hub", name: "Hub" }, { matterPeerId: "peer1" }, undefined, undefined);
    expect(hub.source).not.toBeInstanceOf(AqaraMatterConnection);
    expect((await hub.source.read()).availability).toBe("unknown");
  });
});
