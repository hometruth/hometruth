import { describe, expect, test } from "bun:test";
import { Site } from "../site";
import { CAPABILITY_ICONS, KIND_ICONS, dominantCapability, iconFor, parseIcon } from "./icons";
import { buildGraph, collectSnapshot } from "./build";
import { tagNameNode, tagNode } from "./tag-graph";
import { TagStore } from "../tags/store";
import { migrateRoomsToTags } from "../tags/room-migration";
import { ROOM } from "../tags/model";
import { catalogNode, siteNode } from "./instance-graph";
import { eventTypeNode, modelNode, schemaGraph, schemaNode } from "./schema-graph";
import { eventSchema } from "../models/event-schema";
import { eventType } from "../models/event-types";
import { filterSchema } from "../models/filter-schema";
import { CAPABILITY_KINDS } from "../models/capability";
import { ELEMENT_KINDS, elementKey } from "../tags/identity";
import { binarySwitchSchema } from "../schemas";
import { otherEnd, relationAsSeenFrom, RELATION_NAMES, inverseOf, type GraphEdge } from "./types";
import type { Graph } from "./graph";

/**
 * The plan's acceptance case, and the real shape in `devices.yml`: a
 * switch made of two buttons, both of which drive one blaster.
 */
const FIREPLACE = {
  schemaVersion: 2 as const,
  rooms: ["Lounge"],
  devices: [
    { id: "blaster", name: "Blaster", room: "Lounge", model: "broadlink-rm4-pro", config: { host: "10.78.0.30" } },
    { id: "candle-on", name: "Candle on", model: "action-button", config: { device: "blaster", control: "infraredBlaster.send" } },
    { id: "candle-off", name: "Candle off", model: "action-button", config: { device: "blaster", control: "infraredBlaster.send" } },
    { id: "fireplace", name: "Fireplace candles", room: "Lounge", model: "optimistic-switch", config: { onButton: "candle-on", offButton: "candle-off" } },
  ],
};

async function fireplaceGraph(): Promise<Graph> {
  const site = Site.fromConfig(FIREPLACE);
  return buildGraph(await collectSnapshot({ site }));
}

/** The same site with its rooms migrated into the ontology, as the app does. */
async function fireplaceWithRooms(): Promise<{ graph: Graph; tags: TagStore }> {
  const site = Site.fromConfig(FIREPLACE);
  const tags = new TagStore();
  migrateRoomsToTags(tags, {
    configuredRooms: site.configuredRooms,
    devices: site.devices.map(device => ({ id: device.id, ...(device.room ? { room: device.room } : {}) })),
    groups: [],
  });
  site.setTagSource(tags);
  return { graph: buildGraph(await collectSnapshot({ site, tags })), tags };
}

const device = (id: string) => elementKey("device", id);

function edgeBetween(graph: Graph, from: string, to: string): GraphEdge | undefined {
  return graph.edgesOf(from).find((edge) => otherEnd(edge, from) === to);
}

describe("icon tables", () => {
  test("every element kind and every capability kind has an icon", () => {
    for (const kind of ELEMENT_KINDS) expect(KIND_ICONS[kind], kind).toBeDefined();
    for (const kind of CAPABILITY_KINDS) expect(CAPABILITY_ICONS[kind], kind).toBeDefined();
  });

  test("a device's icon follows its dominant capability, and an override wins", () => {
    expect(iconFor({ kind: "device", capabilities: ["binarySwitch"] })).toEqual(CAPABILITY_ICONS.binarySwitch);
    expect(iconFor({ kind: "device", capabilities: ["camera", "treatDispenser"] })).toEqual(CAPABILITY_ICONS.treatDispenser);
    expect(dominantCapability(["motionSensor", "camera"])).toBe("camera");
    expect(iconFor({ kind: "device", capabilities: ["light"], override: { kind: "emoji", value: "🔥" } })).toEqual({ kind: "emoji", value: "🔥" });
  });

  test("an icon override may be an emoji or a local image, never a remote URL", () => {
    expect(parseIcon("🔥")).toEqual({ kind: "emoji", value: "🔥" });
    expect(parseIcon({ image: "fireplace.png", alt: "Fireplace" })).toEqual({ kind: "image", src: "/icons/fireplace.png", alt: "Fireplace" });
    expect(parseIcon({ image: "/icons/already.png" })).toEqual({ kind: "image", src: "/icons/already.png" });
    expect(parseIcon({ image: "../secrets.yml" })).toBeUndefined();
    expect(parseIcon({ image: "//evil.example/x.png" })).toBeUndefined();
    expect(parseIcon({ image: "https://example.com/x.png" })).toBeUndefined();
    expect(parseIcon("")).toBeUndefined();
  });
});

