import { afterAll, describe, expect, test } from "bun:test";
import { closeGraphLayoutWorkers, createGraphSceneLayouter, GRAPH_CARD_HEIGHT, GRAPH_CARD_WIDTH, layoutGraphScene, wrapGraphLabel, type PlacedGraphScene } from "./scene-layout";
import type { GraphQuery, GraphScene, SceneEdge, SceneNode } from "./scene";
import type { Relation } from "./types";

const query: GraphQuery = { view: "dependencies", q: "", group: "room", expanded: [], relations: [], depth: 3 };
function node(id: string, name = id): SceneNode {
  return { id, node: { id, side: "instance", kind: "device", name, context: "", page: `/devices/${id}`, icon: { kind: "emoji", value: "💡" }, ids: [id] }, hidden: 0 };
}
function edge(id: string, from: string, to: string, label?: string, relation: Relation = "uses"): SceneEdge {
  return { id, from, to, edge: { from, to, relation, origin: "resolution", ...(label ? { label } : {}) } };
}
function scene(nodes = [node("a", "Switch"), node("b", "Lamp"), node("c", "Bridge")], edges = [edge("ab", "a", "b", "on"), edge("bc", "b", "c")]): GraphScene {
  return { query, nodes, edges, groups: [], total: nodes.length, matched: nodes.length, omitted: 0, generatedAt: "2026-01-01T00:00:00.000Z" };
}
function geometry(placed: PlacedGraphScene) {
  return {
    nodes: placed.nodes.map(({ id, x, y, width, height, label }) => ({ id, x, y, width, height, label })).sort((a, b) => a.id.localeCompare(b.id)),
    edges: placed.edges.map(({ id, sections, label }) => ({ id, sections, label })).sort((a, b) => a.id.localeCompare(b.id)),
    width: placed.width, height: placed.height,
  };
}
function expectInBounds(placed: PlacedGraphScene) {
  expect(placed.width).toBeGreaterThan(0);
  expect(placed.height).toBeGreaterThan(0);
  const within = (x: number, y: number) => {
    expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
    expect(x).toBeGreaterThanOrEqual(0); expect(y).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThanOrEqual(placed.width + .01); expect(y).toBeLessThanOrEqual(placed.height + .01);
  };
  for (const node of placed.nodes) { within(node.x, node.y); within(node.x + node.width, node.y + node.height); }
  for (const edge of placed.edges) {
    for (const section of edge.sections) for (const point of [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]) within(point.x, point.y);
    if (edge.label) { within(edge.label.x, edge.label.y); within(edge.label.x + edge.label.width, edge.label.y + edge.label.height); }
  }
}
afterAll(closeGraphLayoutWorkers);

