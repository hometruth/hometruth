/** Export the production page templates with an entirely local browser simulation. */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import type { DevicesConfig } from "../schemas";
import { createDemoSnapshot, DEMO_SNAPSHOT_TIME, type DemoSnapshot } from "./model";
import { createPageContext, escapeHtml, htElement, renderDeviceHead, renderPage, type PageContext } from "../ui/shell";
import { createTranslator, type Translator } from "../ui/i18n";
import { renderHomePage, partitionDevicesIntoGroups, groupPagePath } from "../ui/home";
import { renderOverviewPage } from "../ui/overview";
import { createFallingwaterSnapshot } from "./showcase";
import { renderSwitchesPage } from "../ui/switches-page";
import { renderButtonsPage } from "../ui/buttons-page";
import { renderGroupsPage } from "../ui/groups-page";
import { renderGroupPage } from "../ui/group-page";
import { renderLightPage } from "../ui/light-page";
import { renderStringLightPage } from "../ui/string-light-page";
import { renderSwitchPage } from "../ui/switch-page";
import { renderButtonPage } from "../ui/button-page";
import { renderTelevisionPage } from "../ui/television-page";
import { renderSpeakerPage } from "../ui/speaker-page";
import { renderCameraPage } from "../ui/camera-page";
import { renderSensorPage } from "../ui/sensor-page";
import { renderCooktopPage } from "../ui/cooktop-page";
import { renderDeviceSettingsPage } from "../ui/device-settings-page";
import { renderDeviceLogPage } from "../ui/device-log-page";
import { renderEventsPage } from "../ui/events-page";
import { renderGraphPage } from "../ui/graph-page";
import type { GraphContents } from "../graph/graph";
import { parseGraphQuery, type SceneGroup } from "../graph/scene";
import type { PlacedGraphScene } from "../graph/scene-layout";
import type { GraphNode, GraphEdge } from "../graph/types";
import { elementKey } from "../tags/identity";
import { groupPage, groupSwitchPage } from "../page-urls";
import type { RegisteredDevice } from "../site";
import { renderSchemaPage } from "../schema-page";
import { CAPABILITY_KIND_SCHEMA_IDS, schemaCatalogEntries, schemaPagePath } from "../schema-catalog";

export interface ExportDemoOptions { config: DevicesConfig; output: string; basePath?: string; includeNames?: boolean; showcase?: boolean; }
export interface DemoExportResult { output: string; snapshot: DemoSnapshot; pages: number; files: string[]; }

/** Rendering must not inherit the machine's timezone or the live app's cached formatter. */
function demoTranslator(): Translator {
  const time = new Intl.DateTimeFormat("en", { timeStyle: "medium", timeZone: "UTC" });
  const dateTime = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
  return { ...createTranslator("en"), time: value => time.format(new Date(value)), dateTime: value => dateTime.format(new Date(value)) };
}

function genericControls(ctx: PageContext, device: RegisteredDevice, snapshot: DemoSnapshot): string {
  const record = snapshot.records.find(record => record.node === `device/${device.id}`);
  const object = record?.value as { capabilities: Record<string, { actions: Record<string, unknown> }> };
  const controls = Object.entries(object.capabilities).map(([kind, doc]) => `<section><h2>${escapeHtml(ctx.i18n.lookup(`cap.${kind}`) ?? kind)}</h2><div class="bar">${Object.keys(doc.actions).map(action => `<button type="button" class="btn" data-demo-control="${escapeHtml(action)}" data-capability="${escapeHtml(kind)}">${escapeHtml(action.replace(/([A-Z])/g, " $1"))}</button>`).join("")}</div></section>`).join("");
  return renderPage({ ctx, title: device.name, nav: "devices", nodes: [`device/${device.id}`], body: `${renderDeviceHead(ctx, device, "controls")}${controls}<p role="status" data-generic-demo-feedback></p>`, script: `document.querySelectorAll('[data-demo-control]').forEach(button => button.addEventListener('click', async () => { try { await ht.request('/api/devices/${device.id}/capabilities/' + button.dataset.capability + '/controls/' + button.dataset.demoControl, {method:'POST',body:'{}'}); ht.say(document.querySelector('[data-generic-demo-feedback]'), 'Simulated ' + button.textContent.trim() + '.'); } catch(error) { ht.say(document.querySelector('[data-generic-demo-feedback]'), error.message); } }));` });
}