describe("relation table", () => {
  test("every relation has an inverse and no name is used twice", () => {
    const names = new Set<string>();
    for (const relation of RELATION_NAMES) {
      names.add(relation);
      names.add(inverseOf(relation));
    }
    expect(names.size).toBe(RELATION_NAMES.length * 2);
  });

  test("an edge reads as its relation from one end and its inverse from the other", () => {
    const edge: GraphEdge = { from: "a", to: "b", relation: "uses", origin: "resolution" };
    expect(relationAsSeenFrom(edge, "a")).toBe("uses");
    expect(relationAsSeenFrom(edge, "b")).toBe("usedBy");
    expect(otherEnd(edge, "a")).toBe("b");
  });
});

describe("schema graph", () => {
  test("links Filters to Events and event types to their payload schemas", () => {
    const { edges } = schemaGraph();
    expect(edges).toContainEqual(expect.objectContaining({ from: schemaNode(filterSchema.$id), to: schemaNode(eventSchema.$id), relation: "references" }));
    expect(edges).toContainEqual(expect.objectContaining({ from: eventTypeNode("camera_object"), to: schemaNode(eventType("camera_object")!.payloadSchema.$id), relation: "declares" }));
  });

  test("is static, has no dangling nodes, and never points into the instance graph", () => {
    const graph = schemaGraph();
    expect(graph).toBe(schemaGraph());
    const ids = new Set(graph.nodes.map((node) => node.id));
    for (const edge of graph.edges) {
      expect(ids.has(edge.from), edge.from).toBe(true);
      expect(ids.has(edge.to), edge.to).toBe(true);
    }
    for (const node of graph.nodes) expect(node.side).toBe("schema");
  });

  test("a capability schema defines its own controls and state properties", async () => {
    const graph = await fireplaceGraph();
    const schema = schemaNode(binarySwitchSchema.$id);
    const defined = graph.edgesOf(schema)
      .filter((edge) => edge.from === schema && edge.relation === "defines")
      .map((edge) => graph.node(edge.to)!);
    expect(defined.filter((node) => node.kind === "control").map((node) => node.name).sort())
      .toEqual(["getState", "toggle", "turnOff", "turnOn"]);
    expect(defined.filter((node) => node.kind === "property").map((node) => node.name).sort())
      .toEqual(["availability", "observedAt", "value"]);
  });

  test("a model implements its capabilities and describes itself with an object schema", async () => {
    const graph = await fireplaceGraph();
    const model = modelNode("optimistic-switch");
    const relations = graph.edgesOf(model)
      .filter((edge) => edge.from === model)
      .map((edge) => [edge.relation, graph.node(edge.to)?.name]);
    expect(relations).toContainEqual(["describesAs", "Binary switch"]);
    expect(relations).toContainEqual(["implements", "Binary switch"]);
  });
});

