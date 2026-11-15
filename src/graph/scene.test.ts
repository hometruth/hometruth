import { describe, expect, test } from "bun:test";
import { Graph, edgeIdentity } from "./graph";
import { defaultGraphRelations, graphHref, parseGraphQuery, projectGraph, type GraphQuery, type GraphScene } from "./scene";
import type { GraphEdge, GraphNode, Relation } from "./types";

const node = (id: string, extra: Partial<GraphNode> = {}): GraphNode => ({
  id, side: "instance", kind: "device", name: id, context: "", page: `/devices/${id}`,
  icon: { kind: "emoji", value: "●" }, ids: [id], ...extra,
});
const edge = (from: string, to: string, relation: Relation = "uses", extra: Partial<GraphEdge> = {}): GraphEdge => ({ from, to, relation, origin: "resolution", ...extra });
const graph = (nodes: GraphNode[], edges: GraphEdge[] = []) => new Graph({ nodes, edges, generatedAt: "2026-01-01T00:00:00.000Z" });
const query = (patch: Partial<GraphQuery> = {}): GraphQuery => ({ ...parseGraphQuery(new URLSearchParams()), ...patch });
const ids = (scene: GraphScene) => [...new Set(scene.nodes.map(entry => entry.node.id))].sort();
const closed = (scene: GraphScene) => {
  const present = new Set(scene.nodes.map(entry => entry.id));
  for (const connection of scene.edges) {
    expect(present.has(connection.from)).toBe(true);
    expect(present.has(connection.to)).toBe(true);
  }
};
const room = (id: string, name: string) => node(id, { name, kind: "tag", side: "tag", ids: ["room", name] });

function dependencyGraph() {
  return graph([
    node("switch"), node("on"), node("off"), node("radio"), node("unrelated"),
    node("health", { kind: "service" }), node("messages", { kind: "service" }), node("state", { kind: "service" }), node("group", { kind: "group" }),
    node("catalog", { kind: "catalog" }), node("schema", { kind: "schema", side: "schema" }), room("room", "Study"),
  ], [
    edge("switch", "on", "uses", { label: "on" }), edge("switch", "off", "uses", { label: "off" }),
    edge("on", "radio"), edge("off", "radio"), edge("unrelated", "radio"),
    ...["switch", "on", "off", "radio", "unrelated"].flatMap(id => [
      edge("health", id, "services"), edge(id, "messages", "sourcedBy"), edge(id, "state", "sourcedBy"), edge("group", id, "members"),
    ]), edge("group", "switch", "groupSwitch"),
    edge("catalog", "switch", "contains"), edge("switch", "schema", "instanceOf"), edge("room", "switch", "tagged"),
  ]);
}

describe("graph query", () => {
  test("opaque identities and set-valued expansions survive a canonical URL round trip", () => {
    const requested = query({ view: "dependencies", focus: "device,with/odd?parts", selected: "selected+&", q: "lamp shade", expanded: ["z,source", "a,target", "z,source"], relations: ["uses", "services"] });
    const href = graphHref(requested);
    const restored = parseGraphQuery(new URL(href, "https://example.test").searchParams);
    expect(restored).toEqual({ ...requested, expanded: ["a,target", "z,source"], relations: ["services", "uses"] });
    expect(graphHref(restored)).toBe(href);
    expect(graphHref(query())).toBe("/graph");
  });

  test("parsing bounds search, expansions and depth, and ignores unknown options", () => {
    const params = new URLSearchParams({ view: "invalid", q: "x".repeat(250), depth: "99", group: "wrong" });
    for (let i = 0; i < 70; i += 1) params.append("expand", String(i));
    params.append("relation", "uses"); params.append("relation", "not-a-relation");
    const parsed = parseGraphQuery(params);
    expect(parsed.view).toBe("home"); expect(parsed.q).toHaveLength(200); expect(parsed.depth).toBe(3);
    expect(parsed.expanded).toHaveLength(64); expect(parsed.relations).toEqual(["uses"]); expect(parsed.group).toBe("room");
    expect(parseGraphQuery(new URLSearchParams("depth=garbage")).depth).toBe(2);
    expect(parseGraphQuery(new URLSearchParams("depth=-5")).depth).toBe(0);
    const overlong = parseGraphQuery(new URLSearchParams({ focus: "x".repeat(4097), selected: "x".repeat(4097), expand: "x".repeat(4097) }));
    expect(overlong.focus).toBeUndefined(); expect(overlong.selected).toBeUndefined(); expect(overlong.expanded).toEqual([]);
  });
});