function devicePage(ctx: PageContext, device: RegisteredDevice, snapshot: DemoSnapshot): string {
  if (device.capabilities.includes("cooktop")) return renderCooktopPage({ ctx, device });
  switch (device.kind) {
    case "light": return renderLightPage({ ctx, device });
    case "string-light": return renderStringLightPage({ ctx, device, lights: snapshot.devices.filter(candidate => candidate.parent?.id === device.id) });
    case "binary-switch": return renderSwitchPage({ ctx, device });
    case "button": return renderButtonPage({ ctx, device });
    case "television": return renderTelevisionPage({ ctx, device });
    case "speaker": case "speaker-group": return renderSpeakerPage({ ctx, device });
    case "camera": return renderCameraPage({ ctx, device });
    case "pet-camera": return renderCameraPage({ ctx, device }).replace("</main>", `<section><h2>Treat dispenser</h2><button type="button" class="btn" data-demo-treat="${device.id}">Dispense a pretend treat</button><p data-demo-treat-feedback role="status"></p></section></main>`).replace("</body>", `<script>document.querySelector('[data-demo-treat]').addEventListener('click',async()=>{await ht.request('/api/devices/${device.id}/capabilities/treatDispenser/controls/dispense',{method:'POST',body:'{"value":1}'});ht.say(document.querySelector('[data-demo-treat-feedback]'),'Pretend treat dispensed.');});</script></body>`);
    case "sensor": case "hub": case "device": return renderSensorPage({ ctx, device });
    default: return genericControls(ctx, device, snapshot);
  }
}

function schemaAnchor(schemaId: string, label = schemaId): string {
  const path = schemaPagePath(schemaId);
  return path ? `<a href="${escapeHtml(path)}">${escapeHtml(label)}</a>` : escapeHtml(label);
}

function controlExample(action: string): Record<string, unknown> {
  const values: Record<string, unknown> = { setBrightness: 65, setColorTemperature: 3000, setColor: "#ffca80", setVolume: 25, setMute: false, setArtMode: true, setChildLock: false, setTimer: 60, dispense: 1, press: "home", playUri: "https://media.example.invalid/synthetic.mp3", say: "Welcome home" };
  return Object.hasOwn(values, action) ? { value: values[action] } : {};
}

