import type { RegisteredDevice } from "../site";
import { escapeHtml, renderPage, type PageContext } from "./shell";

export interface LightSyncPageOptions {
  ctx: PageContext;
  device: RegisteredDevice;
}

/** The same-origin routes used by the light-sync region editor. */
export const LIGHT_SYNC_API = {
  snapshot: "/api/cameras/:id/snapshot",
  region: "/api/cameras/:id/light-sync/region",
} as const;

const LIGHT_SYNC_CSS = String.raw`
  .editor svg { touch-action: none; cursor: crosshair; }
  .editor svg[data-empty="true"] { cursor: default; }
  .editor polygon { fill: color-mix(in srgb, var(--bad) 25%, transparent); stroke: var(--bad); stroke-width: 2; vector-effect: non-scaling-stroke; }
  .editor polyline { fill: none; stroke: var(--bad); stroke-width: 2; stroke-dasharray: 6 4; vector-effect: non-scaling-stroke; }
  .editor circle { fill: var(--bad); stroke: var(--stage-fg); stroke-width: 1.5; vector-effect: non-scaling-stroke; cursor: grab; }
  .editor circle:active { cursor: grabbing; }
`;

const LIGHT_SYNC_SCRIPT = String.raw`
  (() => {
    const root = document.querySelector("[data-light-sync-page]");
    if (!(root instanceof HTMLElement)) return;
    const id = encodeURIComponent(root.dataset.deviceId || "");
    const api = JSON.parse(root.dataset.api || "{}");
    const url = (route) => route.replace(":id", id);
    const image = document.querySelector("#snapshot");
    const placeholder = document.querySelector("#placeholder");
    const svg = document.querySelector("#overlay");
    const feedback = document.querySelector("#feedback");
    const countLabel = document.querySelector("#point-count");
    const buttons = Object.fromEntries(Array.from(document.querySelectorAll("button[data-action]")).map((button) => [button.dataset.action, button]));
    let points = [];
    let dragIndex = -1;

    const setButtonsEnabled = (hasImage) => {
      for (const [action, button] of Object.entries(buttons)) {
        if (!(button instanceof HTMLButtonElement) || action === "reload") continue;
        button.disabled = !hasImage;
      }
    };

    const NS = "http://www.w3.org/2000/svg";
    const render = () => {
      if (!(svg instanceof SVGSVGElement)) return;
      svg.textContent = "";
      svg.dataset.empty = points.length === 0 ? "true" : "false";
      if (countLabel instanceof HTMLElement) {
        countLabel.textContent = points.length === 0 ? ht.t("lightSync.start") : points.length < 3 ? ht.t("lightSync.keepGoing", { count: points.length }) : ht.t("lightSync.points", { count: points.length });
      }
      if (points.length === 0) return;
      const toAttr = (list) => list.map((p) => (p.x * 100) + "," + (p.y * 100)).join(" ");
      const shape = document.createElementNS(NS, points.length >= 3 ? "polygon" : "polyline");
      shape.setAttribute("points", toAttr(points));
      svg.appendChild(shape);
      points.forEach((p, i) => {
        const handle = document.createElementNS(NS, "circle");
        handle.setAttribute("cx", String(p.x * 100));
        handle.setAttribute("cy", String(p.y * 100));
        handle.setAttribute("r", "1.6");
        handle.dataset.index = String(i);
        svg.appendChild(handle);
      });
    };

    const pointFromEvent = (event) => {
      const rect = svg.getBoundingClientRect();
      return { x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)), y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)) };
    };

    const loadSnapshot = () => {
      ht.say(feedback, ht.t("lightSync.loadingSnapshot"));
      setButtonsEnabled(false);
      if (image instanceof HTMLImageElement) image.src = url(api.snapshot) + "?t=" + Date.now();
    };

    const loadRegion = async () => {
      try {
        const payload = await ht.request(url(api.region));
        if (payload && payload.region && Array.isArray(payload.region.points)) {
          points = payload.region.points.map((p) => ({ x: p.x, y: p.y }));
          render();
        }
      } catch { /* No saved region yet; start blank. */ }
    };

    if (image instanceof HTMLImageElement) {
      image.addEventListener("load", () => {
        image.hidden = false;
        if (placeholder instanceof HTMLElement) placeholder.hidden = true;
        ht.say(feedback, "");
        setButtonsEnabled(true);
      });
      image.addEventListener("error", () => {
        ht.say(feedback, ht.t("lightSync.snapshotFailed"), "bad");
        setButtonsEnabled(false);
      });
    }

    if (svg instanceof SVGSVGElement) {
      svg.addEventListener("pointerdown", (event) => {
        const target = event.target;
        if (target instanceof Element && target.tagName === "circle") {
          dragIndex = Number(target.dataset.index);
          event.preventDefault();
          return;
        }
        if (dragIndex !== -1) return;
        points.push(pointFromEvent(event));
        render();
      });
      svg.addEventListener("pointermove", (event) => {
        if (dragIndex === -1) return;
        points[dragIndex] = pointFromEvent(event);
        render();
      });
      const endDrag = () => { dragIndex = -1; };
      svg.addEventListener("pointerup", endDrag);
      svg.addEventListener("pointerleave", endDrag);
    }

    if (buttons.undo instanceof HTMLButtonElement) buttons.undo.addEventListener("click", () => { points.pop(); render(); });
    if (buttons.clear instanceof HTMLButtonElement) buttons.clear.addEventListener("click", () => { points = []; render(); ht.say(feedback, ""); });
    if (buttons.reload instanceof HTMLButtonElement) buttons.reload.addEventListener("click", () => { points = []; render(); loadSnapshot(); });
    if (buttons.save instanceof HTMLButtonElement) {
      buttons.save.addEventListener("click", async () => {
        if (points.length < 3) { ht.say(feedback, ht.t("lightSync.needPoints"), "bad"); return; }
        buttons.save.disabled = true;
        try {
          await ht.request(url(api.region), { method: "PUT", body: JSON.stringify({ points }) });
          ht.say(feedback, ht.t("feedback.saved"), "ok");
        } catch (error) {
          ht.say(feedback, error instanceof Error ? error.message : ht.t("lightSync.saveFailed"), "bad");
        } finally {
          buttons.save.disabled = false;
        }
      });
    }

    render();
    setButtonsEnabled(false);
    loadSnapshot();
    void loadRegion();
  })();
`;