describe("home scene", () => {
  test("rooms group user elements; multi-room occurrences do not inflate canonical counts", () => {
    const topology = graph([node("lamp"), node("sensor"), node("unassigned"), room("lounge", "Lounge"), room("study", "Study"),
      node("catalog", { kind: "catalog" }), node("model", { kind: "model", side: "schema" }), node("detail", { kind: "control" }),
      node("service", { kind: "service" })], [edge("lounge", "lamp", "tagged"), edge("study", "lamp", "tagged"), edge("study", "sensor", "tagged")]);
    const scene = projectGraph(topology, query());
    expect(scene.total).toBe(3); expect(scene.matched).toBe(3); expect(scene.omitted).toBe(0);
    expect(scene.nodes).toHaveLength(4); expect(new Set(scene.nodes.map(entry => entry.id)).size).toBe(4);
    expect(scene.groups.map(group => [group.name, group.total, group.hidden])).toEqual([["Lounge", 1, 0], ["Study", 2, 0], ["Unassigned", 1, 0]]);
    expect(ids(scene)).toEqual(["lamp", "sensor", "unassigned"]);
  });

  test("group and overall caps have exact omission counts, and expansion reveals bounded members", () => {
    const devices = Array.from({ length: 60 }, (_, index) => node(`lamp-${String(index).padStart(2, "0")}`));
    const topology = graph([...devices, room("room", "Lounge")], devices.map(device => edge("room", device.id, "tagged")));
    const initial = projectGraph(topology, query());
    expect(initial.nodes).toHaveLength(6); expect(initial.omitted).toBe(54); expect(initial.groups[0]?.hidden).toBe(54);
    const expanded = projectGraph(topology, query({ expanded: [initial.groups[0]!.id] }));
    expect(expanded.nodes).toHaveLength(48); expect(expanded.omitted).toBe(12); expect(expanded.groups[0]?.hidden).toBe(12);
    const focused = projectGraph(topology, query({ selected: "lamp-59" }));
    expect(focused.nodes.map(entry => entry.node.id)).toEqual(["lamp-00", "lamp-01", "lamp-02", "lamp-03", "lamp-04", "lamp-59"]);
    expect(focused.omitted).toBe(54); expect(focused.groups[0]?.hidden).toBe(54);
  });

  test("selecting an existing card preserves alphabetical membership and order after reload", () => {
    const topology = graph(Array.from({ length: 8 }, (_, index) => node(`lamp-${index}`)));
    const initial = projectGraph(topology, query());
    for (const selected of ["lamp-2", "lamp-5"]) {
      const restored = parseGraphQuery(new URL(graphHref(initial.query, { selected }), "https://example.test").searchParams);
      const reloaded = projectGraph(topology, restored);
      expect(reloaded.nodes).toEqual(initial.nodes);
      expect(reloaded.query.selected).toBe(selected);
    }
    const missing = projectGraph(topology, query({ selected: "removed-lamp" }));
    expect(missing.nodes).toEqual(initial.nodes); expect(missing.query.selected).toBe("lamp-0");
    const search = projectGraph(topology, query({ q: "lamp-2", selected: "lamp-7" }));
    expect(ids(search)).toEqual(["lamp-2"]); expect(search.query.selected).toBe("lamp-2");
    expect(search.matched).toBe(1); expect(search.omitted).toBe(0);
  });

  test("search filters scoped names and context with honest totals", () => {
    const topology = graph([node("a", { name: "Lamp", context: "Desk" }), node("b", { name: "Other", context: "Living room" }), node("schema", { side: "schema", kind: "schema", name: "Desk schema" })]);
    const scene = projectGraph(topology, query({ q: "DESK", group: "kind" }));
    expect(ids(scene)).toEqual(["a"]); expect(scene.total).toBe(2); expect(scene.matched).toBe(1); expect(scene.omitted).toBe(0);
    expect(scene.groups[0]?.kind).toBe("kind");
    const empty = projectGraph(topology, query({ q: "nothing" }));
    expect(empty.nodes).toEqual([]); expect(empty.groups).toEqual([]); expect(empty.query.selected).toBeUndefined();
  });

  test("room expansion cannot exceed the overall occurrence limit", () => {
    const nodes: GraphNode[] = []; const edges: GraphEdge[] = [];
    for (let roomIndex = 0; roomIndex < 35; roomIndex += 1) {
      const tag = room(`room-${roomIndex}`, `Room ${roomIndex}`); nodes.push(tag);
      for (let member = 0; member < 6; member += 1) { const device = node(`r${roomIndex}-${member}`); nodes.push(device); edges.push(edge(tag.id, device.id, "tagged")); }
    }
    const topology = graph(nodes, edges);
    const scene = projectGraph(topology, query());
    expect(scene.nodes).toHaveLength(160); expect(scene.total).toBe(210); expect(scene.omitted).toBe(50);
    expect(scene.groups.reduce((sum, group) => sum + group.hidden, 0)).toBe(50);
    const selected = projectGraph(topology, query({ selected: "r9-5" }));
    expect(selected.nodes).toHaveLength(160); expect(selected.omitted).toBe(50); expect(selected.query.selected).toBe("r9-5");
    expect(selected.groups.reduce((sum, group) => sum + group.hidden, 0)).toBe(50);
    expect(selected.nodes.at(-1)?.node.id).toBe("r9-5");
  });
});