/** Explain the same object and controls the ordinary UI reads, using the local simulator. */
function objectExplorer(device: RegisteredDevice, snapshot: DemoSnapshot): string {
  const object = snapshot.records.find(record => record.node === `device/${device.id}`)!.value as { capabilities: Record<string, { actions: Record<string, unknown> }> };
  const endpoint = `/api/devices/${device.id}`;
  const graph = `/graph?${new URLSearchParams({ selected: elementKey("device", device.id) })}`;
  const capabilities = Object.entries(object.capabilities).map(([kind, capability]) => `<section><h3>${escapeHtml(kind)}</h3><p>${schemaAnchor(CAPABILITY_KIND_SCHEMA_IDS[kind]!, "Capability schema")}</p>${Object.entries(capability.actions).map(([action, descriptor]) => {
    const path = `${endpoint}/capabilities/${kind}/controls/${action}`;
    return `<details><summary>${escapeHtml(action)}</summary><pre><code>POST ${escapeHtml(path)}</code></pre><p>Action description</p><pre>${escapeHtml(JSON.stringify(descriptor, null, 2))}</pre><label>JSON request body<textarea rows="3" data-demo-api-body>${escapeHtml(JSON.stringify(controlExample(action), null, 2))}</textarea></label><button class="btn btn-small" type="button" data-demo-api-control="${escapeHtml(path)}">Run simulated ${escapeHtml(action)}</button></details>`;
  }).join("") || '<p class="muted">Read-only capability; no controls are declared.</p>'}</section>`).join("");
  const sensors = device.sensors?.map(sensor => `<li>${schemaAnchor(sensor.schemaId, sensor.name)} <code>${escapeHtml(sensor.id)}</code></li>`).join("");
  return `<section id="demo-object-api" data-demo-object-api><h2>Object &amp; API</h2><p>This synthetic object powers the controls above. Requests run in this browser.</p><p>${schemaAnchor(device.schemaId, "Object schema")} · <a href="${escapeHtml(graph)}">Explore in graph</a></p><pre><code>GET ${endpoint}</code></pre><button type="button" class="btn btn-small" data-demo-api-read>Read current object</button><p role="status" data-demo-api-feedback></p><details open><summary>Current object state</summary><pre style="overflow:auto;max-height:36rem" data-demo-object-json>${escapeHtml(JSON.stringify(object, null, 2))}</pre></details>${sensors ? `<h3>Sensor schemas</h3><ul>${sensors}</ul>` : ""}<h3>Capabilities &amp; actions</h3>${capabilities || '<p class="muted">This device exposes individual sensors in the object above.</p>'}</section>`;
}

function withObjectExplorer(html: string, device: RegisteredDevice, snapshot: DemoSnapshot): string {
  const script = `<script>(()=>{const root=document.querySelector('[data-demo-object-api]');const output=root.querySelector('[data-demo-object-json]');const feedback=root.querySelector('[data-demo-api-feedback]');const show=value=>{output.textContent=JSON.stringify(value,null,2);};const request=async(path,init)=>{const response=await fetch(path,init);const result=await response.json();if(!response.ok)throw new Error(result.error?.message||'Could not simulate request');show(result.object);feedback.textContent='Simulated request complete.';};root.querySelector('[data-demo-api-read]').addEventListener('click',()=>request('/api/devices/${device.id}').catch(error=>feedback.textContent=error.message));root.querySelectorAll('[data-demo-api-control]').forEach(button=>button.addEventListener('click',async()=>{button.disabled=true;try{const body=JSON.parse(button.closest('details').querySelector('[data-demo-api-body]').value);await request(button.dataset.demoApiControl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});}catch(error){feedback.textContent=error.message;}finally{button.disabled=false;}}));const stream=new EventSource('/api/state/stream?node=device%2F${device.id}&tier=detail');stream.addEventListener('state',event=>{const record=JSON.parse(event.data);if(record.node==='device/${device.id}')show(record.value);});window.addEventListener('pagehide',()=>stream.close(),{once:true});})();</script>`;
  return html.replace("</main>", `${objectExplorer(device, snapshot)}</main>`).replace("</body>", `${script}</body>`);
}

