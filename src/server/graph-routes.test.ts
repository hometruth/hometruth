import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { createApp } from "./app";
import { Site } from "../site";
import { elementKey } from "../tags/identity";
import { tagNode } from "../graph/tag-graph";
import { ROOM } from "../tags/model";
import { graphEdgeSchema, graphNodeSchema, graphResponseSchema } from "../graph/schemas";

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

const app = () => createApp(undefined, Site.fromConfig(SITE));
const focus = elementKey("device", "fireplace");

describe("graph API", () => {
  test("an element's view answers with nodes, edges and where to draw them", async () => {
    const response = await app().request(`/api/graph/${focus}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(validGraphResponse(body), JSON.stringify(validGraphResponse.errors)).toBe(true);
    expect(body.focus).toBe(focus);
    expect(body.depth).toBe(2);
    expect(body.nodes.map((entry: { node: { name: string } }) => entry.node.name)).toContain("Blaster");
    expect(body.viewBox).toHaveLength(4);
  });

  test("depth is bounded and defaults to two", async () => {
    const shallow = await (await app().request(`/api/graph/${focus}?depth=1`)).json();
    expect(shallow.depth).toBe(1);
    expect(shallow.nodes.every((entry: { depth: number }) => entry.depth <= 1)).toBe(true);
    expect(shallow.nodes.map((entry: { node: { name: string } }) => entry.node.name)).not.toContain("Blaster");

    const absurd = await (await app().request(`/api/graph/${focus}?depth=99`)).json();
    expect(absurd.depth).toBe(3);
    const nonsense = await (await app().request(`/api/graph/${focus}?depth=abc`)).json();
    expect(nonsense.depth).toBe(2);
  });

  test("an unknown element is a 404, not an empty graph", async () => {
    const response = await app().request(`/api/graph/${elementKey("device", "nope")}`);
    expect(response.status).toBe(404);
  });

  test("the whole graph can be filtered to one side or one kind", async () => {
    const models = await (await app().request("/api/graph?side=schema&kind=model")).json();
    expect(models.nodes.length).toBeGreaterThan(20);
    expect(models.nodes.every((node: { kind: string; side: string }) => node.kind === "model" && node.side === "schema")).toBe(true);

    const devices = await (await app().request("/api/graph?side=instance&kind=device")).json();
    expect(devices.nodes.map((node: { name: string }) => node.name).sort())
      .toEqual(["Blaster", "Candle off", "Candle on", "Fireplace candles"]);
    // Filtering the nodes must not leave an edge pointing at something absent.
    const present = new Set(devices.nodes.map((node: { id: string }) => node.id));
    for (const edge of devices.edges) {
      expect(present.has(edge.from)).toBe(true);
      expect(present.has(edge.to)).toBe(true);
    }
  });

  test("the recorded reference is visible in the response, with its role", async () => {
    const body = await (await app().request(`/api/graph/${focus}`)).json();
    const uses = body.edges.filter((edge: { relation: string; origin: string }) => edge.relation === "uses" && edge.origin === "resolution");
    const roles = uses.map((edge: { label?: string }) => edge.label).filter(Boolean).sort();
    expect(roles).toEqual(["off", "on"]);
    const narrowed = uses.filter((edge: { via?: string }) => edge.via !== undefined);
    expect(narrowed.map((edge: { via?: string }) => edge.via)).toEqual(["button", "button"]);
  });
});

describe("graph page", () => {
  test("shows where an element sits and what it is made of, not its whole neighbourhood", async () => {
    const page = await app().request("/switches/fireplace-candles/graph");
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<svg class="graph"');
    expect(html).toContain('aria-current="page"');

    const labels = [...html.matchAll(/class="graph-label"[^>]*>([^<]*)</gu)].map((match) => match[1]);
    // The path back to the root, then what the switch is made of.
    expect(labels).toEqual(["HomeTruth", "Devices", "Fireplace candles", "binarySwitch"]);
    // The blaster is two lateral hops away; it is counted, not drawn.
    expect(labels).not.toContain("Blaster");
    expect(html).toContain('class="graph-expander"');
  });

  test("a + opens one branch, and the link that does it is shareable", async () => {
    const opened = await app().request(`/switches/fireplace-candles/graph?expand=${focus}`);
    const html = await opened.text();
    const labels = [...html.matchAll(/class="graph-label"[^>]*>([^<]*)</gu)].map((match) => match[1]);
    expect(labels).toContain("Candle on");
    expect(labels).toContain("Candle off");
    expect(labels).toContain("Lounge");
    // Opening one node does not open everything: the blaster is one more hop.
    expect(labels).not.toContain("Blaster");
    expect(html).toContain("Collapse");
  });

  test("expanding twice reaches the device the buttons live on", async () => {
    const button = elementKey("device", "candle-on");
    const html = await (await app().request(`/switches/fireplace-candles/graph?expand=${focus},${button}`)).text();
    const labels = [...html.matchAll(/class="graph-label"[^>]*>([^<]*)</gu)].map((match) => match[1]);
    expect(labels).toContain("Blaster");
  });

  test("a kind hidden by default can be turned back on, and the menu says so", async () => {
    const html = await (await app().request("/switches/fireplace-candles/graph")).text();
    // Services are suppressed, so the menu offers them.
    expect(html).toMatch(/aria-pressed="false"[^>]*>Service</u);

    const shown = await (await app().request("/switches/fireplace-candles/graph?hidden=")).text();
    expect(shown).toMatch(/aria-pressed="true"[^>]*>Service</u);
  });

  test("an element without a device page still has one", async () => {
    const page = await app().request(`/elements/${tagNode({ name: ROOM, value: "Lounge" })}/graph`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<svg class="graph"');
  });

  test("nothing untranslated leaks into the page", async () => {
    const html = await (await app().request("/switches/fireplace-candles/graph")).text();
    expect(html).not.toMatch(/>graph\.[a-zA-Z]/u);
    expect(html).not.toMatch(/>relations\.[a-zA-Z]/u);
    expect(html).not.toMatch(/>tags\.kind\.[a-z]/u);
  });
});

describe("full graph page", () => {
  test("draws the whole graph from the root, with the element highlighted", async () => {
    const page = await app().request(`/graph?focus=${focus}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<svg class="graph"');
    expect(html).toContain('data-role="focus"');
    const labels = [...html.matchAll(/class="graph-label"[^>]*>([^<]*)</gu)].map((match) => match[1]);
    // The root and every catalog are named, because that ring is the index and
    // has the room. Deeper rings are too dense to label and say so by not
    // trying; the names are still on the nodes.
    expect(labels).toContain("HomeTruth");
    for (const catalog of ["Devices", "Rooms", "Groups", "Services", "Models", "Schemas", "Event types"]) {
      expect(labels, catalog).toContain(catalog);
    }
    expect((html.match(/class="graph-node"/gu) ?? []).length).toBeGreaterThan(labels.length);
  });

  test("says how much of the graph it is showing rather than quietly stopping", async () => {
    const html = await (await app().request("/graph")).text();
    expect(html).toMatch(/\d+ of \d+ elements/u);
  });

  test("leaves out the detail that would turn an overview into a hedge", async () => {
    const html = await (await app().request(`/graph?focus=${focus}`)).text();
    // Controls and properties are most of the graph by count and none of it by
    // meaning at this zoom.
    expect(html).not.toMatch(/class="graph-label"[^>]*>turnOn</u);
  });
});