describe("graph scene layout", () => {
  test("routes every edge through ELK and retains its role and canonical evidence", async () => {
    const input = scene();
    const placed = await layoutGraphScene(input);
    expect(placed.nodes).toHaveLength(3);
    expect(placed.edges).toHaveLength(2);
    expect(placed.nodes.every(node => node.width === GRAPH_CARD_WIDTH && node.height === GRAPH_CARD_HEIGHT)).toBe(true);
    expect(placed.edges[0]!.label?.text).toBe("uses · on");
    for (const edge of placed.edges) {
      expect(edge.sections.length).toBeGreaterThan(0);
      expect(edge.edge).toEqual(input.edges.find(original => original.id === edge.id)!.edge);
      const from = placed.nodes.find(node => node.id === edge.from)!;
      const to = placed.nodes.find(node => node.id === edge.to)!;
      const start = edge.sections[0]!.startPoint;
      const end = edge.sections.at(-1)!.endPoint;
      expect(start.x).toBeCloseTo(from.x + from.width);
      expect(end.x).toBeCloseTo(to.x);
      for (const section of edge.sections) {
        const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
        for (let i = 1; i < points.length; i++) expect(points[i]!.x === points[i - 1]!.x || points[i]!.y === points[i - 1]!.y).toBe(true);
      }
    }
    expectInBounds(placed);
  }, 15_000);

  test("preserves parallel roles and handles cycles without overlapping cards", async () => {
    const placed = await layoutGraphScene(scene(undefined, [edge("on", "a", "b", "on"), edge("off", "a", "b", "off"), edge("bc", "b", "c"), edge("ca", "c", "a")]));
    expect(placed.edges.map(edge => edge.id)).toEqual(["on", "off", "bc", "ca"]);
    expect(placed.edges.every(edge => edge.sections.length > 0)).toBe(true);
    expect(placed.edges[0]!.sections).not.toEqual(placed.edges[1]!.sections);
    for (const a of placed.nodes) for (const b of placed.nodes) {
      if (a.id >= b.id) continue;
      expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
    }
    expectInBounds(placed);
  });

  test("a labelled diamond fits a readable pane without labels or routes crossing other cards", async () => {
    const placed = await layoutGraphScene(scene([node("a", "Switch"), node("b", "On button"), node("c", "Off button"), node("d", "Blaster")], [edge("ab", "a", "b", "on"), edge("ac", "a", "c", "off"), edge("bd", "b", "d"), edge("cd", "c", "d")]));
    expect(placed.width).toBeLessThanOrEqual(1_000);
    for (const edge of placed.edges) {
      for (const node of placed.nodes) {
        const label = edge.label!;
        expect(label.x + label.width <= node.x || node.x + node.width <= label.x || label.y + label.height <= node.y || node.y + node.height <= label.y).toBe(true);
        if (node.id === edge.from || node.id === edge.to) continue;
        for (const section of edge.sections) {
          const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
          for (let i = 1; i < points.length; i++) {
            const a = points[i - 1]!, b = points[i]!;
            const crosses = a.x === b.x
              ? a.x > node.x && a.x < node.x + node.width && Math.max(a.y, b.y) > node.y && Math.min(a.y, b.y) < node.y + node.height
              : a.y > node.y && a.y < node.y + node.height && Math.max(a.x, b.x) > node.x && Math.min(a.x, b.x) < node.x + node.width;
            expect(crosses).toBe(false);
          }
        }
      }
    }
    expectInBounds(placed);
  });

  test("deterministic geometry does not depend on input enumeration or worker reuse", async () => {
    const input = scene();
    const first = await layoutGraphScene(input);
    closeGraphLayoutWorkers();
    const next = await layoutGraphScene({ ...input, nodes: [...input.nodes].reverse(), edges: [...input.edges].reverse() });
    expect(geometry(next)).toEqual(geometry(first));
  }, 15_000);

  test("supports downwards flow and disconnected nodes", async () => {
    const input = scene([node("a"), node("b"), node("alone")], [edge("ab", "a", "b")]);
    const placed = await layoutGraphScene(input, { direction: "DOWN" });
    const from = placed.nodes.find(node => node.id === "a")!;
    const to = placed.nodes.find(node => node.id === "b")!;
    expect(to.y).toBeGreaterThan(from.y + from.height);
    expect(placed.edges[0]!.sections[0]!.startPoint.y).toBeCloseTo(from.y + from.height);
    expectInBounds(placed);
  });

  test("cached geometry receives current metadata and is isolated from caller mutation", async () => {
    const input = scene();
    const first = await layoutGraphScene(input);
    const expectedX = first.nodes[0]!.x;
    (first.nodes[0] as { x: number }).x = -900;
    const changed: GraphScene = { ...input, query: { ...query, selected: "b" }, generatedAt: "2026-02-02T00:00:00.000Z", nodes: input.nodes.map(node => ({ ...node, hidden: 7, node: { ...node.node, present: false, page: "/devices/new-address" } })) };
    const second = await layoutGraphScene(changed);
    expect(second.nodes[0]!.x).toBe(expectedX);
    expect(second.query.selected).toBe("b");
    expect(second.generatedAt).toBe(changed.generatedAt);
    expect(second.nodes[0]!.hidden).toBe(7);
    expect(second.nodes[0]!.node.present).toBe(false);
    expect(second.nodes[0]!.node.page).toBe("/devices/new-address");
  });

  test("Home keeps inspectable connections without drawing room-to-room routes", async () => {
    const input = scene();
    const placed = await layoutGraphScene({ ...input, query: { ...query, view: "home" }, nodes: input.nodes.map(node => ({ ...node, group: "room-one" })) });
    expect(placed.edges).toHaveLength(input.edges.length);
    expect(placed.edges.every(edge => edge.sections.length === 0)).toBe(true);
    expectInBounds(placed);
  });

  test("empty scenes have finite bounds and invalid endpoint closure is rejected", async () => {
    expectInBounds(await layoutGraphScene(scene([], [])));
    await expect(layoutGraphScene(scene([node("a")], [edge("missing", "a", "absent")]))).rejects.toMatchObject({ code: "invalid_scene" });
    await expect(layoutGraphScene(scene([node("a"), node("a")], []))).rejects.toMatchObject({ code: "invalid_scene" });
    await expect(layoutGraphScene(scene(Array.from({ length: 401 }, (_, i) => node(String(i))), []))).rejects.toMatchObject({ code: "invalid_scene" });
  });

  test("wraps long names into at most three lines without breaking Unicode", () => {
    expect(wrapGraphLabel("Kitchen lamp")).toEqual(["Kitchen lamp"]);
    const words = wrapGraphLabel("A very long descriptive device name with more detail than a graph card can reasonably display");
    expect(words).toHaveLength(3);
    expect(words[2]!.endsWith("…")).toBe(true);
    const unicode = wrapGraphLabel("電灯💡".repeat(30));
    expect(unicode).toHaveLength(3);
    expect(unicode.join("")).not.toContain("�");
    expect(unicode[2]!.endsWith("…")).toBe(true);
  });

  test("bounds pending work while coalescing identical requests", async () => {
    const service = createGraphSceneLayouter({ maxPending: 1 });
    try {
      const first = service.layout(scene());
      const duplicate = service.layout(scene());
      await expect(service.layout(scene([node("different")], []))).rejects.toMatchObject({ code: "busy" });
      const [a, b] = await Promise.all([first, duplicate]);
      expect(geometry(a)).toEqual(geometry(b));
    } finally { service.close(); }
  }, 15_000);

  test("deadlines terminate the worker and close rejects outstanding work explicitly", async () => {
    const slow = createGraphSceneLayouter({ timeoutMs: 1 });
    try { await expect(slow.layout(scene())).rejects.toMatchObject({ code: "timeout" }); }
    finally { slow.close(); }
    const service = createGraphSceneLayouter();
    const pending = service.layout(scene()).then(() => undefined, error => error);
    service.close();
    expect(await pending).toMatchObject({ code: "closed" });
    await expect(service.layout(scene())).rejects.toMatchObject({ code: "closed" });
  }, 15_000);

  test("an idle layout worker does not keep a completed process alive", async () => {
    const source = `import { layoutGraphScene } from ${JSON.stringify(new URL("./scene-layout.ts", import.meta.url).href)}; await layoutGraphScene(${JSON.stringify(scene())}); console.log("done");`;
    const child = Bun.spawn([process.execPath, "--eval", source], { stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => child.kill(), 12_000);
    try {
      const [status, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(error).toBe("");
      expect(status).toBe(0);
      expect(output.trim()).toBe("done");
    } finally { clearTimeout(timeout); child.kill(); }
  }, 15_000);
});
