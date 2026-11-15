import type { RegisteredDevice } from "../site";
import type { DeviceGroup } from "../schemas";
import type { ScenePresentation } from "./scene-model";
import { deviceNode } from "../state/protocol";
import { escapeHtml as e, renderPage, type PageContext } from "./shell";

export interface OverviewOptions {
  ctx: PageContext;
  devices: readonly RegisteredDevice[];
  deviceGroups?: readonly DeviceGroup[];
  showcase?: boolean;
  presentation?: ScenePresentation;
}

const paths: Record<string, string> = {
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
  light: '<path d="M9 18h6m-5 3h4M8 13a6 6 0 1 1 8 0l-1 2H9z"/>',
  water: '<path d="M12 2S5 10 5 14a7 7 0 0 0 14 0c0-4-7-12-7-12Z M8 15a4 4 0 0 0 4 4"/>',
  gate: '<path d="M3 4v17M21 4v17M3 8h18M3 18h18M7 8v10m5-10v10m5-10v10"/>',
  garage: '<path d="m2 9 10-7 10 7M5 21V9h14v12M5 13h14M5 17h14"/>',
  fan: '<circle cx="12" cy="12" r="2"/><path d="M12 10C4 9 6 2 11 3c3 1 2 5 1 7Zm2 3c5-6 10 0 6 3-3 2-5-1-6-3Zm-3 1c3 7-4 10-6 5-1-3 3-4 6-5Z"/>',
  blinds: '<path d="M3 4h18M4 8h16M4 12h16M4 16h16M4 20h16M21 4v17"/>',
  tv: '<rect x="2" y="4" width="20" height="14" rx="2"/><path d="M8 22h8m-4-4v4"/>',
  air: '<path d="M3 8h12a3 3 0 1 0-3-3M2 12h17a3 3 0 1 1-3 3M3 17h6a3 3 0 1 1-3 3"/>',
  speaker: '<rect x="5" y="2" width="14" height="20" rx="3"/><circle cx="12" cy="15" r="4"/><circle cx="12" cy="6" r="1"/>',
  record: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/><path d="M5 12a7 7 0 0 1 7-7"/>',
  vacuum: '<circle cx="12" cy="13" r="9"/><path d="M5 19h14M9 7h6m-3 4v3"/>',
  dock: '<path d="M3 4v17h18V4M7 17h10l-1-6H8zM10 7h4"/>',
  camera: '<rect x="2" y="6" width="15" height="13" rx="3"/><path d="m17 10 5-3v11l-5-3"/>',
  sensor: '<circle cx="12" cy="12" r="2"/><path d="M7 7a7 7 0 0 0 0 10m10-10a7 7 0 0 1 0 10M4 4a12 12 0 0 0 0 16M20 4a12 12 0 0 1 0 16"/>',
  coffee: '<path d="M4 8h12v8a5 5 0 0 1-10 0V8m10 1h2a3 3 0 0 1 0 6h-2M3 22h16M7 2v3m5-3v3"/>',
  kettle: '<path d="M7 8h10l3 12H4L7 8Zm1 0V5a4 4 0 0 1 8 0v3M4 12H1l3 6m14-8h3v7h-2"/>',
  cooktop: '<rect x="2" y="2" width="20" height="20" rx="3"/><circle cx="8" cy="8" r="3"/><circle cx="17" cy="9" r="2"/><circle cx="15" cy="17" r="3"/>',
  pet: '<path d="M6 15c2-5 10-5 12 0 3 5-2 7-6 4-4 3-9 1-6-4Z"/><ellipse cx="4" cy="9" rx="2" ry="3"/><ellipse cx="9" cy="5" rx="2" ry="3"/><ellipse cx="15" cy="5" rx="2" ry="3"/><ellipse cx="20" cy="9" rx="2" ry="3"/>',
  switch: '<path d="M12 2v10M6 5a9 9 0 1 0 12 0"/>',
};
const icon = (name: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.switch}</svg>`;

export function renderOverviewPage({ ctx, devices, showcase = false, presentation }: OverviewOptions): string {
  const visible = devices.filter(device => !device.parent && device.enabled);
  const nodes = visible.map(device => deviceNode(device.id));
  const data = visible.map(device => ({ id: device.id, name: device.name, page: device.page, capabilities: device.capabilities, ...presentation?.devices[device.id] }));
  const cards = (scene?: string) => data.filter(device => !scene || device.scene === scene || (!device.scene && scene === "room")).map(device => {
    const controllable = device.capabilities.some(kind => ["light", "stringLight", "binarySwitch", "television", "speaker", "button", "treatDispenser", "cooktop"].includes(kind));
    const inside = `${icon(device.icon ?? (device.capabilities.includes("light") ? "light" : "sensor"))}<span class="vh-value" data-device-reading="${e(device.id)}">—</span><span class="vh-name">${e(device.name)}</span>`;
    return `<article class="vh-card" data-device-card="${e(device.id)}">${controllable ? `<button type="button" class="vh-control" data-device-control="${e(device.id)}" aria-label="${e(device.name)}" disabled>${inside}</button>` : `<a class="vh-control" href="${e(device.page)}">${inside}</a>`}<a class="vh-details" href="${e(device.page)}" aria-label="${e(device.name)} details">${icon("info")}</a></article>`;
  }).join("");
  const scene = (name: "house" | "room") => `<section class="vh-scene" aria-label="${name === "house" ? "House and grounds" : "Great room"}"><div class="vh-art"><img class="vh-fallback" src="/ui/assets/${name === "house" ? "island-estate" : "connected-room"}.png" width="${name === "house" ? 384 : 256}" height="${name === "house" ? 256 : 192}" alt="${name === "house" ? "Front view of a sprawling Hawaiian house with three levels, palms, solar panels, garage, waterfall and pool" : "Large tropical living room and kitchen with television, speakers, ceiling fan, lighting, robot vacuum and connected appliances"}"${name === "room" ? ' loading="lazy"' : ' fetchpriority="high"'}>${name === "house" ? '<canvas width="384" height="256" data-house-canvas role="img" aria-label="Hawaiian house with a working waterfall and driveway gate" hidden></canvas>' : ""}</div><div class="vh-controls">${cards(name)}</div></section>`;
  return renderPage({ ctx, title: "", nav: "overview", immersive: true, wide: true, nodes, modules: ["browser/overview.ts"], mainAttributes: 'class="vh-home" data-visual-home', css: OVERVIEW_CSS,
    body: `${showcase ? scene("house") + scene("room") : `<div class="vh-controls">${cards()}</div>`}<nav class="vh-nav" aria-label="Home navigation"><a href="/devices">Devices</a><a href="/graph">Graph</a><a href="/schemas">Schemas</a>${showcase ? '<span data-demo-banner><button type="button" data-demo-reset>Reset</button><span class="sr-only" role="status" data-demo-status></span></span>' : ""}</nav><p class="sr-only" role="status" data-control-feedback></p>${showcase ? '<div hidden data-scene-assets><img src="/ui/assets/waterfall-flow.png" alt=""><img src="/ui/assets/waterfall-dry.png" alt=""><img src="/ui/assets/gate-closed.png" alt=""></div>' : ""}<script type="application/json" id="ht-overview-data" nonce="${e(ctx.nonce)}">${JSON.stringify({ devices: data }).replaceAll("<", "\\u003c")}</script>` });
}

const OVERVIEW_CSS = String.raw`
body.visual-home{margin:0;background:#172e2c;color:#f6eedc}body.visual-home>main.vh-home{max-width:1536px;width:100%;margin:0 auto;padding:0;min-height:100vh}.vh-home [hidden]{display:none!important}.vh-scene{margin:0;padding:0}.vh-art{position:relative;line-height:0;background:#172e2c}.vh-art>img,.vh-art>canvas{display:block;width:100%;height:auto;image-rendering:pixelated;max-height:none;margin:0;border:0}.vh-controls{display:grid;grid-template-columns:repeat(auto-fit,minmax(126px,1fr));gap:10px;padding:22px 28px 36px;background:#17342f}.vh-card{position:relative;min-width:0;border:0;border-radius:19px;background:#28473f;color:#f8f0dd;overflow:hidden;transition:background .18s,color .18s}.vh-control{display:grid;grid-template-columns:1fr auto;grid-template-rows:30px auto auto;align-content:start;gap:5px;width:100%;min-height:116px;padding:15px 14px 13px;border:0;border-radius:inherit;background:transparent;color:inherit;text-align:left;text-decoration:none;font:inherit;cursor:pointer}.vh-control>svg{width:26px;height:26px;grid-row:1;color:#c5d8b1}.vh-value{grid-row:2;grid-column:1/-1;font-size:12px;line-height:1.3;color:#ced9cd;white-space:pre-line;min-height:16px}.vh-name{grid-row:3;grid-column:1/-1;font-size:13px;font-weight:600;line-height:1.3;max-width:100%;overflow-wrap:break-word}.vh-card[data-on=true]{background:#f3ddaa;color:#213d34}.vh-card[data-on=true] .vh-value{color:#596448}.vh-card[data-on=true] .vh-control>svg{color:#916637}.vh-card[data-on=true] .vh-details{color:#5c7254}.vh-card[data-busy=true]{opacity:.65}.visual-home .vh-control,.visual-home .vh-control:hover{color:inherit}.visual-home .vh-details{color:#b4c5b6}.visual-home .vh-value[data-live]{color:#ced9cd}.visual-home .vh-card[data-on=true] .vh-value[data-live]{color:#596448}.vh-control:disabled{cursor:wait}.vh-control:hover{background:#ffffff08;color:inherit}.vh-control:focus-visible,.vh-details:focus-visible,.vh-nav a:focus-visible,.vh-nav button:focus-visible{outline:3px solid #f2ba67;outline-offset:-3px}.vh-details{position:absolute;right:9px;top:11px;display:grid;place-items:center;width:28px;height:28px;color:#b4c5b6;border-radius:50%;text-decoration:none}.vh-details>svg{width:15px;height:15px}.vh-details:hover{background:#ffffff18;color:inherit}.vh-nav{display:flex;justify-content:center;gap:26px;align-items:center;padding:10px 20px 35px;background:#17342f;font-size:12px}.vh-nav a,.vh-nav button{color:#ccdbc6;text-decoration:none;border:0;background:none;padding:10px 4px;font:inherit;cursor:pointer}.vh-nav a:hover,.vh-nav button:hover{color:#fff1cb}.visual-home .ht-demo-banner{display:none}.vh-home p.sr-only{margin:0}.vh-home .vh-control[aria-busy=true] svg{opacity:.5}@media(min-width:1100px){.vh-controls{grid-template-columns:repeat(7,minmax(0,1fr));gap:12px;padding:26px 36px 42px}.vh-control{min-height:124px;padding:17px}}@media(max-width:550px){.vh-controls{grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;padding:14px 12px 24px}.vh-control{min-height:110px;padding:12px 10px}.vh-name{font-size:11px}.vh-value{font-size:11px}.vh-details{right:5px;top:8px;width:25px}.vh-nav{gap:20px}.vh-art{overflow:hidden}.vh-art>img,.vh-art>canvas{width:140%;max-width:none;margin-left:-20%}}@media(prefers-reduced-motion:reduce){.vh-card{transition:none}}
`;
