import { describe, expect, test } from "bun:test";
import { Site } from "../site";
import { StateHub } from "../state/hub";
import { StateHubService } from "../state/service";
import { buildGraph, collectSnapshot } from "./build";
import { TagStore } from "../tags/store";
import { migrateRoomsToTags } from "../tags/room-migration";
import { buildFullView, buildView, DEFAULT_HIDDEN_KINDS, pathToRoot } from "./view";
import { layoutRadial, layoutTree } from "./tree-layout";
import { siteNode } from "./instance-graph";
import { elementKey } from "../tags/identity";
import type { Graph } from "./graph";

const CONFIG = {
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
const focus = device("fireplace");

async function graphOf(withHub = false): Promise<{ graph: Graph; stop(): void }> {
  const hub = new StateHub();
  const site = Site.fromConfig(CONFIG, withHub ? { stateHub: new StateHubService(hub) } : {});
  // Rooms are tags now, so a graph without the ontology has no rooms in it.
  const tags = new TagStore();
  migrateRoomsToTags(tags, {
    configuredRooms: site.configuredRooms,
    devices: site.devices.map(device => ({ id: device.id, ...(device.room ? { room: device.room } : {}) })),
    groups: [],
  });
  site.setTagSource(tags);
  return { graph: buildGraph(await collectSnapshot({ site, tags })), stop: () => { hub.stop(); tags.close(); } };
}

const names = (view: { nodes: readonly { node: { name: string } }[] }) => view.nodes.map((entry) => entry.node.name);

describe("path to root", () => {
  test("every element can be traced back to HomeTruth itself", async () => {
    const { graph, stop } = await graphOf();
    for (const node of graph.nodes()) {
      const path = pathToRoot(graph, node.id);
      expect(path[0], node.id).toBe(siteNode());
      expect(path.at(-1)).toBe(node.id);
    }
    stop();
  });

  test("a node hangs from its most specific parent, not the catalog it is filed under", async () => {
    const { graph, stop } = await graphOf();
    const capability = elementKey("capability", "fireplace", "binarySwitch");
    const path = pathToRoot(graph, capability).map((id) => graph.node(id)?.name);
    expect(path).toEqual(["HomeTruth", "Devices", "Fireplace candles", "binarySwitch"]);
    stop();
  });
});

describe("default view", () => {
  test("is the path to the root and the immediate children, and nothing else", async () => {
    const { graph, stop } = await graphOf();
    const view = buildView(graph, focus)!;
    expect(names(view)).toEqual(["HomeTruth", "Devices", "Fireplace candles", "binarySwitch"]);
    expect(view.nodes.map((entry) => entry.role)).toEqual(["ancestor", "ancestor", "focus", "child"]);
    stop();
  });

  test("what is not drawn is counted on the node it hangs off", async () => {
    const { graph, stop } = await graphOf();
    const view = buildView(graph, focus)!;
    const entry = view.nodes.find((candidate) => candidate.role === "focus")!;
    expect(entry.hidden).toBeGreaterThan(0);
    expect(entry.hiddenKinds).toContain("device");
    stop();
  });

  test("the count promises only what expanding would actually reveal", async () => {
    const { graph, stop } = await graphOf(true);
    const hiddenService = buildView(graph, focus)!;
    const shownService = buildView(graph, focus, { hiddenKinds: [] })!;
    const count = (view: typeof hiddenService) => view.nodes.find((entry) => entry.role === "focus")!.hidden;

    // The state hub is a neighbour either way; it is only counted when it could appear.
    expect(count(shownService)).toBe(count(hiddenService) + 1);
    expect(hiddenService.nodes.find((entry) => entry.role === "focus")!.hiddenKinds).not.toContain("service");
    stop();
  });

  test("a kind suppressed nearby is what the menu offers to turn on", async () => {
    const { graph, stop } = await graphOf(true);
    expect(buildView(graph, focus)!.offeredKinds).toEqual(["service"]);
    expect(buildView(graph, focus, { hiddenKinds: [] })!.offeredKinds).toEqual([]);
    expect(DEFAULT_HIDDEN_KINDS).toContain("service");
    stop();
  });
});

describe("expanding", () => {
  test("opens one node, not the whole graph", async () => {
    const { graph, stop } = await graphOf();
    const view = buildView(graph, focus, { expanded: [focus] })!;
    expect(names(view)).toContain("Candle on");
    expect(names(view)).toContain("Candle off");
    expect(names(view)).toContain("Lounge");
    // One hop further; still behind its own expander.
    expect(names(view)).not.toContain("Blaster");
    stop();
  });

  test("a second hop reaches the device the buttons live on", async () => {
    const { graph, stop } = await graphOf();
    const view = buildView(graph, focus, { expanded: [focus, device("candle-on")] })!;
    expect(names(view)).toContain("Blaster");
    stop();
  });

  test("a revealed node hangs from its real parent when that is on screen", async () => {
    const { graph, stop } = await graphOf();
    const view = buildView(graph, focus, { expanded: [focus] })!;
    const button = view.nodes.find((entry) => entry.node.name === "Candle on")!;
    // Its parent is the catalog it is really filed under, not the switch that
    // happened to reveal it; the `uses` link is drawn across instead.
    expect(graph.node(button.parent!)?.name).toBe("Devices");
    expect(button.depth).toBe(2);
    stop();
  });

  test("expanding never removes what was already drawn", async () => {
    const { graph, stop } = await graphOf();
    const before = new Set(names(buildView(graph, focus)!));
    const after = new Set(names(buildView(graph, focus, { expanded: [focus] })!));
    for (const name of before) expect(after.has(name), name).toBe(true);
    stop();
  });
});

describe("tree layout", () => {
  test("is deterministic and puts each node one row below its parent", async () => {
    const { graph, stop } = await graphOf();
    const view = buildView(graph, focus)!;
    const once = layoutTree(view);
    expect(layoutTree(view).nodes.map((entry) => [entry.x, entry.y]))
      .toEqual(once.nodes.map((entry) => [entry.x, entry.y]));
    for (const entry of once.nodes) {
      if (!entry.view.parent) continue;
      const parent = once.nodes.find((candidate) => candidate.view.node.id === entry.view.parent);
      if (parent && entry.view.depth > parent.view.depth) expect(entry.y).toBeGreaterThan(parent.y);
    }
    stop();
  });

  test("a node with more to show gets an expander, and one without does not", async () => {
    const { graph, stop } = await graphOf();
    const placed = layoutTree(buildView(graph, focus)!);
    for (const entry of placed.nodes) {
      expect(Boolean(entry.expander), entry.view.node.name).toBe(entry.view.hidden > 0);
    }
    stop();
  });

  test("the viewBox holds every node", async () => {
    const { graph, stop } = await graphOf();
    const placed = layoutTree(buildView(graph, focus, { expanded: [focus] })!);
    const [x, y, width, height] = placed.viewBox;
    for (const entry of placed.nodes) {
      expect(entry.x).toBeGreaterThanOrEqual(x);
      expect(entry.x).toBeLessThanOrEqual(x + width);
      expect(entry.y).toBeGreaterThanOrEqual(y);
      expect(entry.y).toBeLessThanOrEqual(y + height);
    }
    stop();
  });
});

describe("full view", () => {
  test("reaches everything from the root, minus the detail", async () => {
    const { graph, stop } = await graphOf();
    const view = buildFullView(graph, siteNode(), { focus })!;
    expect(view.total).toBe(graph.size);
    expect(view.nodes.length).toBeLessThan(view.total);
    expect(names(view)).toContain("Devices");
    expect(names(view)).toContain("Schemas");
    // Controls and properties are most of the graph by count and none of it by
    // meaning at this zoom.
    expect(view.nodes.some((entry) => entry.node.kind === "control")).toBe(false);
    expect(view.nodes.some((entry) => entry.node.kind === "property")).toBe(false);
    stop();
  });

  test("the focus survives the cap, however small it is", async () => {
    const { graph, stop } = await graphOf();
    const view = buildFullView(graph, siteNode(), { focus, maxNodes: 3 })!;
    expect(view.nodes.some((entry) => entry.node.id === focus)).toBe(true);
    expect(view.nodes.find((entry) => entry.node.id === focus)!.role).toBe("focus");
    stop();
  });

  test("packs into a disc rather than a row miles wide", async () => {
    const { graph, stop } = await graphOf();
    const placed = layoutRadial(buildFullView(graph, siteNode(), { focus })!);
    const [, , width, height] = placed.viewBox;
    expect(width).toBeLessThan(4000);
    expect(width / height).toBeGreaterThan(0.3);
    expect(width / height).toBeLessThan(3);
    stop();
  });
});
