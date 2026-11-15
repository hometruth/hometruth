/** Export the production page templates with an entirely local browser simulation. */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import type { DevicesConfig } from "../schemas";
import { createDemoSnapshot, DEMO_SNAPSHOT_TIME, type DemoSnapshot } from "./model";
import { createPageContext, escapeHtml, htElement, renderDeviceHead, renderPage, type PageContext } from "../ui/shell";
import { createTranslator, type Translator } from "../ui/i18n";
import { renderHomePage, partitionDevicesIntoGroups, groupPagePath } from "../ui/home";
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
import { schemaCatalogEntries, schemaPagePath } from "../schema-catalog";

export interface ExportDemoOptions { config: DevicesConfig; output: string; basePath?: string; includeNames?: boolean; }
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

function demoGraph(snapshot: DemoSnapshot): GraphContents {
  const nodes: GraphNode[] = [{ id: "root", side: "instance", kind: "site", name: "HomeTruth Demo", context: "", page: "/", icon: { kind: "emoji", value: "⌂" }, ids: [] }];
  const edges: GraphEdge[] = [];
  const rooms = new Map<string, string>();
  for (const device of snapshot.devices) {
    const id = elementKey("device", device.id);
    nodes.push({ id, side: "instance", kind: "device", name: device.name, context: device.modelTitle, page: device.page, stateNode: `device/${device.id}`, ids: [device.id], icon: { kind: "emoji", value: device.capabilities.includes("light") ? "💡" : device.capabilities.includes("camera") ? "📷" : "◇" } });
    edges.push({ from: "root", to: id, relation: "contains", origin: "structure" });
    if (device.room) {
      let room = rooms.get(device.room);
      if (!room) { room = elementKey("tag", "room", device.room); rooms.set(device.room, room); nodes.push({ id: room, side: "tag", kind: "tag", name: device.room, context: "room", page: "/devices", ids: ["room", device.room], icon: { kind: "emoji", value: "⌂" } }); }
      edges.push({ from: room, to: id, relation: "tagged", origin: "site" });
    }
  }
  return { nodes, edges, generatedAt: snapshot.records[0]?.updatedAt ?? DEMO_SNAPSHOT_TIME };
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
  const context = (path: string) => createPageContext({ nonce: "demo", siteTitle: "HomeTruth", preferences: { theme: "euclid", scheme: "auto", locale: "en" }, i18n, path, state: { snapshot: nodes => nodes.flatMap(node => records.get(node) ?? []) }, assetVersion: "demo", rooms });
  const pages = new Map<string, string>();
  const home = (path: string) => renderHomePage({ ctx: context(path), devices: snapshot.devices, deviceGroups: snapshot.groups });
  pages.set("/", home("/")); pages.set("/devices", home("/devices"));
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
    pages.set(device.page, devicePage(context(device.page), device, snapshot));
    pages.set(`${device.page}/settings`, renderDeviceSettingsPage({ ctx: context(`${device.page}/settings`), device }));
    pages.set(`${device.page}/log`, renderDeviceLogPage({ ctx: context(`${device.page}/log`), device, types: [] }));
  }
  pages.set("/events", renderEventsPage({ ctx: context("/events"), subjects: snapshot.devices.map(device => ({ id: device.id, name: device.name, page: device.page })), types: [] }));
  snapshot.graph = demoGraph(snapshot);
  snapshot.graphScene = demoGraphScene(snapshot, snapshot.graph);
  pages.set("/graph", renderGraphPage({ ctx: context("/graph"), scene: snapshot.graphScene }));
  const usedSchemas = new Set(snapshot.devices.map(device => device.schemaId));
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
  const snapshot = createDemoSnapshot(options.config, { ...(options.basePath ? { basePath: options.basePath } : {}), ...(options.includeNames === undefined ? {} : { includeNames: options.includeNames }) });
  const pages = await renderDemoPages(snapshot);
  const output = resolve(options.output), base = snapshot.basePath;
  const route = (path: string) => `${base}${path === "/" || path === "/devices" ? "" : `${path}.html`}`;
  const files: string[] = [];
  const write = async (path: string, content: string | Uint8Array) => { const target = resolve(output, path.replace(/^\//, "")); await mkdir(dirname(target), { recursive: true }); await writeFile(target, content); files.push(path); };
  const modulePaths = new Map<string, string>();
  for (const html of pages.values()) for (const match of html.matchAll(/<script\b[^>]*type="module"[^>]*src="(\/ui\/demo\/([^"]+))"[^>]*><\/script>/g)) modulePaths.set(match[1]!, match[2]!);
  for (const [url, source] of modulePaths) {
    const result = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../ui", source)], target: "browser", format: "esm", minify: true });
    if (!result.success) throw new Error(`Demo browser module failed: ${result.logs.join("; ")}`);
    const target = `${base}/assets/${source.replace(/\.ts$/, ".js").replaceAll("/", "-")}`;
    modulePaths.set(url, target); await write(target, await result.outputs[0]!.text());
  }
  const runtime = await Bun.build({ entrypoints: [resolve(import.meta.dir, "browser.ts")], target: "browser", format: "iife", minify: true });
  if (!runtime.success) throw new Error(`Demo runtime failed: ${runtime.logs.join("; ")}`);
  await write(`${base}/assets/demo.js`, await runtime.outputs[0]!.text());
  snapshot.devices = snapshot.devices.map(device => ({ ...device, page: route(device.page) }));
  if (snapshot.graph) snapshot.graph = { ...snapshot.graph, nodes: snapshot.graph.nodes.map(node => ({ ...node, page: route(node.page) })) };
  if (snapshot.graphScene) snapshot.graphScene = { ...snapshot.graphScene, nodes: snapshot.graphScene.nodes.map(placed => ({ ...placed, node: { ...placed.node, page: route(placed.node.page) } })) };
  const data = JSON.stringify(snapshot).replaceAll("<", "\\u003c");
  for (const [path, source] of pages) {
    if (path === "/devices") continue;
    let html = source.replace(/<nav class="site-nav"[\s\S]*?<\/nav>/, navigation => navigation.replace(/<a href="([^"]+)"[^>]*>[\s\S]*?<\/a>/g, (link, href: string) => pages.has(href) ? link : ""));
    html = html.replace(/<a\b([^>]*?)href="(\/[^"?#]*)([^"]*)"([^>]*)>([\s\S]*?)<\/a>/g, (_whole, before: string, href: string, suffix: string, after: string, body: string) => pages.has(href) ? `<a${before}href="${route(href)}${suffix}"${after}>${body}</a>` : `<span>${body}</span>`);
    html = html.replace(/<form data-device-rename\b[\s\S]*?<\/form>/g, '<p class="note">Device names are fixed in this static export.</p>')
      .replace(/<form\b[^>]*data-preferences\b[^>]*>[\s\S]*?<\/form>/g, '<p class="small">Static demo · Euclid · English</p>')
      .replace(/<button\b[^>]*data-network-(?:reconnect|rescan)\b[^>]*>[\s\S]*?<\/button>/g, "")
      .replace(/(<input\b[^>]*data-device-enabled\b[^>]*)(>)/g, "$1 disabled$2");
    html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, script => script.includes("data-runtime-connection") ? "" : script);
    if (path === "/graph") {
      html = html.replace(/<nav class="graph-tabs"[\s\S]*?<\/nav>/g, "")
        .replace(/<div class="graph-inspector-actions">[\s\S]*?<\/div>/g, "")
        .replace(/<a class="graph-more"[^>]*>[\s\S]*?<\/a>/g, "")
        .replace(/<form class="graph-controls"[\s\S]*?<\/form>/g, '<div class="graph-controls"><label class="graph-search">Find a device<input type="search" id="graph-search" placeholder="Search this demo"></label><output data-demo-graph-count role="status"></output></div>')
        .replace("</body>", `<script>(()=>{const input=document.getElementById('graph-search');const cards=[...document.querySelectorAll('.graph-card')];input.addEventListener('input',()=>{const query=input.value.trim().toLocaleLowerCase();let count=0;for(const card of cards){const show=card.textContent.toLocaleLowerCase().includes(query);card.hidden=!show;card.style.display=show?'':'none';if(show)count++;}for(const room of document.querySelectorAll('.graph-room'))room.hidden=![...room.querySelectorAll('.graph-card')].some(card=>!card.hidden);document.querySelector('[data-demo-graph-count]').textContent=count+' devices';});})();</script></body>`);
    }
    for (const [url, target] of modulePaths) html = html.replaceAll(`src="${url}"`, `src="${target}"`);
    html = html.replace('<meta charset="utf-8">', '<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\' \'unsafe-inline\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data: blob:; font-src \'self\' data:; media-src data: blob:; connect-src \'none\'; form-action \'none\'; base-uri \'none\'; object-src \'none\'">');
    html = html.replace("</head>", `<script type="application/json" id="ht-demo">${data}</script><script src="${base}/assets/demo.js"></script></head>`);
    html = html.replace(/<main([^>]*)>/, `<main$1><aside class="note" data-demo-banner style="margin-block:var(--s4) var(--s5)"><strong>Play with HomeTruth</strong><p>Everything here is pretend. Your changes stay in this browser’s cookies.</p><button type="button" class="btn btn-small" data-demo-reset>Reset demo</button><span role="status" data-demo-status></span></aside>`);
    html = html.replace("This HomeTruth instance has no writable device configuration.", "");
    await write(`${base}${path === "/" ? "/index.html" : `${path}.html`}`, html);
  }
  return { output, snapshot, pages: pages.size - 1, files };
}
