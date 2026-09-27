import type { KindleConfig } from "../kindle/config";
import type { KindleSnapshot } from "../kindle/presentation";
import { renderPrimitive } from "./kindle-widget";
import { CANVAS_CSS, canvasLayoutCss, renderCanvas } from "./kindle-canvas";
import { KINDLE_CLIENT } from "./kindle-client";
import type { KindleRaster } from "../kindle/raster";
import { RASTER_CSS, rasterLayoutCss, renderRasterCanvas } from "./kindle-raster";
import { escapeHtml as e, type PageContext } from "./shell";

export interface KindlePageOptions {
  ctx: PageContext;
  config: KindleConfig;
  snapshot: KindleSnapshot;
  room?: string;
  page?: string;
  preview?: boolean;
  frame?: KindleRaster | undefined;
}


export function renderKindleBoard({ ctx, config, snapshot, frame, room = "", page = "1", preview = false }: KindlePageOptions): string {
  const { t, dateTime } = ctx.i18n;
  if (config.canvas) return `<div id="kindle-settings" data-refresh="${config.refreshSeconds}" data-font="${config.fontSize}" data-layout="canvas"><div id="canvas-viewport">${frame ? renderRasterCanvas(config.canvas, frame) : renderCanvas(config.canvas, snapshot, ctx)}</div></div>`;
  const rooms = [...new Set(snapshot.rows.flatMap((row) => row.room ? [row.room] : []))].sort();
  const selected = rooms.includes(room) ? room : "";
  const rows = snapshot.rows.filter((row) => !selected || row.room === selected);
  const pages = Math.max(1, Math.ceil(rows.length / config.rowsPerPage));
  const parsed = Number(page);
  const current = Math.min(pages, Math.max(1, Number.isSafeInteger(parsed) ? parsed : 1));
  const href = (index: number) => e(`/kindle?room=${encodeURIComponent(selected)}&page=${index}${preview ? "&preview=1" : ""}`);
  const rendered = rows.slice((current - 1) * config.rowsPerPage, current * config.rowsPerPage).map((row) => `<tr data-device-id="${e(row.deviceId)}"><td><strong>${e(row.label)}</strong><small>${e(row.room || row.model)} · ${e(t(`status.${row.availability}`))}</small></td><td>${row.missing ? e(t("kindle.missing")) : row.primitives.map((item) => renderPrimitive(row, item)).join("") || e(t(`status.${row.availability}`))}</td></tr>`).join("");
  return `<div id="kindle-settings" data-refresh="${config.refreshSeconds}" data-font="${config.fontSize}" data-layout="list">
    <div class="masthead"><h1>${e(config.title)}</h1>${preview ? `<p>${e(t("kindle.previewReadonly"))}</p>` : ""}</div>
    <p class="updated">${e(t("kindle.updated", { time: dateTime(snapshot.generatedAt) }))}</p>
    <p class="summary">${e(t("kindle.itemsOnline", { online: rows.filter((row) => row.availability === "online").length, total: rows.length }))}</p>
    ${rooms.length ? `<form action="/kindle" method="get">${preview ? '<input type="hidden" name="preview" value="1">' : ""}<label for="room">${e(t("kindle.room"))}</label> <select id="room" name="room"><option value="">${e(t("kindle.allRooms"))}</option>${rooms.map((value) => `<option value="${e(value)}"${value === selected ? " selected" : ""}>${e(value)}</option>`).join("")}</select> <button type="submit">${e(t("kindle.show"))}</button></form>` : ""}
    <table aria-label="${e(t("kindle.title"))}"><tbody>${rendered || `<tr><td>${e(t("kindle.empty"))}</td></tr>`}</tbody></table>
    <div class="pager">${current > 1 ? `<a href="${href(current - 1)}">${e(t("kindle.previous"))}</a>` : ""} <span>${e(t("kindle.page", { page: current, total: pages }))}</span> ${current < pages ? `<a href="${href(current + 1)}">${e(t("kindle.next"))}</a>` : ""}</div>
    <p class="note">${e(t("kindle.refreshInterval", { seconds: config.refreshSeconds }))}</p></div>`;
}

