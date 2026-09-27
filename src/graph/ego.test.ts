import { describe, expect, test } from "bun:test";
import { Site } from "../site";
import { buildGraph, collectSnapshot } from "./build";
import { tagNode } from "./tag-graph";
import { TagStore } from "../tags/store";
import { migrateRoomsToTags } from "../tags/room-migration";
import { ROOM } from "../tags/model";
import { DEFAULT_CAPS, ego } from "./ego";
import { layout } from "./layout";
import { elementKey } from "../tags/identity";
import { otherEnd, relationAsSeenFrom } from "./types";
import type { Graph } from "./graph";

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

const device = (id: string) => elementKey("device", id);
/** A graph with the ontology attached, because a room is a tag now. */
const graphOf = async (config: typeof FIREPLACE): Promise<Graph> => {
  const site = Site.fromConfig(config);
  const tags = new TagStore();
  migrateRoomsToTags(tags, {
    configuredRooms: site.configuredRooms,
    devices: site.devices.map(device => ({ id: device.id, ...(device.room ? { room: device.room } : {}) })),
    groups: [],
  });
  site.setTagSource(tags);
  return buildGraph(await collectSnapshot({ site, tags }));
};
/** The node a room now has: the tag `room = <name>`. */
const roomNode = (value: string) => tagNode({ name: ROOM, value });

describe("ego view", () => {
  test("shows the focus, what it touches, and what those touch", async () => {
    const graph = await graphOf(FIREPLACE);
    const view = ego(graph, device("fireplace"), 2)!;
    const names = (depth: number) => view.nodes.filter((entry) => entry.depth === depth).map((entry) => entry.node.name).sort();

    expect(names(0)).toEqual(["Fireplace candles"]);
    expect(names(1)).toContain("Candle on");
    expect(names(1)).toContain("Candle off");
    // The device the buttons live on is two hops away, which is the whole point.
    expect(names(2)).toContain("Blaster");
  });

  test("both buttons converge on the one blaster they drive", async () => {
    const graph = await graphOf(FIREPLACE);
    const view = ego(graph, device("fireplace"), 2)!;
    const blaster = device("blaster");

    // One node, not one per button.
    expect(view.nodes.filter((entry) => entry.node.id === blaster)).toHaveLength(1);

    const incoming = view.edges
      .filter((edge) => otherEnd(edge, blaster) !== blaster && (edge.from === blaster || edge.to === blaster))
      .filter((edge) => relationAsSeenFrom(edge, blaster) === "usedBy")
      .map((edge) => graph.node(otherEnd(edge, blaster))?.name)
      .sort();
    expect(incoming).toEqual(["Candle off", "Candle on"]);
  });

  test("keeps every edge between nodes on the diagram, not only the ones it walked", async () => {
    const graph = await graphOf(FIREPLACE);
    const view = ego(graph, device("fireplace"), 2)!;
    const present = new Set(view.nodes.map((entry) => entry.node.id));
    for (const edge of view.edges) {
      expect(present.has(edge.from)).toBe(true);
      expect(present.has(edge.to)).toBe(true);
    }
    // The blaster-to-room edge is between two kept nodes but was never walked.
    expect(view.edges.some((edge) => edge.from === roomNode("Lounge") && edge.to === device("blaster"))).toBe(true);
  });

  test("leaves out navigation scaffolding and a neighbour's internals", async () => {
    const graph = await graphOf(FIREPLACE);
    const view = ego(graph, device("fireplace"), 2)!;
    const kinds = view.nodes.map((entry) => entry.node.kind);

    // The root and its catalogs touch everything; they would drown the picture.
    expect(kinds).not.toContain("site");
    expect(kinds).not.toContain("catalog");
    // The focus's own capability is useful; the buttons' capabilities are not.
    const capabilities = view.nodes.filter((entry) => entry.node.kind === "capability");
    expect(capabilities.every((entry) => entry.depth === 1)).toBe(true);
    expect(view.nodes.filter((entry) => entry.depth === 2 && entry.node.kind === "control")).toHaveLength(0);
  });

  test("a cap produces a count of what it hid rather than a shorter picture", async () => {
    const graph = await graphOf(FIREPLACE);
    const view = ego(graph, device("blaster"), 2, { ...DEFAULT_CAPS, perRelation: 1 })!;
    const hidden = view.truncated.find((entry) => entry.relation === "usedBy");
    expect(hidden?.hidden).toBe(1);
    expect(view.nodes.filter((entry) => entry.via === "usedBy" && entry.depth === 1)).toHaveLength(1);
  });


  test("an unknown node has no view at all", async () => {
    const graph = await graphOf(FIREPLACE);
    expect(ego(graph, device("nope"), 2)).toBeUndefined();
  });
});

