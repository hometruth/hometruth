import { TokenStore } from "../auth/store";
import { Service } from "../models/service";
import { describe, expect, test } from "bun:test";
import { Device } from "../models/device";
import { BinarySwitch } from "../models/binary-switch";
import { SHELLY_PLUS_1 } from "../devices/switches/shelly-plus-1";
import { Site } from "../site";
import { createApp } from "../server/app";
import { elementKey } from "../tags/identity";
import { runHt } from "../ht/index";
import { compilePlayground } from "../client/source";
import { HomeTruth } from "../client/index";
import { MemorySecretStore } from "../config/secrets";
import type { DeviceConfigWriter } from "../config/device-writer";
import { properties, typeScript } from "./schema";
import type { OpenApiDocument } from "../openapi/document";

class Relay extends BinarySwitch {
  calls: string[] = [];
  async turnOn() { this.calls.push("on"); }
  async turnOff() { this.calls.push("off"); }
  async toggle() { this.calls.push("toggle"); }
  async getState() { return "off" as const; }
}
class SwitchDevice extends Device<{ host: string }> {
  readonly model = SHELLY_PLUS_1;
  readonly relay = new Relay("switch");
  readonly capabilities = { binarySwitch: this.relay };
  async probe() { return {}; }
}
const fixture = (writer?: DeviceConfigWriter) => {
  const device = new SwitchDevice("relay-id", "Exhaust Fan", { host: "10.77.0.5" });
  const other = new SwitchDevice("other-id", "Unrelated", { host: "10.77.0.6" });
  const site = new Site([device, other]);
  return { device, site, app: createApp(undefined, site, undefined, undefined, undefined, undefined, undefined, writer) };
};

class TestService extends Service {
  calls = 0;
  status() { return { availability: "online" as const, detail: "Ready" }; }
  events() { return []; }
  subscribe() { return () => {}; }
  override get actions() { return [{ id: "pair", invoke: async () => { this.calls++; return { detail: "Paired" }; } }]; }
}