/** The TV-region polygon editor for one camera: a snapshot with a click-to-draw overlay, saved to that camera's light-sync region. */
export function renderLightSyncPage({ ctx, device }: LightSyncPageOptions): string {
  const { t } = ctx.i18n;
  return renderPage({
    ctx,
    title: `${t("lightSync.title")} · ${device.name}`,
    nav: "devices",
    css: LIGHT_SYNC_CSS,
    mainAttributes: `data-light-sync-page data-device-id="${escapeHtml(device.id)}" data-api="${escapeHtml(JSON.stringify(LIGHT_SYNC_API))}"`,
    body: `<div class="page-head"><h1>${escapeHtml(t("lightSync.title"))}</h1><a href="${escapeHtml(device.page)}">${escapeHtml(device.name)}</a></div>
      <p class="note">${escapeHtml(t("lightSync.help"))}</p>
      <div class="stage editor" id="editor">
        <img id="snapshot" alt="${escapeHtml(t("lightSync.snapshotAlt", { name: device.name }))}" hidden>
        <svg id="overlay" viewBox="0 0 100 100" preserveAspectRatio="none" data-empty="true"></svg>
        <span class="placeholder" id="placeholder">${escapeHtml(t("feedback.loading"))}</span>
      </div>
      <div class="bar" role="toolbar" aria-label="${escapeHtml(t("lightSync.title"))}">
        <button type="button" class="btn btn-primary" data-action="save">${escapeHtml(t("action.save"))}</button>
        <button type="button" class="btn" data-action="undo">${escapeHtml(t("action.undo"))}</button>
        <button type="button" class="btn" data-action="clear">${escapeHtml(t("action.clear"))}</button>
        <button type="button" class="btn" data-action="reload">${escapeHtml(t("lightSync.newSnapshot"))}</button>
        <span class="muted small" id="point-count"></span>
      </div>
      <p class="feedback" id="feedback" role="status" aria-live="polite"></p>`,
    script: LIGHT_SYNC_SCRIPT,
    messages: ["lightSync."],
  });
}