function demoGraph(snapshot: DemoSnapshot): GraphContents {
  const nodes: GraphNode[] = [{ id: "root", side: "instance", kind: "site", name: "HomeTruth Demo", context: "", page: "/", icon: { kind: "emoji", value: "⌂" }, ids: [] }];
  const edges: GraphEdge[] = [];
  const rooms = new Map<string, string>();
  const schemas = new Set<string>();
  const addSchema = (schemaId: string) => {
    const id = elementKey("schema", schemaId);
    if (!schemas.has(schemaId)) {
      schemas.add(schemaId);
      const entry = schemaCatalogEntries.find(entry => entry.schema.$id === schemaId);
      nodes.push({ id, side: "schema", kind: "schema", name: entry?.title ?? schemaId, context: "JSON Schema", page: schemaPagePath(schemaId) ?? "/schemas", ids: [schemaId], icon: { kind: "emoji", value: "◇" } });
    }
    return id;
  };
  for (const device of snapshot.devices) {
    const id = elementKey("device", device.id);
    const schema = addSchema(device.schemaId);
    nodes.push({ id, side: "instance", kind: "device", name: device.name, context: device.modelTitle, page: device.page, stateNode: `device/${device.id}`, schema, ids: [device.id], icon: { kind: "emoji", value: device.capabilities.includes("light") ? "💡" : device.capabilities.includes("camera") ? "📷" : "◇" } });
    edges.push({ from: "root", to: id, relation: "contains", origin: "structure" });
    edges.push({ from: id, to: schema, relation: "instanceOf", origin: "schema" });
    for (const kind of device.capabilities) {
      const capabilityId = elementKey("capability", device.id, kind);
      const capabilitySchema = addSchema(CAPABILITY_KIND_SCHEMA_IDS[kind]!);
      nodes.push({ id: capabilityId, side: "instance", kind: "capability", name: kind, context: device.name, page: `${device.page}#demo-object-api`, ids: [device.id, kind], schema: capabilitySchema, stateNode: `device/${device.id}`, icon: { kind: "emoji", value: "◇" } });
      edges.push({ from: id, to: capabilityId, relation: "contains", origin: "structure" }, { from: capabilityId, to: capabilitySchema, relation: "instanceOf", origin: "schema" });
    }
    for (const sensor of device.sensors ?? []) {
      const sensorId = elementKey("sensor", device.id, sensor.id);
      const sensorSchema = addSchema(sensor.schemaId);
      nodes.push({ id: sensorId, side: "instance", kind: "sensor", name: sensor.name, context: device.name, page: `${device.page}#demo-object-api`, ids: [device.id, sensor.id], schema: sensorSchema, stateNode: `device/${device.id}`, icon: { kind: "emoji", value: "◇" } });
      edges.push({ from: id, to: sensorId, relation: "contains", origin: "structure" }, { from: sensorId, to: sensorSchema, relation: "instanceOf", origin: "schema" });
    }
    if (device.room) {
      let room = rooms.get(device.room);
      if (!room) { room = elementKey("tag", "room", device.room); rooms.set(device.room, room); nodes.push({ id: room, side: "tag", kind: "tag", name: device.room, context: "room", page: "/devices", ids: ["room", device.room], icon: { kind: "emoji", value: "⌂" } }); }
      edges.push({ from: room, to: id, relation: "tagged", origin: "site" });
    }
  }
  for (const group of snapshot.groups) {
    const id = elementKey("group", group.id);
    nodes.push({ id, side: "instance", kind: "group", name: group.name, context: "Device group", page: groupPage(group), ids: [group.id], icon: { kind: "emoji", value: "◇" } });
    edges.push({ from: "root", to: id, relation: "contains", origin: "structure" });
    for (const member of group.members) edges.push({ from: id, to: elementKey("device", member), relation: "members", origin: "site" });
  }
  return { nodes, edges, generatedAt: snapshot.records[0]?.updatedAt ?? DEMO_SNAPSHOT_TIME };
}