const CSS = `
  *{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff;color:#000}
  body{font-family:Georgia,"Times New Roman",serif;line-height:1.3;padding:18px;max-width:900px;margin:auto}
  h1{font-size:1.7em;line-height:1.1;margin:0;word-wrap:break-word}
  .masthead{border-top:8px solid #000;border-bottom:3px solid #000;padding:10px 0 8px}.masthead p{margin:4px 0 0}
  .updated,.note{font:16px/1.3 Arial,sans-serif;margin:8px 0}.summary{margin:8px 0}form{margin:8px 0}
  select,button,a{font:inherit;color:#000;background:#fff}select,button{border:2px solid #000;padding:8px;max-width:100%}
  button{cursor:pointer;min-height:44px}button[aria-pressed="true"]{background:#000;color:#fff}button:disabled{border-style:dotted;color:#555;cursor:default}
  button:focus,a:focus,select:focus{outline:3px solid #000;outline-offset:2px}
  table{width:100%;border-collapse:collapse;table-layout:fixed}td{border-top:2px solid #000;padding:12px 4px;vertical-align:middle;word-wrap:break-word}
  td:first-child{width:44%}td:last-child{text-align:right}strong{font-size:1.05em;font-weight:normal}
  small{display:block;font:15px/1.3 Arial,sans-serif;margin-top:5px}.primitive+.primitive{border-top:1px dashed #000;margin-top:8px;padding-top:8px}
  .actions{margin-top:8px}.actions button{min-width:64px}.pager{border-top:3px solid #000;padding:10px 0;text-align:center}
  .power-controls .actions{margin-top:6px}.power-controls .actions:first-child{margin-top:0}.power-controls button{font-size:.85em;padding:3px 8px;min-height:32px;min-width:44px;border-width:1px}
  .pager a{display:inline-block;padding:8px 12px;border:2px solid #000;text-decoration:none}
  #stale{display:none;border:3px solid #000;padding:10px;font-weight:bold}#feedback:empty{display:none}#feedback{border:2px solid #000;padding:8px}
  #refresh{margin-top:4px}@media(max-width:500px){body{padding:12px}h1{font-size:1.4em}td{padding:10px 2px}small{font-size:13px}}
  html{-webkit-text-size-adjust:none;text-size-adjust:none}body[data-layout="canvas"]{padding:0;max-width:none;overflow:hidden}
  body[data-layout="canvas"] #canvas-viewport{margin:0 auto;overflow:hidden}
  body[data-layout="canvas"] #kindle-toolbar{position:fixed;left:0;right:0;bottom:0;height:36px;padding:2px 4px;background:#fff;z-index:1000}
  body[data-layout="canvas"] #refresh{font:16px/1.2 Arial,sans-serif;min-height:30px;margin:0;padding:3px 8px;border-width:1px}
  body[data-layout="canvas"] #stale,body[data-layout="canvas"] #feedback{position:fixed;left:0;right:0;top:0;background:#fff;z-index:1001;margin:0;font:16px/1.3 Arial,sans-serif}
`;

export function renderKindlePage(options: KindlePageOptions): string {
  const { ctx, config, preview = false } = options;
  const { t } = ctx.i18n;
  const messages = { working: t("kindle.working"), sent: t("kindle.sent"), failed: t("kindle.commandFailed") };
  return `<!doctype html><html lang="${e(ctx.i18n.locale)}" dir="${e(ctx.i18n.dir)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${e(config.title)} · ${e(t("kindle.title"))}</title>
    <style nonce="${e(ctx.nonce)}">${CSS}${CANVAS_CSS}${RASTER_CSS}${config.canvas ? options.frame ? rasterLayoutCss(config.canvas, options.frame) : canvasLayoutCss(config.canvas) : ""}body{font-size:${config.fontSize}px}</style></head>
    <body data-layout="${config.canvas ? "canvas" : "list"}" data-preview="${preview ? "1" : "0"}" data-messages="${e(JSON.stringify(messages))}"><div id="stale" role="status">${e(t("kindle.stale"))}</div><p id="feedback" role="status" aria-live="polite"></p><main id="board">${renderKindleBoard(options)}</main>
    <div id="kindle-toolbar"><button id="refresh" type="button" disabled>${e(t("action.refresh"))}</button></div><noscript><p>${e(t("kindle.javascript"))}</p></noscript>
    <script nonce="${e(ctx.nonce)}">${KINDLE_CLIENT}</script></body></html>`;
}