describe("layout", () => {
  test("is deterministic: the same graph places every node identically", async () => {
    const graph = await graphOf(FIREPLACE);
    const once = layout(ego(graph, device("fireplace"), 2)!);
    const twice = layout(ego(graph, device("fireplace"), 2)!);
    expect(twice.nodes.map((entry) => [entry.node.id, entry.x, entry.y]))
      .toEqual(once.nodes.map((entry) => [entry.node.id, entry.x, entry.y]));
    expect(twice.viewBox).toEqual(once.viewBox);
  });

  test("puts the focus at the origin and everything else outside it", async () => {
    const graph = await graphOf(FIREPLACE);
    const placed = layout(ego(graph, device("fireplace"), 2)!);
    const focus = placed.nodes.find((entry) => entry.depth === 0)!;
    expect([focus.x, focus.y]).toEqual([0, 0]);
    for (const entry of placed.nodes.filter((node) => node.depth > 0)) {
      expect(Math.hypot(entry.x, entry.y)).toBeGreaterThan(100);
    }
  });

  test("reads direction from position: what it drives sits right, its room lower left", async () => {
    const graph = await graphOf(FIREPLACE);
    const placed = layout(ego(graph, device("fireplace"), 2)!);
    const at = (name: string) => placed.nodes.find((entry) => entry.node.name === name)!;
    expect(at("Candle on").x).toBeGreaterThan(50);
    expect(at("Candle off").x).toBeGreaterThan(50);
    expect(at("Lounge").x).toBeLessThan(0);
    expect(at("Lounge").y).toBeGreaterThan(0);
  });

  test("two relations that prefer the same bearing do not land on each other", async () => {
    const graph = await graphOf(FIREPLACE);
    const placed = layout(ego(graph, device("fireplace"), 2)!);
    const points = placed.nodes.map((entry) => `${Math.round(entry.x)},${Math.round(entry.y)}`);
    expect(new Set(points).size).toBe(points.length);
  });

  test("the second ring sits outside the first", async () => {
    const graph = await graphOf(FIREPLACE);
    const placed = layout(ego(graph, device("fireplace"), 2)!);
    const radius = (depth: number) => placed.nodes.filter((entry) => entry.depth === depth).map((entry) => Math.hypot(entry.x, entry.y));
    expect(Math.min(...radius(2))).toBeGreaterThan(Math.max(...radius(1)));
  });

  test("the viewBox contains every node with room for its label", async () => {
    const graph = await graphOf(FIREPLACE);
    const placed = layout(ego(graph, device("fireplace"), 2)!);
    const [x, y, width, height] = placed.viewBox;
    for (const entry of placed.nodes) {
      expect(entry.x).toBeGreaterThan(x);
      expect(entry.x).toBeLessThan(x + width);
      expect(entry.y).toBeGreaterThan(y);
      expect(entry.y).toBeLessThan(y + height);
    }
  });

  test("a long name is cut for drawing, and the node keeps the full one", async () => {
    const graph = await graphOf({
      ...FIREPLACE,
      devices: FIREPLACE.devices.map((entry) => entry.id === "blaster" ? { ...entry, name: "A blaster with a very long name indeed" } : entry),
    });
    const placed = layout(ego(graph, device("candle-on"), 2)!);
    const blaster = placed.nodes.find((entry) => entry.node.id === device("blaster"))!;
    expect(blaster.label.length).toBeLessThanOrEqual(18);
    expect(blaster.label.endsWith("…")).toBe(true);
    expect(blaster.node.name).toBe("A blaster with a very long name indeed");
  });
});