/** Keep the room cards, while making their inspectors explain the deeper topology. */
function graphDetails(html: string, snapshot: DemoSnapshot): string {
  const graph = snapshot.graph!;
  return html.replace(/(<section data-graph-panel="([^"]+)"[^>]*>)([\s\S]*?)(<\/section>)/g, (whole, start: string, id: string, body: string, end: string) => {
    const device = snapshot.devices.find(device => elementKey("device", device.id) === id);
    if (!device) return whole;
    const children = graph.edges.filter(edge => edge.from === id && edge.relation === "contains").map(edge => graph.nodes.find(node => node.id === edge.to)!);
    const groups = snapshot.groups.filter(group => group.members.includes(device.id));
    const details = `<div data-demo-graph-structure><h3>Object structure</h3><p>${escapeHtml(device.room ?? "Unassigned")} · ${schemaAnchor(device.schemaId, "Object schema")}</p><ul>${children.map(node => `<li>${escapeHtml(node.kind)} · ${escapeHtml(node.name)}${node.schema ? ` · ${schemaAnchor(graph.nodes.find(schema => schema.id === node.schema)!.ids[0]!, "schema")}` : ""}</li>`).join("")}</ul>${groups.length ? `<h3>Member of</h3><ul>${groups.map(group => `<li><a href="${groupPage(group)}">${escapeHtml(group.name)}</a></li>`).join("")}</ul>` : ""}<p><a href="${device.page}#demo-object-api">Read object &amp; try API controls →</a></p></div>`;
    return start + body + details + end;
  });
}

