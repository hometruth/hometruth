import { TokenStore } from "../auth/store";
import { Service } from "../models/service";
import { describe, expect, test } from "bun:test";
import { Device } from "../models/device";
import { BinarySwitch } from "../models/binary-switch";
import { SHELLY_PLUS_1 } from "../devices/switches/shelly-plus-1";
import { Site } from "../site";
import { createApp } from "../server/app";
import { elementKey } from "../tags/identity";
import { tagNode } from "../graph/tag-graph";
import { runHt } from "../ht/index";
import { compilePlayground } from "../client/source";
import { HomeTruth } from "../client/index";
import { MemorySecretStore } from "../config/secrets";
import type { DeviceConfigWriter } from "../config/device-writer";
import { properties, typeScript } from "./schema";
import type { OpenApiDocument } from "../openapi/document";

class Relay extends BinarySwitch {
  calls: string[] = [];
  value: "on" | "off" = "off";
  async turnOn() { this.calls.push("on"); this.value = "on"; }
  async turnOff() { this.calls.push("off"); this.value = "off"; }
  async toggle() { this.calls.push("toggle"); this.value = this.value === "on" ? "off" : "on"; }
  async getState() { return this.value; }
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

const addressForKey = async (app: ReturnType<typeof createApp>, key: string): Promise<string> => {
  const inventory = await (await app.request("/api/inventory")).json();
  return inventory.elements.find((entry: { key: string }) => entry.key === key).address;
};

class TestService extends Service {
  calls = 0;
  status() { return { availability: "online" as const, detail: "Ready" }; }
  events() { return []; }
  subscribe() { return () => {}; }
  override get actions() { return [{ id: "pair", invoke: async () => { this.calls++; return { detail: "Paired" }; } }]; }
}

describe("element API surfaces", () => {
  test("the root page, REST API and CLI use the reserved root identity", async () => {
    const { app, device } = fixture();
    const html = await (await app.request("/")).text();
    expect(html).toContain("<code>root</code>");
    expect(html).toContain("ht.elements.root.describe()");
    const document = await (await app.request("/openapi.json")).json();
    expect(document.info["x-hometruth-object-id"]).toBe("root");
    expect(document.paths["/api/elements/root"].get["x-hometruth-cli"].example).toBe("ht root status");
    expect(document.paths["/api/graph/scene"].get).toBeDefined();
    const skill = await (await app.request("/SKILL.md")).text();
    expect(skill).toContain("name: hometruth\n");
    expect(skill).toContain("http://localhost/mcp");
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
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ query: { focus: "root", view: "dependencies" } });
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
    const tagAddress = await addressForKey(app, tagNode(tag));
    expect(document.paths[`/api/tags/${tagAddress}`].patch).toBeDefined();
    expect((await app.request(`${tag.page}/SKILL.md`)).status).toBe(404);
  });
  test("groups publish their shared controls even before a state sample arrives", async () => {
    const one = new SwitchDevice("one", "One", { host: "10.77.0.2" });
    const two = new SwitchDevice("two", "Two", { host: "10.77.0.3" });
    const site = new Site([one, two], undefined, undefined, undefined, undefined, undefined, [{ id: "group-id", name: "Both", members: ["one", "two"], asSwitch: true }]);
    const app = createApp(undefined, site);
    const api = await (await app.request("/groups/both/openapi.json")).json();
    expect(api.paths["/api/device-groups/both/controls/power.toggle"]).toBeDefined();
    expect((await app.request("/switches/both/SKILL.md")).status).toBe(404);
    expect(one.relay.calls).toEqual([]);
  });
  test("service actions are individually documented and callable through the CLI", async () => {
    const service = new TestService("service-id", "Pairing service");
    const app = createApp(undefined, new Site([], undefined, undefined, [service]));
    const api = await (await app.request("/services/pairing-service/openapi.json")).json();
    expect(api.paths["/api/services/pairing-service/actions/pair"]).toBeDefined();
    const code = await runHt(["pairing-service", "pair"], {
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
      expect((await app.request("/switches/exhaust-fan/openapi.json", { headers })).status).toBe(200);
      expect((await app.request("/switches/unrelated/openapi.json", { headers })).status).toBe(403);
      expect((await app.request("/SKILL.md", { headers })).status).toBe(200);
      expect((await app.request("/SKILL.md")).status).toBe(401);
      const skill = await (await app.request("/SKILL.md", { headers })).text();
      expect(skill).not.toMatch(/Exhaust Fan|Unrelated|relay-id|Kitchen/);
      expect((await app.request("/api/playground", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: '{"code":"console.log(1)"}' })).status).toBe(200);
    } finally { tokens.close(); }
  });
  test("all API tabs and every switch control are rendered without invoking hardware", async () => {
    const { app, device } = fixture();
    const response = await app.request("/switches/exhaust-fan");
    expect(response.status).toBe(200);
    const html = await response.text();
    const tabs = html.match(/<nav data-element-tabs[\s\S]*?<\/nav>/)?.[0] ?? "";
    for (const label of ["Controls", "Graph", "Log", "Settings"]) expect(tabs).toContain(`>${label}</a>`);
    for (const label of ["API", "REST", "CLI", "MCP", "SKILL.md"]) expect(tabs).toContain(`>${label}</a>`);
    for (const control of ["turnOn", "turnOff", "toggle"]) expect(html).toContain(`/controls/${control}`);
    expect(html).not.toContain("/controls/getState");
    expect(html).toContain("/api/switches/exhaust-fan/state");
    const publicProperties = html.match(/<details open><summary>Public properties[\s\S]*?<\/details>/)?.[0] ?? "";
    expect(publicProperties).toContain("Public properties (13)");
    expect(publicProperties).toContain("state.value");
    expect(publicProperties).toContain("state.stateSource");
    expect(publicProperties).not.toContain("unknown |");
    expect(publicProperties).not.toContain("object.");
    expect(publicProperties).not.toContain("config.");
    expect(publicProperties).not.toContain("model.");
    expect(html).toContain('id="element-page-panel" data-element-page-panel');
    expect(html).not.toContain('aria-label="API language"');
    expect(device.relay.calls).toEqual([]);
  });
  test("every API tab has a shareable link and renders the selected panel on arrival", async () => {
    const { app, device } = fixture();
    for (const [i, tab] of ['api', 'rest', 'cli', 'mcp', 'skill'].entries()) {
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
    expect((await app.request('/switches/exhaust-fan/graph')).status).toBe(404);
    const root = await (await app.request('/?tab=skill')).text();
    expect(root).toContain('id="api-tab-4" aria-controls="api-panel-4" aria-current="page"');
    expect(device.relay.calls).toEqual([]);
  });
  test("switch settings, inventory and default reads share the public switch schema", async () => {
    const { app, device } = fixture();
    const html = await (await app.request("/switches/exhaust-fan/settings?tab=rest")).text();
    expect(html).toContain('id="api-panel-1" aria-labelledby="api-tab-1">');
    const tables = [...html.matchAll(/<details open><summary>Public properties[\s\S]*?<\/details>/g)].map(match => match[0]);
    expect(tables).toHaveLength(3);
    for (const table of tables) {
      expect(table).toContain("Public properties (13)");
      expect(table).toContain("state.value");
      expect(table).not.toContain("unknown |");
      expect(table).not.toMatch(/object\.|capabilities|config\.|model\./);
    }
    const api = await (await app.request("/switches/exhaust-fan/openapi.json")).json();
    const read = api.paths["/api/switches/exhaust-fan"].get;
    expect(read["x-hometruth-cli"].name).toBe("status");
    const paths = properties(read.responses["200"].content["application/json"].schema, api).map(field => field.path);
    expect(paths).toEqual(["id", "state", "state.availability", "state.observedAt", "state.value", "state.stateSource", "state.commandedAt", "state.assumedAt", "actions", "actions.turnOn", "actions.turnOff", "actions.toggle", "actions.getState"]);
    const inventory = await (await app.request("/api/inventory")).json();
    const entry = inventory.elements.find((entry: { deviceId?: string }) => entry.deviceId === device.id);
    const contract = await (await app.request(`/api/inventory/${entry.address}`)).json();
    expect(contract.properties.map((field: { path: string }) => field.path)).toEqual(paths);
    expect(contract.methods.find((method: { name: string }) => method.name === "read").transport.path).toBe("/api/switches/exhaust-fan");
    expect(device.relay.calls).toEqual([]);

    const output: string[] = [];
    expect(await runHt(["exhaust-fan", "status", "--json"], {
      fetch: ((input: URL | RequestInfo, init?: RequestInit) => app.request(String(input), init)) as typeof fetch,
      env: { HOMETRUTH_URL: "http://localhost" }, secretStore: new MemorySecretStore(),
      stdout: value => output.push(value), stderr: value => output.push(value),
    })).toBe(0);
    const snapshot = JSON.parse(output.at(-1)!);
    expect(Object.keys(snapshot).sort()).toEqual(["actions", "id", "state"]);
    expect(snapshot.state.value).toBe("off");
    expect(device.relay.calls).toEqual([]);
  });
  test("the global skill is independent of element focus and OpenAPI binds the friendly address", async () => {
    const { app } = fixture();
    const skill = await app.request("/SKILL.md");
    expect(skill.headers.get("content-type")).toContain("text/markdown");
    const markdown = await skill.text();
    expect(markdown).toContain("name: hometruth\n");
    expect(markdown).toContain("http://localhost/api/inventory");
    expect(markdown).toContain("http://localhost/mcp");
    expect(markdown).not.toContain("exhaust-fan");
    expect(await (await app.request("/SKILL.md?element=exhaust-fan")).text()).toBe(markdown);
    expect(await (await app.request("/SKILL.md?element=unrelated")).text()).toBe(markdown);
    const response = await app.request("/switches/exhaust-fan/openapi.json");
    const api = await response.json();
    expect(api.openapi).toBe("3.1.0");
    expect(api.paths["/api/devices/exhaust-fan/controls/toggle"].post).toBeDefined();
    expect(api.paths["/api/devices/exhaust-fan/controls/getState"]).toBeUndefined();
    const state = api.paths["/api/switches/exhaust-fan/state"].get;
    expect(state["x-hometruth-cli"]).toMatchObject({ name: "state", method: "GET", body: "none", arguments: [] });
    expect(state["x-hometruth-permission"]).toBe("read");
    expect(state.requestBody).toBeUndefined();
    expect(properties(state.responses["200"].content["application/json"].schema, api).map(field => field.path)).toEqual(["availability", "observedAt", "value", "stateSource", "commandedAt", "assumedAt"]);
    expect(JSON.stringify(api.paths)).not.toContain("other-id");
    expect(api.paths["/api/lights/exhaust-fan"]).toBeUndefined();
    expect(api.paths["/api/aqara/exhaust-fan/pair"]).toBeUndefined();
    expect(api.paths["/api/devices/exhaust-fan/alarms/{file}"]).toBeUndefined();
    expect(api.paths["/api/state"].get.parameters[0].schema.enum).toEqual(["exhaust-fan"]);
    expect((await app.request("/switches/exhaust-fan/SKILL.md")).status).toBe(404);
    expect((await app.request("/switches/relay-id/SKILL.md")).status).toBe(404);
  });
  test("enabled, enable and disable agree across REST documentation and the CLI", async () => {
    const changes: boolean[] = [];
    const { app } = fixture({
      async add() {}, async addAll() {}, async rename() {},
      async setEnabled(_id, enabled) { changes.push(enabled); },
    });
    const api = await (await app.request("/switches/exhaust-fan/openapi.json")).json();
    expect(api.paths["/api/devices/exhaust-fan/enabled"].post).toBeUndefined();
    expect(api.components.schemas.DeviceEnabled.type).toBe("boolean");
    expect(api.components.schemas.DeviceEnabledRequest).toBeUndefined();
    const calls: { path: string; method: string; body?: BodyInit | null }[] = [];
    const output: string[] = [];
    for (const [command, value] of [["enabled", true], ["disable", false], ["enabled", false], ["enable", true]] as const) {
      const method = command === "enabled" ? "GET" : "POST";
      const path = `/api/devices/exhaust-fan/${command}`;
      const operation = api.paths[path][method.toLowerCase()];
      expect(operation.requestBody).toBeUndefined();
      expect(operation["x-hometruth-cli"]).toMatchObject({ name: command, method, path, body: "none", arguments: [] });
      expect(operation["x-hometruth-permission"]).toBe(command === "enabled" ? "read" : "admin");
      expect(await runHt(["exhaust-fan", command, "--json"], {
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
    const page = `/elements/${await addressForKey(app, elementKey("capability", "relay-id", "binarySwitch"))}`;
    expect(await (await app.request(page)).text()).toContain("data-element-api");
    expect((await app.request(`${page}/SKILL.md`)).status).toBe(404);
    expect((await app.request("/schemas/binary-switch/SKILL.md")).status).toBe(404);
    expect((await app.request(`${page}/openapi.json`)).status).toBe(200);
    expect((await app.request("/schemas/binary-switch/openapi.json")).status).toBe(200);
  });
  test("downloaded client and CLI execute the documented operation", async () => {
    const { app, device } = fixture();
    const source = await (await app.request("/ht.ts")).text();
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(source.replace(/^export default ht;?$/gm, "").replace(/^export /gm, ""));
    const Client = new Function(`${js}; return HomeTruth;`)() as typeof HomeTruth;
    const ht = new Client({ fetch: ((input: URL | RequestInfo, init?: RequestInit) => app.request(String(input), init)) as typeof fetch });
    await ht.connect("http://localhost");
    await ht.devices["exhaust-fan"]!.toggle();
    expect(device.relay.calls).toEqual(["toggle"]);
    expect((await app.request("/switches/exhaust-fan/api.ts")).status).toBe(404);
    const output: string[] = [];
    const code = await runHt(["exhaust-fan", "on"], {
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
    expect(await runHt(["exhaust-fan", "state", "--json"], {
      fetch: ((input: URL | RequestInfo, init?: RequestInit) => {
        calls.push({ path: new URL(String(input)).pathname, method: init?.method ?? "GET" });
        return app.request(String(input), init);
      }) as typeof fetch,
      env: { HOMETRUTH_URL: "http://localhost" }, secretStore: new MemorySecretStore(),
      stdout: value => output.push(value), stderr: value => output.push(value),
    })).toBe(0);
    expect(calls.at(-1)).toEqual({ path: "/api/switches/exhaust-fan/state", method: "GET" });
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
    expect(await run(["exhaust-fan", "help"])).toBe(0);
    expect(output.join("")).toContain("ht exhaust-fan on");
    expect(output.join("")).toContain("--limit <number>");
    expect(output.join("")).not.toContain("/api/");
    expect(output.join("")).not.toContain("switches-turn-on");
    expect(output.join("")).toContain("set-network-settings --address <string> --mac <string>");
    expect(await run(["exhaust-fan", "set-network-settings", "--address", "10.77.0.20"])).toBe(2);
    expect(calls.every(call => call.method === "GET")).toBe(true);
    expect(await run(["exhaust-fan", "events", "--limit", "5", "--json"])).toBe(0);
    expect(calls.at(-1)?.path).toBe("/api/devices/exhaust-fan/events?limit=5");
    expect(await run(["exhaust-fan", "snapshot"])).toBe(0);
    expect(calls.at(-1)?.path).toBe("/api/state?node=exhaust-fan");
    expect(await run(["exhaust-fan", "tag", "--name", "purpose", "--value", "123"])).toBe(0);
    expect(JSON.parse(calls.at(-1)!.body!)).toEqual({ name: "purpose", value: "123" });
    const tags = await (await app.request("/api/elements/exhaust-fan/tags")).json();
    const tag = tags.tags.find((tag: { name: string }) => tag.name === "purpose");
    expect(tag.value).toBe("123");
    const tagAddress = await addressForKey(app, tagNode(tag));
    expect(await run([tagAddress, "status"])).toBe(0);
    expect(await run(["exhaust-fan", "untag", "--id", tagAddress])).toBe(0);
    expect(calls.at(-1)?.method).toBe("DELETE");
    const before = calls.filter(call => call.method !== "GET").length;
    expect(await run(["exhaust-fan", "untag"])).toBe(2);
    expect(await run(["exhaust-fan", "events", "--limti", "5"])).toBe(2);
    expect(await run(["exhaust-fan", "rename", "--name"])).toBe(2);
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
    expect(await run([await addressForKey(app, elementKey("capability", "one", "binarySwitch")), "on"])).toBe(0);
    expect(one.relay.calls).toEqual(["on"]);
    expect(await run(["both", "off"])).toBe(0);
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