describe("dependency scene", () => {
  test("default focus prefers two outgoing action roles without reversing through their shared targets", () => {
    const topology = graph([
      node("member", { name: "Above door" }), node("single", { name: "Desk button" }), node("switch", { name: "Evening switch" }),
      node("on", { name: "On action" }), node("off", { name: "Off action" }), node("group", { kind: "group", name: "All lights" }),
    ], [edge("group", "member", "members"), edge("single", "on"), edge("switch", "on", "uses", { label: "on", via: "power-control" }), edge("switch", "off", "uses", { label: "off", origin: "site" })]);
    const scene = projectGraph(topology, query({ view: "dependencies" }));
    expect(scene.query.focus).toBe("switch"); expect(ids(scene)).toEqual(["off", "on", "switch"]);
    const roles = scene.edges.filter(connection => connection.edge.from === "switch").map(connection => connection.edge);
    expect(roles.map(connection => connection.label).sort()).toEqual(["off", "on"]);
    expect(roles).toEqual(expect.arrayContaining(topology.edges().filter(connection => connection.from === "switch")));
    expect(projectGraph(graph([...topology.nodes()].reverse(), [...topology.edges()].reverse()), query({ view: "dependencies" })).nodes).toEqual(scene.nodes);
  });

  test("a normal focus shows its four-node chain without shared infrastructure or groups", () => {
    const scene = projectGraph(dependencyGraph(), query({ view: "dependencies", focus: "switch", depth: 3 }));
    expect(ids(scene)).toEqual(["off", "on", "radio", "switch"]);
    expect(scene.edges).toHaveLength(4); expect(scene.edges.every(connection => connection.edge.relation === "uses")).toBe(true);
    expect(scene.total).toBe(4); expect(scene.omitted).toBe(0); closed(scene);
    expect(defaultGraphRelations(scene.query, scene.nodes.find(entry => entry.node.id === "switch")!.node)).toEqual(["uses"]);
  });

  test("shared hardware does not pull its ten other users into a focused chain", () => {
    const others = Array.from({ length: 10 }, (_, index) => node(`other-${index}`));
    const topology = graph([node("switch"), node("on"), node("off"), node("radio"), ...others], [
      edge("switch", "on"), edge("switch", "off"), edge("on", "radio"), edge("off", "radio"), ...others.map(other => edge(other.id, "radio")),
    ]);
    const scene = projectGraph(topology, query({ view: "dependencies", focus: "switch", depth: 3 }));
    expect(ids(scene)).toEqual(["off", "on", "radio", "switch"]); expect(scene.edges).toHaveLength(4);
    expect(scene.nodes.find(entry => entry.node.id === "radio")?.hidden).toBe(10); closed(scene);
    const expanded = projectGraph(topology, query({ ...scene.query, expanded: ["radio"] }));
    expect(expanded.nodes).toHaveLength(14); expect(expanded.edges).toHaveLength(14); expect(expanded.query.focus).toBe("switch"); closed(expanded);
  });

  test("upstream and downstream cones keep their directions at every intermediate node", () => {
    const topology = graph(["focus", "source", "ancestor", "sibling", "target", "other-user"].map(id => node(id)), [
      edge("ancestor", "source"), edge("source", "focus"), edge("source", "sibling"), edge("focus", "target"), edge("other-user", "target"),
    ]);
    const scene = projectGraph(topology, query({ view: "dependencies", focus: "focus", depth: 3 }));
    expect(ids(scene)).toEqual(["ancestor", "focus", "source", "target"]); expect(scene.edges).toHaveLength(3); closed(scene);
    const expanded = projectGraph(topology, query({ ...scene.query, expanded: ["source"] }));
    expect(ids(expanded)).toEqual(["ancestor", "focus", "sibling", "source", "target"]); closed(expanded);
  });

  test("group focus uses contextual membership relations and a bounded nearest scene", () => {
    for (const kind of ["group", "speaker-group", "group-switch"] as const) {
      const members = Array.from({ length: 80 }, (_, index) => node(`member-${String(index).padStart(2, "0")}`));
      const group = node("group", { kind });
      const topology = graph([node("focus"), group, ...members], [edge("group", "focus", "members"), ...members.map(member => edge("group", member.id, "members"))]);
      const ordinary = projectGraph(topology, query({ view: "dependencies", focus: "focus", depth: 3 }));
      expect(ids(ordinary)).toEqual(["focus"]);
      const focused = projectGraph(topology, query({ view: "dependencies", focus: "group", depth: 1 }));
      expect(defaultGraphRelations(focused.query, group)).toEqual(["members", "groupSwitch"]);
      expect(focused.nodes).toHaveLength(12); expect(focused.total).toBe(82); expect(focused.omitted).toBe(70); closed(focused);
      const membersOnly = projectGraph(topology, query({ view: "dependencies", focus: "focus", relations: ["members"] }));
      expect(ids(membersOnly)).toEqual(["focus", "group"]);
      const expanded = projectGraph(topology, query({ ...membersOnly.query, expanded: ["group"] }));
      expect(expanded.nodes).toHaveLength(24); expect(expanded.total).toBe(82); expect(expanded.omitted).toBe(58); closed(expanded);
    }
  });

  test("service focus shows recorded service and source relations without action dependencies", () => {
    const topology = graph([node("service", { kind: "service" }), node("served"), node("observed"), node("action")], [
      edge("service", "served", "services"), edge("observed", "service", "sourcedBy"), edge("action", "served"), edge("service", "action"),
    ]);
    const scene = projectGraph(topology, query({ view: "dependencies", focus: "service" }));
    expect(defaultGraphRelations(scene.query, topology.node("service"))).toEqual(["services", "sourcedBy"]);
    expect(ids(scene)).toEqual(["observed", "served", "service"]); expect(scene.edges).toHaveLength(2); closed(scene);
    const uses = projectGraph(topology, query({ ...scene.query, relations: ["uses"] }));
    expect(ids(uses)).toEqual(["action", "served", "service"]); expect(uses.edges.every(connection => connection.edge.relation === "uses")).toBe(true);
  });

  test("explicit relations replace contextual defaults and remain in effect during expansion", () => {
    const topology = dependencyGraph();
    const scene = projectGraph(topology, query({ view: "dependencies", focus: "switch", relations: ["sourcedBy"] }));
    expect(ids(scene)).toEqual(["messages", "state", "switch"]); expect(scene.edges).toHaveLength(2);
    const expanded = projectGraph(topology, query({ ...scene.query, expanded: ["messages"] }));
    expect(ids(expanded)).toEqual(["messages", "off", "on", "radio", "state", "switch", "unrelated"]);
    expect(expanded.edges.every(connection => connection.edge.relation === "sourcedBy")).toBe(true); closed(expanded);
    const services = projectGraph(topology, query({ view: "dependencies", focus: "switch", relations: ["services"] }));
    expect(ids(services)).toEqual(["health", "switch"]);
    const combined = projectGraph(topology, query({ view: "dependencies", focus: "switch", relations: ["uses", "services"] }));
    expect(ids(combined)).toEqual(["health", "off", "on", "radio", "switch"]); closed(combined);
    const unsupported = projectGraph(topology, query({ view: "dependencies", focus: "switch", relations: ["contains", "instanceOf"] }));
    expect(ids(unsupported)).toEqual(["switch"]);
  });

  test("default focus prefers a configured action over an alphabetically first isolated device", () => {
    const topology = graph([node("alone", { name: "Bookshelf speaker" }), node("switch", { name: "Evening switch" }), node("target", { name: "Radio button" }), node("hub", { kind: "service" })], [
      edge("alone", "hub", "sourcedBy"), edge("switch", "target", "uses"), edge("switch", "hub", "sourcedBy"),
    ]);
    const scene = projectGraph(topology, query({ view: "dependencies" }));
    expect(scene.query.focus).toBe("switch"); expect(ids(scene)).toEqual(["switch", "target"]);
    const reverse = graph([...topology.nodes()].reverse(), [...topology.edges()].reverse());
    expect(projectGraph(reverse, query({ view: "dependencies" })).nodes).toEqual(scene.nodes);
  });

  test("a definition or catalog cannot become an operational node through focus", () => {
    for (const focus of ["catalog", "schema", "room"]) {
      expect(projectGraph(dependencyGraph(), query({ view: "dependencies", focus })).nodes).toEqual([]);
    }
  });

  test("expansion is independent of order, including a round trip and cycles", () => {
    const topology = graph([node("z"), node("a"), node("b"), node("c")], [edge("z", "a"), edge("a", "b"), edge("b", "c"), edge("c", "z")]);
    const requested = query({ view: "dependencies", focus: "z", depth: 0, expanded: ["z", "a", "b"] });
    const direct = projectGraph(topology, requested);
    const roundTrip = projectGraph(topology, parseGraphQuery(new URL(graphHref(requested), "https://example.test").searchParams));
    expect(ids(direct)).toEqual(["a", "b", "c", "z"]); expect(roundTrip.nodes).toEqual(direct.nodes); closed(roundTrip);
  });

  test("depth three retains all endpoints and each configured parallel role", () => {
    const topology = graph([node("a"), node("b"), node("c"), node("d")], [
      edge("a", "b", "uses", { label: "on" }), edge("a", "b", "uses", { label: "off" }),
      edge("a", "b", "uses", { label: "on" }), edge("b", "c"), edge("c", "d"),
    ]);
    const scene = projectGraph(topology, query({ view: "dependencies", focus: "a", depth: 3 }));
    expect(ids(scene)).toEqual(["a", "b", "c", "d"]); expect(scene.edges).toHaveLength(4);
    expect(scene.edges.map(connection => connection.id).length).toBe(new Set(scene.edges.map(connection => connection.id)).size);
    expect(scene.edges.filter(connection => connection.edge.from === "a").map(connection => connection.edge.label).sort()).toEqual(["off", "on"]); closed(scene);
  });

  test("nearest nodes precede alphabetically earlier grandchildren and selected paths stay connected", () => {
    const nearby = Array.from({ length: 10 }, (_, index) => node(`z-near-${index}`));
    const distant = Array.from({ length: 10 }, (_, index) => node(`a-far-${index}`));
    const topology = graph([node("focus"), ...nearby, ...distant, node("selected")], [
      ...nearby.map(other => edge("focus", other.id)), ...distant.map((other, index) => edge(nearby[index]!.id, other.id)), edge("a-far-9", "selected"),
    ]);
    const initial = projectGraph(topology, query({ view: "dependencies", focus: "focus", depth: 3 }));
    expect(initial.nodes).toHaveLength(12); expect(initial.total).toBe(22); expect(initial.omitted).toBe(10);
    expect(ids(initial)).toEqual(["a-far-0", "focus", ...nearby.map(other => other.id)]); closed(initial);
    const selected = projectGraph(topology, query({ ...initial.query, selected: "selected" }));
    expect(selected.nodes).toHaveLength(12); expect(selected.query.selected).toBe("selected");
    for (const id of ["focus", "z-near-9", "a-far-9", "selected"]) expect(ids(selected)).toContain(id);
    const reachable = new Set(["focus"]);
    for (let pass = 0; pass < selected.nodes.length; pass += 1) {
      for (const connection of selected.edges) if (reachable.has(connection.edge.from)) reachable.add(connection.edge.to);
    }
    expect(reachable.size).toBe(selected.nodes.length); closed(selected);
    const selectedVisible = projectGraph(topology, query({ ...initial.query, selected: "z-near-5" }));
    expect(selectedVisible.nodes).toEqual(initial.nodes);
  });

  test("only reachable expansions increase the twelve-node budget, up to forty-eight", () => {
    const leaves = Array.from({ length: 80 }, (_, index) => node(`leaf-${String(index).padStart(2, "0")}`));
    const topology = graph([node("focus"), node("isolated"), ...leaves], leaves.map(other => edge("focus", other.id)));
    for (const [expanded, count] of [[[], 12], [["isolated", "missing"], 12], [["focus"], 24], [["focus", "leaf-00"], 36], [["focus", "leaf-00", "leaf-01", "leaf-02"], 48]] as const) {
      const scene = projectGraph(topology, query({ view: "dependencies", focus: "focus", expanded }));
      expect(scene.nodes).toHaveLength(count); expect(scene.total).toBe(81); expect(scene.omitted).toBe(81 - count); expect(ids(scene)).toContain("focus"); closed(scene);
    }
    const unreachable = projectGraph(topology, query({ view: "dependencies", focus: "focus", depth: 0, expanded: ["leaf-00"] }));
    expect(ids(unreachable)).toEqual(["focus"]);
  });

  test("search and relation selection retain honest counts and never leave dangling edges", () => {
    const topology = dependencyGraph();
    const scene = projectGraph(topology, query({ view: "dependencies", focus: "switch", q: "on" }));
    expect(ids(scene)).toEqual(["on"]); expect(scene.total).toBe(4); expect(scene.matched).toBe(1); expect(scene.edges).toEqual([]);
    const missing = projectGraph(topology, query({ view: "dependencies", focus: "switch", q: "missing" }));
    expect(missing.nodes).toEqual([]); expect(missing.query.selected).toBeUndefined();
    const subset = projectGraph(topology, query({ view: "dependencies", focus: "switch", relations: ["members"] }));
    expect(ids(subset)).toEqual(["group", "switch"]); closed(subset);
  });
});