/** Every exported card must exist locally so search can find it without a server projection. */
function demoGraphScene(snapshot: DemoSnapshot, graph: GraphContents): PlacedGraphScene {
  const canonical = new Map(graph.nodes.map(node => [node.id, node]));
  const groups = new Map<string, SceneGroup>();
  const nodes = snapshot.devices.map(device => {
    const node = canonical.get(elementKey("device", device.id))!;
    const group = device.room ? JSON.stringify(["room", elementKey("tag", "room", device.room)]) : JSON.stringify(["unassigned"]);
    const previous = groups.get(group);
    groups.set(group, { id: group, name: device.room ?? "Unassigned", kind: device.room ? "room" : "unassigned", total: (previous?.total ?? 0) + 1, hidden: 0 });
    // The home lens lays these out with CSS; geometry is unused by its card renderer.
    return { id: JSON.stringify([group, node.id]), node, group, hidden: 0, x: 0, y: 0, width: 240, height: 120, label: [node.name] };
  });
  const sortedGroups = [...groups.values()].sort((a, b) => Number(a.kind === "unassigned") - Number(b.kind === "unassigned") || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { query: parseGraphQuery(new URLSearchParams()), nodes, edges: [], groups: sortedGroups, total: nodes.length, matched: nodes.length, omitted: 0, generatedAt: graph.generatedAt, width: 0, height: 0 };
}

/** Rendered routes retain the application's URL layout under a single base path. */
export async function renderDemoPages(snapshot: DemoSnapshot): Promise<Map<string, string>> {
  // Static HTML has no live observation. Omitting this render-only stamp avoids the
  // production fallback's wall-clock freshness check; the browser receives the full
  // snapshot through #ht-demo and confirms its simulated records after loading.
  const records = new Map(snapshot.records.map(({ observedAt: _observedAt, ...record }) => [record.node, record]));
  const rooms = [...new Set(snapshot.devices.flatMap(device => device.room ? [device.room] : []))];
  const i18n = demoTranslator();
  const context = (path: string) => createPageContext({ nonce: "demo", siteTitle: "HomeTruth", preferences: { theme: "wright", scheme: "auto", locale: "en" }, i18n, path, state: { snapshot: nodes => nodes.flatMap(node => records.get(node) ?? []) }, assetVersion: "demo", rooms });
  const pages = new Map<string, string>();
  pages.set("/", renderOverviewPage({ ctx: context("/"), devices: snapshot.devices, deviceGroups: snapshot.groups, showcase: Boolean(snapshot.presentation), ...(snapshot.presentation ? { presentation: snapshot.presentation } : {}) }));
  pages.set("/devices", renderHomePage({ ctx: context("/devices"), devices: snapshot.devices, deviceGroups: snapshot.groups }));
  pages.set("/rooms", renderPage({ ctx: context("/rooms"), title: "Rooms", nav: "rooms", body: `<p class="ht-eyebrow">THE SPACES IN BETWEEN</p><h1>Room by room.</h1><p>Explore the objects that make each space work.</p>${rooms.map(room => `<section><h2>${escapeHtml(room)}</h2><ul class="rows">${snapshot.devices.filter(device => device.room === room).map(device => `<li><a class="row" href="${device.page}"><strong>${escapeHtml(device.name)}</strong><span>${escapeHtml(device.modelTitle)}</span></a></li>`).join("")}</ul></section>`).join("")}` }));
  pages.set("/switches", renderSwitchesPage({ ctx: context("/switches"), switches: snapshot.devices.filter(device => device.capabilities.includes("binarySwitch")), buttons: [], canCreate: false, groups: snapshot.groups }));
  pages.set("/buttons", renderButtonsPage(context("/buttons"), snapshot.devices.filter(device => device.capabilities.includes("button")), false));
  pages.set("/groups", renderGroupsPage({ ctx: context("/groups"), devices: snapshot.devices, groups: snapshot.groups, canCreate: false }));
  for (const group of partitionDevicesIntoGroups(snapshot.devices).groups) {
    const path = groupPagePath(group.label);
    pages.set(path, renderGroupPage({ ctx: context(path), label: group.label, members: group.members, ...(group.controlDevice ? { controlDevice: group.controlDevice } : {}) }));
  }
  for (const group of snapshot.groups) {
    const path = groupPage(group);
    const members = snapshot.devices.filter(device => group.members.includes(device.id));
    const html = renderGroupPage({ ctx: context(path), label: group.name, members });
    pages.set(path, group.asSwitch ? html.replace("</main>", `${htElement(context(path), "ht-switch", `group/${group.id}`)}</main>`) : html);
    if (group.asSwitch) pages.set(groupSwitchPage(group), pages.get(path)!);
  }
  for (const device of snapshot.devices) {
    pages.set(device.page, withObjectExplorer(devicePage(context(device.page), device, snapshot), device, snapshot));
    pages.set(`${device.page}/settings`, renderDeviceSettingsPage({ ctx: context(`${device.page}/settings`), device }));
    pages.set(`${device.page}/log`, renderDeviceLogPage({ ctx: context(`${device.page}/log`), device, types: [] }));
  }
  pages.set("/events", renderEventsPage({ ctx: context("/events"), subjects: snapshot.devices.map(device => ({ id: device.id, name: device.name, page: device.page })), types: [] }));
  snapshot.graph = demoGraph(snapshot);
  snapshot.graphScene = demoGraphScene(snapshot, snapshot.graph);
  pages.set("/graph", graphDetails(renderGraphPage({ ctx: context("/graph"), scene: snapshot.graphScene }), snapshot));
  const usedSchemas = new Set(snapshot.devices.flatMap(device => [device.schemaId, ...device.capabilities.map(kind => CAPABILITY_KIND_SCHEMA_IDS[kind]!), ...(device.sensors ?? []).map(sensor => sensor.schemaId)]));
  const schemaLinks: string[] = [];
  for (const entry of schemaCatalogEntries) {
    if (!usedSchemas.has(entry.schema.$id)) continue;
    const path = schemaPagePath(entry.schema.$id)!;
    pages.set(path, renderSchemaPage({ ctx: context(path), entry: { ...entry, schemaId: entry.schema.$id }, instances: snapshot.devices.filter(device => device.schemaId === entry.schema.$id).map(device => ({ device })) }));
    schemaLinks.push(`<li><a href="${path}">${escapeHtml(entry.title)}</a></li>`);
  }
  pages.set("/schemas", renderPage({ ctx: context("/schemas"), title: "Schemas", nav: "schemas", body: `<h1>Schemas</h1><ul>${schemaLinks.join("")}</ul>` }));
  return pages;
}

export async function exportDemo(options: ExportDemoOptions): Promise<DemoExportResult> {
  const snapshot = options.showcase ? createFallingwaterSnapshot({ ...(options.basePath ? { basePath: options.basePath } : {}) }) : createDemoSnapshot(options.config, { ...(options.basePath ? { basePath: options.basePath } : {}), ...(options.includeNames === undefined ? {} : { includeNames: options.includeNames }) });
  const pages = await renderDemoPages(snapshot);
  const output = resolve(options.output), base = snapshot.basePath;
  const route = (path: string) => {
    const split = path.search(/[?#]/);
    const pathname = split < 0 ? path : path.slice(0, split), suffix = split < 0 ? "" : path.slice(split);
    return pathname === "/" && snapshot.homePath ? `${snapshot.homePath}${suffix}` : `${base}${pathname === "/" ? "" : `${pathname}.html`}${suffix}`;
  };
  const files: string[] = [];
  const write = async (path: string, content: string | Uint8Array) => { const target = resolve(output, path.replace(/^\//, "")); await mkdir(dirname(target), { recursive: true }); await writeFile(target, content); files.push(path); };
  const artworkNames = new Set([...pages.values()].flatMap(html => [...html.matchAll(/src="\/ui\/assets\/([a-z0-9-]+\.png)"/g)].map(match => match[1]!)));
  for (const name of artworkNames) {
    const artwork = Bun.file(resolve(import.meta.dir, "../ui/assets", name));
    if (!await artwork.exists()) throw new Error(`Referenced pixel artwork is missing: ${name}`);
    await write(`${base}/assets/${name}`, new Uint8Array(await artwork.arrayBuffer()));
  }
  const modulePaths = new Map<string, string>();
  for (const html of pages.values()) for (const match of html.matchAll(/<script\b[^>]*type="module"[^>]*src="(\/ui\/demo\/([^"]+))"[^>]*><\/script>/g)) modulePaths.set(match[1]!, match[2]!);
  for (const [url, source] of modulePaths) {
    const result = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../ui", source)], target: "browser", format: "esm", minify: true });
    if (!result.success) throw new Error(`Demo browser module failed: ${result.logs.join("; ")}`);
    const code = await result.outputs[0]!.text();
    const digest = createHash("sha256").update(code).digest("hex").slice(0, 12);
    const target = `${base}/assets/${source.replace(/\.ts$/, "").replaceAll("/", "-")}-${digest}.js`;
    modulePaths.set(url, target); await write(target, code);
  }
  const runtime = await Bun.build({ entrypoints: [resolve(import.meta.dir, "browser.ts")], target: "browser", format: "iife", minify: true });
  if (!runtime.success) throw new Error(`Demo runtime failed: ${runtime.logs.join("; ")}`);
  await write(`${base}/assets/demo.js`, await runtime.outputs[0]!.text());
  snapshot.devices = snapshot.devices.map(device => ({ ...device, page: route(device.page) }));
  if (snapshot.graph) snapshot.graph = { ...snapshot.graph, nodes: snapshot.graph.nodes.map(node => ({ ...node, page: route(node.page) })) };
  if (snapshot.graphScene) snapshot.graphScene = { ...snapshot.graphScene, nodes: snapshot.graphScene.nodes.map(placed => ({ ...placed, node: { ...placed.node, page: route(placed.node.page) } })) };
  const data = JSON.stringify(snapshot).replaceAll("<", "\\u003c");
  for (const [path, source] of pages) {
    let html = source.replace(/<nav class="site-nav"[\s\S]*?<\/nav>/, navigation => navigation.replace(/<a href="([^"]+)"[^>]*>[\s\S]*?<\/a>/g, (link, href: string) => pages.has(href) ? link : ""));
    html = html.replace(/src="\/ui\/assets\/([a-z0-9-]+\.png)"/g, (_whole, name: string) => `src="${base}/assets/${name}"`);
    html = html.replace(/(<script\b[^>]*\bid="ht-overview-data"[^>]*>)([\s\S]*?)(<\/script>)/, (_whole, start: string, json: string, end: string) => {
      const data = JSON.parse(json) as { devices: { page: string }[] };
      data.devices = data.devices.map(device => ({ ...device, page: route(device.page) }));
      return start + JSON.stringify(data).replaceAll("<", "\\u003c") + end;
    });
    html = html.replace(/<span class="site-nav-label">[^<]*<\/span>(?=\s*<\/nav>)/g, "");
    html = html.replace(/<a\b([^>]*?)href="(\/[^"?#]*)([^"]*)"([^>]*)>([\s\S]*?)<\/a>/g, (_whole, before: string, href: string, suffix: string, after: string, body: string) => pages.has(href) ? `<a${before}href="${route(href)}${suffix}"${after}>${body}</a>` : `<span>${body}</span>`);
    html = html.replace(/<form data-device-rename\b[\s\S]*?<\/form>/g, '<p class="note">Device names are fixed in this static export.</p>')
      .replace(/<form\b[^>]*data-preferences\b[^>]*>[\s\S]*?<\/form>/g, '<p class="small">Static demo · Wright · English</p>')
      .replace(/<button\b[^>]*data-network-(?:reconnect|rescan)\b[^>]*>[\s\S]*?<\/button>/g, "")
      .replace(/(<input\b[^>]*data-device-enabled\b[^>]*)(>)/g, "$1 disabled$2");
    html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, script => script.includes("data-runtime-connection") ? "" : script);
    if (path === "/graph") {
      html = html.replace(/<nav class="graph-tabs"[\s\S]*?<\/nav>/g, "")
        .replace(/<div class="graph-inspector-actions">[\s\S]*?<\/div>/g, "")
        .replace(/<a class="graph-more"[^>]*>[\s\S]*?<\/a>/g, "")
        .replace(/<form class="graph-controls"[\s\S]*?<\/form>/g, '<div class="graph-controls"><label class="graph-search">Find a device<input type="search" id="graph-search" placeholder="Search this demo"></label><output data-demo-graph-count role="status"></output></div>')
        .replace("</body>", `<script>(()=>{const input=document.getElementById('graph-search');const cards=[...document.querySelectorAll('.graph-card')];input.addEventListener('input',()=>{const query=input.value.trim().toLocaleLowerCase();let count=0;for(const card of cards){const show=card.textContent.toLocaleLowerCase().includes(query);card.hidden=!show;card.style.display=show?'':'none';if(show)count++;}for(const room of document.querySelectorAll('.graph-room'))room.hidden=![...room.querySelectorAll('.graph-card')].some(card=>!card.hidden);document.querySelector('[data-demo-graph-count]').textContent=count+' devices';});document.addEventListener('DOMContentLoaded',()=>{const selected=new URL(location.href).searchParams.get('selected');const target=cards.find(card=>card.dataset.graphSelect===selected);if(target)target.click();});})();</script></body>`);
    }
    for (const [url, target] of modulePaths) html = html.replaceAll(`src="${url}"`, `src="${target}"`);
    html = html.replace('<meta charset="utf-8">', '<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\' \'unsafe-inline\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data: blob:; font-src \'self\' data:; media-src data: blob:; connect-src \'none\'; form-action \'none\'; base-uri \'none\'; object-src \'none\'">');
    html = html.replace("</head>", `<script type="application/json" id="ht-demo">${data}</script><script src="${base}/assets/demo.js"></script></head>`);
    if (path !== "/") html = html.replace(/<main([^>]*)>/, `<main$1><aside class="note ht-demo-banner" data-demo-banner><span><strong>Interactive demo</strong> · Simulated devices. Changes stay in this browser.</span><button type="button" class="btn btn-small" data-demo-reset>Reset demo</button><span role="status" data-demo-status></span></aside>`);
    html = html.replace("This HomeTruth instance has no writable device configuration.", "");
    await write(`${base}${path === "/" ? "/index.html" : `${path}.html`}`, html);
  }
  return { output, snapshot, pages: pages.size, files };
}