describe("instance graph", () => {
  test("has one root, and every catalog hangs off it", async () => {
    const graph = await fireplaceGraph();
    const root = siteNode();
    expect(graph.node(root)?.kind).toBe("site");
    const catalogs = graph.edgesOf(root).filter((edge) => edge.from === root).map((edge) => graph.node(edge.to)!);
    expect(catalogs.every((node) => node.kind === "catalog")).toBe(true);
    expect(catalogs.map((node) => node.name)).toContain("Devices");
    expect(graph.edgesOf(catalogNode("devices")).some((edge) => edge.to === device("blaster"))).toBe(true);
  });

  test("no edge dangles and no node id repeats", async () => {
    const graph = await fireplaceGraph();
    expect(graph.nodes().length).toBe(new Set(graph.nodes().map((node) => node.id)).size);
    for (const edge of graph.edges()) {
      expect(graph.node(edge.from), edge.from).toBeDefined();
      expect(graph.node(edge.to), edge.to).toBeDefined();
    }
  });

  test("a switch made of two buttons reaches the device those buttons live on", async () => {
    const graph = await fireplaceGraph();
    const focus = device("fireplace");

    const uses = graph.edgesOf(focus)
      .filter((edge) => relationAsSeenFrom(edge, focus) === "uses")
      .map((edge) => [edge.label, graph.node(otherEnd(edge, focus))?.name]);
    expect(uses).toEqual([["on", "Candle on"], ["off", "Candle off"]]);

    // Both buttons drive the same blaster: one node, two converging edges.
    for (const button of ["candle-on", "candle-off"]) {
      const edge = edgeBetween(graph, device(button), device("blaster"));
      expect(edge?.relation, button).toBe("uses");
      expect(edge?.origin).toBe("resolution");
    }
  });

  test("a device is an instance of its model, and its room reaches it from the tag graph", async () => {
    const { graph, tags } = await fireplaceWithRooms();
    expect(graph.node(device("blaster"))?.schema).toBe(modelNode("broadlink-rm4-pro"));

    // A room is the tag `room = Lounge`, on the tag side of the graph.
    const room = tagNode({ name: ROOM, value: "Lounge" });
    expect(graph.node(room)).toMatchObject({ side: "tag", kind: "tag", name: "Lounge" });
    expect(tags.byPair("Lounge", ROOM)).toBeDefined();

    // `tagged` is the one relation that crosses out of the tag side.
    expect(edgeBetween(graph, room, device("blaster"))?.relation).toBe("tagged");
    expect(relationAsSeenFrom(edgeBetween(graph, device("blaster"), room)!, device("blaster"))).toBe("taggedWith");

    // The name declares its values, and rooms are one per element.
    expect(edgeBetween(graph, tagNameNode(ROOM), room)?.relation).toBe("declares");
    expect(graph.node(elementKey("room", "Lounge"))).toBeUndefined();
  });

  test("a device contains its capabilities, and each capability its controls", async () => {
    const graph = await fireplaceGraph();
    const capability = elementKey("capability", "fireplace", "binarySwitch");
    expect(graph.node(capability)?.schema).toBe(schemaNode(binarySwitchSchema.$id));
    expect(edgeBetween(graph, device("fireplace"), capability)?.relation).toBe("contains");
    const controls = graph.edgesOf(capability)
      .filter((edge) => edge.from === capability && graph.node(edge.to)?.kind === "control")
      .map((edge) => graph.node(edge.to)!.name);
    expect(controls.sort()).toEqual(["getState", "toggle", "turnOff", "turnOn"]);
  });

  test("an observable node names the state node it maps to", async () => {
    const graph = await fireplaceGraph();
    expect(graph.node(device("fireplace"))?.stateNode).toBe("device/fireplace");
    expect(graph.node(elementKey("room", "Lounge"))?.stateNode).toBeUndefined();
  });

  test("reaches follows references, which is what group pruning needs", async () => {
    const graph = await fireplaceGraph();
    const uses = new Set(["uses"] as const);
    expect(graph.reaches(device("fireplace"), device("blaster"), uses)).toBe(true);
    expect(graph.reaches(device("blaster"), device("fireplace"), uses)).toBe(false);
  });
});

/**
 * Every composite kind at once. This is the parity fixture for replacing the
 * hardcoded `references()` switch in `Site.registered()`: the recorded
 * references must reproduce exactly the relationships that switch produced.
 */
const COMPOSITES = {
  schemaVersion: 2 as const,
  devices: [
    { id: "key-a", name: "Key A", model: "elgato-key-light-air", config: { host: "10.77.0.10" } },
    { id: "key-b", name: "Key B", model: "elgato-key-light-air", config: { host: "10.77.0.11" } },
    { id: "keys", name: "Key lights", model: "light-group", config: { members: ["key-a", "key-b"] } },
    { id: "relay", name: "Relay", model: "shelly-plus-1", config: { host: "10.77.0.12" } },
    { id: "scene", name: "Recording", model: "synthetic-switch", config: { members: [
      { device: "relay", on: "on", off: "off" },
      { device: "keys", capability: "light", on: "on", off: "off" },
    ] } },
    { id: "hub", name: "Hub", model: "aqara-hub-m2", config: { matterPeerId: "peer1" } },
    { id: "door", name: "Office door", model: "aqara-door-window-sensor", config: { hub: "hub", serialNumber: "ABC123" } },
  ],
};