describe("model scene", () => {
  test("definition traversal retains its independent 160-node cap", () => {
    const definitions = Array.from({ length: 170 }, (_, index) => node(`definition-${index}`, { side: "schema", kind: "schema" }));
    const model = node("model", { side: "schema", kind: "model" });
    const scene = projectGraph(graph([model, ...definitions], definitions.map(definition => edge("model", definition.id, "implements"))), query({ view: "model", focus: "model" }));
    expect(scene.nodes).toHaveLength(160); expect(scene.total).toBe(171); expect(scene.omitted).toBe(11); expect(ids(scene)).toContain("model"); closed(scene);
  });
  test("default focus prefers a connected definition over an isolated model", () => {
    const topology = graph([node("empty", { name: "A model", side: "schema", kind: "model" }), node("model", { name: "Switch", side: "schema", kind: "model" }), node("schema", { name: "Binary switch", side: "schema", kind: "schema" })], [edge("model", "schema", "implements")]);
    expect(projectGraph(topology, query({ view: "model" })).query.focus).toBe("model");
  });
  test("keeps definitions separate from operational relationships and omits catalog scaffolding", () => {
    const topology = graph([node("model", { kind: "model", side: "schema" }), node("schema", { kind: "schema", side: "schema" }), node("control", { kind: "control", side: "schema" }), node("instance"), node("other"), node("catalog", { kind: "catalog" })], [
      edge("model", "schema", "implements"), edge("schema", "control", "defines"), edge("instance", "model", "instanceOf"), edge("instance", "other"), edge("catalog", "model", "contains"),
    ]);
    const scene = projectGraph(topology, query({ view: "model" }));
    expect(scene.query.focus).toBe("model"); expect(ids(scene)).toEqual(["control", "instance", "model", "schema"]); closed(scene);
    expect(scene.edges.every(connection => connection.edge.relation !== "uses")).toBe(true);
  });

  test("tag focus can show its declarations and tagged elements", () => {
    const topology = graph([node("room-name", { kind: "tag-name", side: "tag" }), room("study", "Study"), node("desk")], [edge("room-name", "study", "declares"), edge("study", "desk", "tagged")]);
    const scene = projectGraph(topology, query({ view: "model", focus: "room-name" }));
    expect(ids(scene)).toEqual(["desk", "room-name", "study"]); closed(scene);
  });
});

test("edge identity preserves differing narrowing and provenance as well as roles", () => {
  const edges = [edge("a", "b"), edge("a", "b", "uses", { via: "button" }), edge("a", "b", "uses", { origin: "site" })];
  expect(new Set(edges.map(edgeIdentity)).size).toBe(3);
  expect(graph([node("a"), node("b")], [...edges, edges[0]!]).edges()).toHaveLength(3);
});
