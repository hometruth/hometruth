import { describe, expect, test } from "bun:test";
import { StateHub } from "./hub";
import { STATE_HUB_SERVICE_ID, StateHubService } from "./service";
import { deviceNode } from "./protocol";
import { Site } from "../site";
import { buildGraph, collectSnapshot } from "../graph/build";
import { elementKey } from "../tags/identity";
import { otherEnd, relationAsSeenFrom } from "../graph/types";

describe("state hub service", () => {
  test("reports its generation, open streams and what it is watching", () => {
    const hub = new StateHub({ generation: "test-1" });
    const service = new StateHubService(hub);
    expect(service.id).toBe(STATE_HUB_SERVICE_ID);
    expect(service.status().availability).toBe("online");
    expect(service.status().detail).toContain("test-1");
    expect(service.subjects()).toEqual([]);

    hub.observer.retain(deviceNode("relay"), "glance");
    expect(service.subjects()).toEqual(["relay"]);
    expect(service.status().detail).toContain("watching 1 node");
    hub.stop();
  });

  test("keeps its own log, so what it just did is visible without the console", () => {
    const hub = new StateHub({ generation: "test-2" });
    const service = new StateHubService(hub);
    expect(service.events()).toEqual([]);
    service.bound({ devices: 4, pushSources: 1 });
    service.streamRefused();
    const events = service.events();
    expect(events.map((event) => event.type).sort()).toEqual(["state_binding", "state_stream"]);
    expect(events.find((event) => event.type === "state_binding")?.message).toContain("4 devices");
    expect(events.find((event) => event.type === "state_stream")?.level).toBe("warn");
    hub.stop();
  });
});

describe("sourcedBy edges", () => {
  test("a device says what maintains its state, and whether it had to be asked", async () => {
    const hub = new StateHub();
    const service = new StateHubService(hub);
    const site = Site.fromConfig(
      { schemaVersion: 2, devices: [{ id: "relay", name: "Relay", model: "shelly-plus-1", config: { host: "10.77.0.2" } }] },
      { stateHub: service },
    );
    const graph = buildGraph(await collectSnapshot({ site }));
    const relay = elementKey("device", "relay");
    const edge = graph.edgesOf(relay).find((candidate) => candidate.relation === "sourcedBy")!;
    expect(edge).toBeDefined();
    expect(relationAsSeenFrom(edge, relay)).toBe("sourcedBy");
    expect(graph.node(otherEnd(edge, relay))?.name).toBe("State hub");
    // A Shelly has no push path, so the hub has to poll it.
    expect(edge.label).toBe("poll");
    expect(edge.origin).toBe("source");
    hub.stop();
  });

  test("nothing claims a source when no hub is registered", async () => {
    const site = Site.fromConfig({ schemaVersion: 2, devices: [{ id: "relay", name: "Relay", model: "shelly-plus-1", config: { host: "10.77.0.2" } }] });
    const graph = buildGraph(await collectSnapshot({ site }));
    expect(graph.edges().some((edge) => edge.relation === "sourcedBy")).toBe(false);
  });
});