describe("element API surfaces", () => {
  test("the root page, REST API, CLI and skill use the reserved root identity", async () => {
    const { app, device } = fixture();
    const html = await (await app.request("/")).text();
    expect(html).toContain("<code>root</code>");
    expect(html).toContain("ht.elements.root.describe()");
    const document = await (await app.request("/openapi.json")).json();
    expect(document.info["x-hometruth-object-id"]).toBe("root");
    expect(document.paths["/api/elements/root"].get["x-hometruth-cli"].example).toBe("ht root status");
    expect(document.paths["/api/graph/root"].get).toBeDefined();
    const skill = await (await app.request("/SKILL.md")).text();
    expect(skill).toContain("Object ID: `root`");
    expect(skill).toContain("ht root help");
    expect(skill).toContain("ht root status");
    const oldKey = Buffer.from(JSON.stringify(["site", "hometruth"])).toString("base64url");
    expect(html).not.toContain(oldKey);
    expect(skill).not.toContain(oldKey);
    for (const path of [`/api/elements/${oldKey}`, `/api/graph/${oldKey}`, `/elements/${oldKey}`]) {
      expect((await app.request(path)).status).toBe(404);
    }

    const output: string[] = [];
    const run = (args: string[]) => runHt(args, {
      fetch: ((input: URL | RequestInfo, init?: RequestInit) => app.request(String(input), init)) as typeof fetch,
      env: { HOMETRUTH_URL: "http://localhost" }, secretStore: new MemorySecretStore(),
      stdout: value => output.push(value), stderr: value => output.push(value),
    });
    expect(await run(["root", "help"])).toBe(0);
    expect(output.join("")).toContain("ht root status");
    expect(await run(["root", "--json"])).toBe(0);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ id: "root", kind: "site" });
    expect(await run(["root", "status", "--json"])).toBe(0);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ element: { key: "root", kind: "site" } });
    expect(await run(["graph", "root", "--json"])).toBe(0);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ focus: "root" });
    expect(await run(["root", "tag", "--name", "purpose", "--value", "testing"])).toBe(0);
    const tags = await (await app.request("/api/elements/root/tags")).json();
    expect(tags.tags).toContainEqual(expect.objectContaining({ name: "purpose", value: "testing" }));
    expect(device.relay.calls).toEqual([]);
  });

  test("tag pages expose their own schema and operations", async () => {
    const device = new SwitchDevice("one", "One", { host: "10.77.0.2" });
    device.room = "Kitchen";
    const app = createApp(undefined, new Site([device]));
    const tags = await (await app.request("/api/tags")).json();
    const tag = tags.tags.find((tag: { value: string }) => tag.value === "Kitchen");
    const document = await (await app.request(`${tag.page}/openapi.json`)).json();
    expect(document.paths[`/api/tags/${tag.id}`].patch).toBeDefined();
    const skill = await (await app.request(`${tag.page}/SKILL.md`)).text();
    expect(skill).toContain("tag.color");
    expect(skill).not.toContain("/api/elements/");
  });
  test("groups publish their shared controls even before a state sample arrives", async () => {
    const one = new SwitchDevice("one", "One", { host: "10.77.0.2" });
    const two = new SwitchDevice("two", "Two", { host: "10.77.0.3" });
    const site = new Site([one, two], undefined, undefined, undefined, undefined, undefined, [{ id: "group-id", name: "Both", members: ["one", "two"], asSwitch: true }]);
    const app = createApp(undefined, site);
    const api = await (await app.request("/groups/both/openapi.json")).json();
    expect(api.paths["/api/device-groups/group-id/controls/power.toggle"]).toBeDefined();
    expect((await app.request("/switches/both/SKILL.md")).status).toBe(200);
    expect(one.relay.calls).toEqual([]);
  });
  test("service actions are individually documented and callable through the CLI", async () => {
    const service = new TestService("service-id", "Pairing service");
    const app = createApp(undefined, new Site([], undefined, undefined, [service]));
    const api = await (await app.request("/services/pairing-service/openapi.json")).json();
    expect(api.paths["/api/services/service-id/actions/pair"]).toBeDefined();
    const code = await runHt(["service-id", "pair"], {
      fetch: ((input: URL | RequestInfo, init?: RequestInit) => app.request(String(input), init)) as typeof fetch,
      env: { HOMETRUTH_URL: "http://localhost" }, stdout: () => {}, stderr: () => {},
    });
    expect(code).toBe(0);
    expect(service.calls).toBe(1);
  });
  test("generated files and compilation obey the element's token scope", async () => {
    const { site, device } = fixture(); device.room = "Kitchen";
    const tokens = new TokenStore();
    try {
      const app = createApp(undefined, site, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, tokens);
      const token = tokens.issue({ name: "Kitchen reader", permissions: ["read"], subject: { criteria: { room: "Kitchen" } } }).token;
      const headers = { authorization: `Bearer ${token}` };
      for (const suffix of ["SKILL.md", "openapi.json"]) {
        expect((await app.request(`/switches/exhaust-fan/${suffix}`, { headers })).status).toBe(200);
        expect((await app.request(`/switches/unrelated/${suffix}`, { headers })).status).toBe(403);
      }
      expect((await app.request("/api/playground", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: '{"code":"console.log(1)"}' })).status).toBe(200);
    } finally { tokens.close(); }
  });
  test("all four tabs and every switch control are rendered without invoking hardware", async () => {
    const { app, device } = fixture();
    const response = await app.request("/switches/exhaust-fan");
    expect(response.status).toBe(200);
    const html = await response.text();
    const tabs = html.match(/<nav data-element-tabs[\s\S]*?<\/nav>/)?.[0] ?? "";
    for (const label of ["Controls", "Graph", "Log", "Settings"]) expect(tabs).toContain(`>${label}</a>`);
    for (const label of ["API", "REST", "CLI", "SKILL.md"]) expect(tabs).toContain(`>${label}</a>`);
    for (const control of ["turnOn", "turnOff", "toggle"]) expect(html).toContain(`/controls/${control}`);
    expect(html).not.toContain("/controls/getState");
    expect(html).toContain("/api/switches/relay-id/state");
    const publicProperties = html.match(/<details open><summary>Public properties[\s\S]*?<\/details>/)?.[0] ?? "";
    expect(publicProperties).toContain("Public properties (10)");
    expect(publicProperties).toContain("state.value");
    expect(publicProperties).not.toContain("object.");
    expect(publicProperties).not.toContain("config.");
    expect(publicProperties).not.toContain("model.");
    expect(html).toContain('id="element-page-panel" data-element-page-panel');
    expect(html).not.toContain('aria-label="API language"');
    expect(device.relay.calls).toEqual([]);
  });
  test("every API tab has a shareable link and renders the selected panel on arrival", async () => {
    const { app, device } = fixture();
    for (const [i, tab] of ['api', 'rest', 'cli', 'skill'].entries()) {
      const response = await app.request(`/switches/exhaust-fan?tab=${tab}&rest-search=toggle`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain(`id="api-tab-${i}" aria-controls="api-panel-${i}" aria-current="page"`);
      expect(html).toContain(`id="api-panel-${i}" aria-labelledby="api-tab-${i}">`);
      expect(html).toContain('data-element-page-panel hidden');
      expect(html).not.toContain('data-element-api hidden');
      expect(html).toContain('href="/switches/exhaust-fan?tab=rest&amp;rest-search=toggle"');
      expect(html).toContain(`name="return" value="/switches/exhaust-fan?tab=${tab}&amp;rest-search=toggle"`);
    }
    const graph = await (await app.request('/switches/exhaust-fan/graph?expand=root&tab=rest')).text();
    expect(graph).toContain('href="/switches/exhaust-fan/graph?expand=root&amp;tab=cli"');
    const root = await (await app.request('/?tab=skill')).text();
    expect(root).toContain('id="api-tab-3" aria-controls="api-panel-3" aria-current="page"');
    expect(device.relay.calls).toEqual([]);
  });
  test("switch settings, inventory, skill and default reads share the public switch schema", async () => {
    const { app, device } = fixture();
    const html = await (await app.request("/switches/exhaust-fan/settings?tab=rest")).text();
    expect(html).toContain('id="api-panel-1" aria-labelledby="api-tab-1">');
    const tables = [...html.matchAll(/<details open><summary>Public properties[\s\S]*?<\/details>/g)].map(match => match[0]);
    expect(tables).toHaveLength(3);
    for (const table of tables) {
      expect(table).toContain("Public properties (10)");
      expect(table).toContain("state.value");
      expect(table).not.toMatch(/object\.|capabilities|config\.|model\./);
    }
    const markdown = await (await app.request("/switches/exhaust-fan/SKILL.md")).text();
    expect(markdown).toContain("`state.value`");
    expect(markdown).toContain("Run `ht relay-id status` to read the object");
    expect(markdown).not.toContain("object.capabilities");
    const api = await (await app.request("/switches/exhaust-fan/openapi.json")).json();
    const read = api.paths["/api/switches/relay-id"].get;
    expect(read["x-hometruth-cli"].name).toBe("status");
    const paths = properties(read.responses["200"].content["application/json"].schema, api).map(field => field.path);
    expect(paths).toEqual(["id", "state", "state.availability", "state.observedAt", "state.value", "actions", "actions.turnOn", "actions.turnOff", "actions.toggle", "actions.getState"]);
    const inventory = await (await app.request("/api/inventory")).json();
    const entry = inventory.elements.find((entry: { deviceId?: string }) => entry.deviceId === device.id);
    const contract = await (await app.request(`/api/inventory/${entry.uuid}`)).json();
    expect(contract.properties.map((field: { path: string }) => field.path)).toEqual(paths);
    expect(contract.methods.find((method: { name: string }) => method.name === "read").transport.path).toBe("/api/switches/relay-id");
    expect(device.relay.calls).toEqual([]);

    const output: string[] = [];
    expect(await runHt(["relay-id", "status", "--json"], {
      fetch: ((input: URL | RequestInfo, init?: RequestInit) => app.request(String(input), init)) as typeof fetch,
      env: { HOMETRUTH_URL: "http://localhost" }, secretStore: new MemorySecretStore(),
      stdout: value => output.push(value), stderr: value => output.push(value),
    })).toBe(0);
    const snapshot = JSON.parse(output.at(-1)!);
    expect(Object.keys(snapshot).sort()).toEqual(["actions", "id", "state"]);
    expect(snapshot.state.value).toBe("off");
    expect(device.relay.calls).toEqual([]);
  });
  test("the skill and OpenAPI bind the canonical page to the actual id", async () => {
    const { app } = fixture();
    const skill = await app.request("/switches/exhaust-fan/SKILL.md");
    expect(skill.headers.get("content-type")).toContain("text/markdown");
    const markdown = await skill.text();
    expect(markdown).toContain("Object ID: `relay-id`");
    expect(markdown).toContain("ht relay-id toggle");
    const response = await app.request("/switches/exhaust-fan/openapi.json");
    const api = await response.json();
    expect(api.openapi).toBe("3.1.0");
    expect(api.paths["/api/devices/relay-id/controls/toggle"].post).toBeDefined();
    expect(api.paths["/api/devices/relay-id/controls/getState"]).toBeUndefined();
    const state = api.paths["/api/switches/relay-id/state"].get;
    expect(state["x-hometruth-cli"]).toMatchObject({ name: "state", method: "GET", body: "none", arguments: [] });
    expect(state["x-hometruth-permission"]).toBe("read");
    expect(state.requestBody).toBeUndefined();
    expect(properties(state.responses["200"].content["application/json"].schema, api).map(field => field.path)).toEqual(["availability", "observedAt", "value"]);
    expect(JSON.stringify(api.paths)).not.toContain("other-id");
    expect(api.paths["/api/lights/relay-id"]).toBeUndefined();
    expect(api.paths["/api/aqara/relay-id/pair"]).toBeUndefined();
    expect(api.paths["/api/devices/relay-id/alarms/{file}"]).toBeUndefined();
    expect(api.paths["/api/state"].get.parameters[0].schema.enum).toEqual(["device/relay-id"]);
    expect(markdown).toContain("ht relay-id watch");
    expect(markdown).not.toContain("ht api");
    expect(markdown).not.toContain("/api/");
    expect((await app.request("/switches/relay-id/SKILL.md")).status).toBe(404);
  });
  test("enabled, enable and disable agree across REST documentation and the CLI", async () => {
    const changes: boolean[] = [];
    const { app } = fixture({
      async add() {}, async addAll() {}, async rename() {},
      async setEnabled(_id, enabled) { changes.push(enabled); },
    });
    const api = await (await app.request("/switches/exhaust-fan/openapi.json")).json();
    expect(api.paths["/api/devices/relay-id/enabled"].post).toBeUndefined();
    expect(api.components.schemas.DeviceEnabled.type).toBe("boolean");
    expect(api.components.schemas.DeviceEnabledRequest).toBeUndefined();
    const calls: { path: string; method: string; body?: BodyInit | null }[] = [];
    const output: string[] = [];
    for (const [command, value] of [["enabled", true], ["disable", false], ["enabled", false], ["enable", true]] as const) {
      const method = command === "enabled" ? "GET" : "POST";
      const path = `/api/devices/relay-id/${command}`;
      const operation = api.paths[path][method.toLowerCase()];
      expect(operation.requestBody).toBeUndefined();
      expect(operation["x-hometruth-cli"]).toMatchObject({ name: command, method, path, body: "none", arguments: [] });
      expect(operation["x-hometruth-permission"]).toBe(command === "enabled" ? "read" : "admin");
      expect(await runHt(["relay-id", command, "--json"], {
        fetch: ((input: URL | RequestInfo, init?: RequestInit) => {
          calls.push({ path: new URL(String(input)).pathname, method: init?.method ?? "GET", ...(init?.body ? { body: init.body } : {}) });
          return app.request(String(input), init);
        }) as typeof fetch,
        env: { HOMETRUTH_URL: "http://localhost" }, secretStore: new MemorySecretStore(),
        stdout: value => output.push(value), stderr: value => output.push(value),
      })).toBe(0);
      expect(calls.at(-1)).toEqual({ path, method });
      expect(JSON.parse(output.at(-1)!)).toBe(value);
    }
    expect(changes).toEqual([false, true]);
  });
  test("nested schema elements get the same surfaces", async () => {
    const { app } = fixture();
    const page = `/elements/${elementKey("capability", "relay-id", "binarySwitch")}`;
    expect(await (await app.request(page)).text()).toContain("data-element-api");
    expect((await app.request(`${page}/SKILL.md`)).status).toBe(200);
    const capabilitySkill = await (await app.request(`${page}/SKILL.md`)).text();
    expect(capabilitySkill).toContain("`state.value`");
    expect(capabilitySkill).not.toContain("object.capabilities");
    const schema = await app.request("/schemas/binary-switch/SKILL.md");
    expect(schema.status).toBe(200);
    expect(await schema.text()).toContain("state.value");
  });
  test("downloaded client and CLI execute the documented operation", async () => {
    const { app, device } = fixture();
    const source = await (await app.request("/ht.ts")).text();
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(source.replace(/^export default ht;?$/gm, "").replace(/^export /gm, ""));
    const Client = new Function(`${js}; return HomeTruth;`)() as typeof HomeTruth;
    const ht = new Client({ fetch: ((input: URL | RequestInfo, init?: RequestInit) => app.request(String(input), init)) as typeof fetch });
    await ht.connect("http://localhost");
    await ht.devices["relay-id"]!.toggle();
    expect(device.relay.calls).toEqual(["toggle"]);
    expect((await app.request("/switches/exhaust-fan/api.ts")).status).toBe(404);
    const output: string[] = [];
    const code = await runHt(["relay-id", "on"], {
      fetch: ((input: URL | RequestInfo, init?: RequestInit) => app.request(String(input), init)) as typeof fetch,
      env: { HOMETRUTH_URL: "http://localhost" }, stdout: value => output.push(value), stderr: value => output.push(value),
    });
    expect(code).toBe(0);
    expect(device.relay.calls).toEqual(["toggle", "on"]);
  });
  test("the CLI state command uses GET and returns the switch state directly", async () => {
    const { app, device } = fixture();
    const calls: { path: string; method: string }[] = [];
    const output: string[] = [];
    expect(await runHt(["relay-id", "state", "--json"], {
      fetch: ((input: URL | RequestInfo, init?: RequestInit) => {
        calls.push({ path: new URL(String(input)).pathname, method: init?.method ?? "GET" });
        return app.request(String(input), init);
      }) as typeof fetch,
      env: { HOMETRUTH_URL: "http://localhost" }, secretStore: new MemorySecretStore(),
      stdout: value => output.push(value), stderr: value => output.push(value),
    })).toBe(0);
    expect(calls.at(-1)).toEqual({ path: "/api/switches/relay-id/state", method: "GET" });
    expect(calls.every(call => call.method === "GET")).toBe(true);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ availability: "online", value: "off" });
    expect(device.relay.calls).toEqual([]);
  });
  test("native help, query options and tag commands use the published command guide", async () => {
    const { app, device } = fixture();
    const calls: { path: string; method: string; body?: string }[] = [];
    const output: string[] = [];
    const run = (args: string[]) => runHt(args, {
      fetch: ((input: URL | RequestInfo, init?: RequestInit) => {
        const url = new URL(String(input));
        calls.push({ path: url.pathname + url.search, method: init?.method ?? "GET", ...(init?.body ? { body: String(init.body) } : {}) });
        return app.request(String(input), init);
      }) as typeof fetch,
      env: { HOMETRUTH_URL: "http://localhost" }, stdout: value => output.push(value), stderr: value => output.push(value),
    });
    expect(await run(["relay-id", "help"])).toBe(0);
    expect(output.join("")).toContain("ht relay-id on");
    expect(output.join("")).toContain("--limit <number>");
    expect(output.join("")).not.toContain("/api/");
    expect(output.join("")).not.toContain("switches-turn-on");
    expect(output.join("")).toContain("set-network-settings --address <string> --mac <string>");
    expect(await run(["relay-id", "set-network-settings", "--address", "10.77.0.20"])).toBe(2);
    expect(calls.every(call => call.method === "GET")).toBe(true);
    expect(await run(["relay-id", "events", "--limit", "5", "--json"])).toBe(0);
    expect(calls.at(-1)?.path).toBe("/api/devices/relay-id/events?limit=5");
    expect(await run(["relay-id", "snapshot"])).toBe(0);
    expect(calls.at(-1)?.path).toBe("/api/state?node=device%2Frelay-id");
    expect(await run(["relay-id", "tag", "--name", "purpose", "--value", "123"])).toBe(0);
    expect(JSON.parse(calls.at(-1)!.body!)).toEqual({ name: "purpose", value: "123" });
    const tags = await (await app.request(`/api/elements/${elementKey("device", "relay-id")}/tags`)).json();
    const tag = tags.tags.find((tag: { name: string }) => tag.name === "purpose");
    expect(tag.value).toBe("123");
    expect(await run([tag.id, "status"])).toBe(0);
    expect(await run(["relay-id", "untag", "--id", tag.id])).toBe(0);
    expect(calls.at(-1)?.method).toBe("DELETE");
    const before = calls.filter(call => call.method !== "GET").length;
    expect(await run(["relay-id", "untag"])).toBe(2);
    expect(await run(["relay-id", "events", "--limti", "5"])).toBe(2);
    expect(await run(["relay-id", "rename", "--name"])).toBe(2);
    expect(calls.filter(call => call.method !== "GET")).toHaveLength(before);
    expect(device.relay.calls).toEqual([]);
  });
  test("nested elements and groups run their advertised friendly commands", async () => {
    const one = new SwitchDevice("one", "One", { host: "10.77.0.2" });
    const two = new SwitchDevice("two", "Two", { host: "10.77.0.3" });
    const site = new Site([one, two], undefined, undefined, undefined, undefined, undefined, [{ id: "group-id", name: "Both", members: ["one", "two"], asSwitch: true }]);
    const app = createApp(undefined, site);
    const run = (args: string[]) => runHt(args, {
      fetch: ((input: URL | RequestInfo, init?: RequestInit) => app.request(String(input), init)) as typeof fetch,
      env: { HOMETRUTH_URL: "http://localhost" }, stdout: () => {}, stderr: () => {},
    });
    expect(await run([elementKey("capability", "one", "binarySwitch"), "on"])).toBe(0);
    expect(one.relay.calls).toEqual(["on"]);
    expect(await run(["group-id", "off"])).toBe(0);
    expect(one.relay.calls).toEqual(["on", "off"]);
    expect(two.relay.calls).toEqual(["off"]);
  });
  test("playground compiles types but never executes submitted code on the server", async () => {
    const { app, device } = fixture();
    const response = await app.request("/api/playground", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: 'const x: string = "hello"; console.log(x);' }) });
    expect(response.status).toBe(200);
    expect((await response.json()).code).not.toContain("const x: string");
    expect(device.relay.calls).toEqual([]);
    expect((await app.request("/api/playground", { method: "POST", headers: { "content-type": "application/json", origin: "https://example.com" }, body: '{"code":""}' })).status).toBe(403);
    expect(() => compilePlayground("const =")).toThrow();
  });
  test("schema traversal preserves base fields with unions and arrays", () => {
    const document = { components: { schemas: {} } } as unknown as OpenApiDocument;
    const schema = { type: "object", properties: { state: { type: "string" }, nested: { type: "array", items: { type: "object", properties: { value: { type: "number" } } } } }, anyOf: [{ required: ["state"] }] };
    expect(typeScript(schema, document)).toContain('"state"?: string');
    expect(properties(schema, document).map(field => field.path)).toContain("nested[].value");
  });
});