describe("recorded references", () => {
  test("provisioning records what each composite actually resolved", async () => {
    const site = Site.fromConfig(COMPOSITES);
    const recorded = site.references.map((reference) => [reference.from, reference.relation, reference.to, reference.label, reference.capability]);
    expect(recorded).toEqual([
      ["keys", "members", "key-a", "1", "light"],
      ["keys", "members", "key-b", "2", "light"],
      ["scene", "members", "relay", "1", undefined],
      ["scene", "members", "keys", "2", "light"],
      ["door", "uses", "hub", undefined, "hub"],
    ]);
  });

  test("the device pages show the same relationships the old model-id switch produced", () => {
    const site = Site.fromConfig(COMPOSITES);
    // Device-to-device edges only: automatic group membership is a separate,
    // pre-existing derivation and is not what the old switch produced.
    const REFERENCE_RELATIONS = new Set(["uses", "usedBy", "members"]);
    const relationsOf = (id: string) => (site.view(id)?.relationships ?? [])
      .filter((link) => REFERENCE_RELATIONS.has(link.relation))
      .map((link) => [link.relation, link.id]).sort();

    expect(relationsOf("keys")).toEqual([["members", "key-a"], ["members", "key-b"], ["usedBy", "scene"]].sort());
    expect(relationsOf("key-a")).toEqual([["usedBy", "keys"]]);
    expect(relationsOf("scene")).toEqual([["members", "keys"], ["members", "relay"]].sort());
    expect(relationsOf("relay")).toEqual([["usedBy", "scene"]]);
    expect(relationsOf("door")).toEqual([["uses", "hub"]]);
    expect(relationsOf("hub")).toEqual([["usedBy", "door"]]);
  });

  test("a fan-out composite declares membership; a one-target reference is a use", async () => {
    const site = Site.fromConfig(COMPOSITES);
    const graph = buildGraph(await collectSnapshot({ site }));
    // Both a light group and a synthetic switch send one command to many
    // devices, which is what stops them joining an automatic group themselves.
    expect(edgeBetween(graph, device("keys"), device("key-a"))?.relation).toBe("members");
    expect(edgeBetween(graph, device("scene"), device("relay"))?.relation).toBe("members");
    // The narrowing is kept on the edge, and the edge still joins two devices.
    expect(edgeBetween(graph, device("door"), device("hub"))?.via).toBe("hub");
    expect(graph.reaches(device("scene"), device("key-a"), new Set(["uses", "members"] as const))).toBe(true);
  });
});

describe("icon precedence", () => {
  test("an entry's own icon beats the model's, which beats the capability's", async () => {
    const site = Site.fromConfig({
      schemaVersion: 2,
      devices: [
        { id: "plain", name: "Plain relay", model: "shelly-plus-1", config: { host: "10.77.0.2" } },
        { id: "fancy", name: "Fancy relay", model: "shelly-plus-1", icon: "🔥", config: { host: "10.77.0.3" } },
        { id: "pictured", name: "Pictured relay", model: "shelly-plus-1", icon: { image: "relay.png", alt: "Relay" }, config: { host: "10.77.0.4" } },
      ],
    });
    const graph = buildGraph(await collectSnapshot({ site }));
    expect(graph.node(device("plain"))?.icon).toEqual(CAPABILITY_ICONS.binarySwitch);
    expect(graph.node(device("fancy"))?.icon).toEqual({ kind: "emoji", value: "🔥" });
    expect(graph.node(device("pictured"))?.icon).toEqual({ kind: "image", src: "/icons/relay.png", alt: "Relay" });
  });

  test("every node has an icon, on both sides of the graph", async () => {
    const graph = await fireplaceGraph();
    for (const node of graph.nodes()) {
      expect(node.icon, node.id).toBeDefined();
      expect(node.icon.kind === "emoji" ? node.icon.value : node.icon.src).toBeTruthy();
    }
  });
});
