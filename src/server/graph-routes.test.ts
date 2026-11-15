import { afterAll, afterEach, describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { createApp } from "./app";
import { graphRoutes } from "./graph-routes";
import { Site } from "../site";
import { StateHub } from "../state/hub";
import { elementKey } from "../tags/identity";
import { tagNode } from "../graph/tag-graph";
import { ROOM } from "../tags/model";
import { graphEdgeSchema, graphNodeSchema, graphResponseSchema } from "../graph/schemas";
import { parseGraphQuery, projectGraph } from "../graph/scene";
import { closeGraphLayoutWorkers, layoutGraphScene, type PlacedGraphScene } from "../graph/scene-layout";
import { TokenStore } from "../auth/store";
import { TagStore } from "../tags/store";
import { addressesFor } from "../element-api/addresses";

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addSchema(graphNodeSchema);
ajv.addSchema(graphEdgeSchema);
const validGraphResponse = ajv.compile(graphResponseSchema);

const SITE = {
  schemaVersion: 2 as const,
  rooms: ["Lounge"],
  devices: [
    { id: "blaster", name: "Blaster", room: "Lounge", model: "broadlink-rm4-pro", config: { host: "10.78.0.30" } },
    { id: "candle-on", name: "Candle on", model: "action-button", config: { device: "blaster", control: "infraredBlaster.send" } },
    { id: "candle-off", name: "Candle off", model: "action-button", config: { device: "blaster", control: "infraredBlaster.send" } },
    { id: "fireplace", name: "Fireplace candles", room: "Lounge", model: "optimistic-switch", config: { onButton: "candle-on", offButton: "candle-off" } },
  ],
};
const focus = elementKey("device", "fireplace");
const focusAddress = "fireplace-candles";
const path = (query = "") => `/api/graph/scene${query ? `?${query}` : ""}`;
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
afterAll(() => closeGraphLayoutWorkers());
function fixture(tokens?: TokenStore) {
  const hub = new StateHub(), tags = new TagStore();
  const app = createApp(undefined, Site.fromConfig(SITE), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, tags, hub, tokens);
  cleanup.push(() => hub.stop(), () => tags.close());
  return { app, hub };
}

describe("graph scene API", () => {
  test("returns the same projected and positioned scene the page consumes", async () => {
    const { app, hub } = fixture();
    const params = new URLSearchParams({ view: "dependencies", focus: focusAddress });
    const response = await app.request(path(params.toString()));
    expect(response.status).toBe(200);
    const body = await response.json() as PlacedGraphScene;
    expect(validGraphResponse(body), JSON.stringify(validGraphResponse.errors)).toBe(true);
    expect(body).toEqual(await layoutGraphScene(projectGraph(hub.data.topology(), parseGraphQuery(new URLSearchParams({ ...Object.fromEntries(params), focus })))));
    expect(body.query).toMatchObject({ view: "dependencies", focus, depth: 2 });
    expect(body.nodes.map(entry => entry.node.name)).toContain("Blaster");
    expect(body.width).toBeGreaterThan(0);
    expect(body.edges.every(edge => edge.sections.length > 0)).toBe(true);
  });

  test("all lenses validate and home is the default", async () => {
    const { app, hub } = fixture();
    const roomAddress = addressesFor(hub).address(tagNode({ name: ROOM, value: "Lounge" }));
    for (const query of ["", "view=home&group=kind", `view=dependencies&focus=${focusAddress}`, `view=model&focus=${roomAddress}`]) {
      const response = await app.request(path(query));
      expect(response.status, query).toBe(200);
      const body = await response.json();
      expect(validGraphResponse(body), JSON.stringify(validGraphResponse.errors)).toBe(true);
      if (!query) expect(body.query.view).toBe("home");
    }
  });

  test("normalizes depth and applies search before geometry", async () => {
    const { app } = fixture();
    const shallow = await (await app.request(path(`view=dependencies&focus=${focusAddress}&depth=1`))).json();
    expect(shallow.query.depth).toBe(1);
    expect(shallow.nodes.map((entry: { node: { name: string } }) => entry.node.name)).not.toContain("Blaster");
    expect((await (await app.request(path(`view=dependencies&focus=${focusAddress}&depth=99`))).json()).query.depth).toBe(3);
    expect((await (await app.request(path(`view=dependencies&focus=${focusAddress}&depth=abc`))).json()).query.depth).toBe(2);
    const none = await (await app.request(path("q=there-is-no-such-device"))).json();
    expect(none.matched).toBe(0);
    expect(none.nodes).toEqual([]);
  });

  test("preserves reference roles and provenance in nested scene edges", async () => {
    const { app } = fixture();
    const body = await (await app.request(path(`view=dependencies&focus=${focusAddress}`))).json() as PlacedGraphScene;
    const uses = body.edges.map(entry => entry.edge).filter(edge => edge.from === focus && edge.relation === "uses" && edge.origin === "resolution");
    expect(uses.map(edge => edge.label).sort()).toEqual(["off", "on"]);
    expect(uses.map(edge => edge.via)).toEqual(["button", "button"]);
  });

  test("unknown focus and removed endpoint paths return 404 without redirects", async () => {
    const { app } = fixture();
    for (const url of [path("focus=missing"), "/graph?focus=missing", path(`focus=${focus}`), `/graph?focus=${focus}`, `/api/graph/${focus}`, "/api/graph/root", "/switches/fireplace-candles/graph", "/elements/root/graph"]) {
      const response = await app.request(url);
      expect(response.status, url).toBe(404);
      expect(response.headers.get("location")).toBeNull();
    }
  });

  test("selection and expansion use friendly element names while scene data retains its identities", async () => {
    const { app } = fixture();
    const params = new URLSearchParams({ view: "dependencies", focus: focusAddress, selected: "candle-on" });
    params.append("expand", "candle-on");
    params.append("expand", focusAddress);
    const response = await app.request(path(params.toString()));
    expect(response.status).toBe(200);
    const body = await response.json() as PlacedGraphScene;
    expect(body.query.selected).toBe(elementKey("device", "candle-on"));
    expect(body.query.expanded).toEqual([elementKey("device", "candle-on"), focus].sort());

    const room = tagNode({ name: ROOM, value: "Lounge" });
    for (const [publicGroup, internalGroup] of [
      ['["room","room-lounge"]', JSON.stringify(["room", room])],
      ['["kind","device"]', '["kind","device"]'],
      ['["unassigned"]', '["unassigned"]'],
    ]) {
      const query = new URLSearchParams({ expand: publicGroup! });
      const result = await app.request(path(query.toString()));
      expect(result.status).toBe(200);
      expect((await result.json()).query.expanded).toEqual([internalGroup]);
    }
  });

  test("selection and expansion reject raw keys and unknown names on the page and API", async () => {
    const { app } = fixture();
    const room = tagNode({ name: ROOM, value: "Lounge" });
    for (const params of [
      new URLSearchParams({ selected: focus }), new URLSearchParams({ selected: "missing" }),
      new URLSearchParams({ expand: focus }), new URLSearchParams({ expand: "missing" }),
      new URLSearchParams({ expand: JSON.stringify(["room", room]) }),
      new URLSearchParams({ expand: JSON.stringify(["room", focusAddress]) }),
    ]) for (const url of [path(params.toString()), `/graph?${params}`]) {
      const response = await app.request(url);
      expect(response.status, url).toBe(404);
      expect(response.headers.get("location")).toBeNull();
    }
  });

  test("layout failures are explicit 503 responses for both page and API", async () => {
    const { hub } = fixture();
    const routes = graphRoutes(hub, async () => { throw new Error("Synthetic layout failure"); });
    for (const url of ["/graph", path()]) {
      const response = await routes.request(url);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: "graph_unavailable" } });
    }
  });

  test("scene access requires site scope and never leaks neighbors to a device token", async () => {
    const tokens = new TokenStore();
    cleanup.push(() => tokens.close());
    const { app } = fixture(tokens);
    const token = tokens.issue({ name: "Synthetic device reader", permissions: ["read"], subject: { device: "fireplace" } }).token;
    const response = await app.request(path(`view=dependencies&focus=${focusAddress}`), { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("Blaster");
  });
});

describe("raw topology and canonical graph page", () => {
  test("raw topology retains canonical edges and supports all sides", async () => {
    const { app } = fixture();
    for (const side of ["instance", "schema", "tag"]) {
      const response = await app.request(`/api/graph?side=${side}`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.nodes.length).toBeGreaterThan(0);
      expect(body.nodes.every((node: { side: string }) => node.side === side)).toBe(true);
      const ids = new Set(body.nodes.map((node: { id: string }) => node.id));
      for (const edge of body.edges) expect(ids.has(edge.from) && ids.has(edge.to)).toBe(true);
      expect(body.query).toBeUndefined();
    }
  });

  test("canonical page renders each lens and device links point there", async () => {
    const { app } = fixture();
    for (const query of ["", `?view=dependencies&focus=${focusAddress}`, "?view=model"]) {
      const response = await app.request(`/graph${query}`);
      expect(response.status, query).toBe(200);
      const html = await response.text();
      expect(html).not.toMatch(/>graph\.[a-zA-Z]/u);
      expect(html).not.toMatch(/>relations\.[a-zA-Z]/u);
      expect(html).toContain("/graph");
    }
    const html = await (await app.request("/switches/fireplace-candles")).text();
    expect(html).toContain(`/graph?view=dependencies&amp;focus=${focusAddress}`);
    expect(html).not.toContain('href="/switches/fireplace-candles/graph"');
  });
});
