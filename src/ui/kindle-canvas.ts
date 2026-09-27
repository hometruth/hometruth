import type { CanvasLayout } from "../kindle/config";
import type { KindleSnapshot } from "../kindle/presentation";
import { escapeHtml as e, type PageContext } from "./shell";
import { renderPrimitive } from "./kindle-widget";

/** Scoped so the designer and the Kindle use exactly the same widget appearance. */
export const CANVAS_CSS = `
.ht-canvas,.ht-canvas *{box-sizing:border-box}.ht-canvas{position:relative;background:#fff;color:#000;color-scheme:light;scrollbar-color:auto;font:22px/1.3 Georgia,"Times New Roman",serif;letter-spacing:normal;overflow:hidden;transform-origin:top left;-webkit-transform-origin:top left}
.ht-canvas .canvas-widget{position:absolute;overflow:hidden;padding:12px;word-wrap:break-word;color:#000;background:#fff;border:0 solid #000;line-height:1.3}
.ht-canvas .widget-title{font:inherit;font-weight:normal;font-variant:normal;margin:0 0 12px;padding:0;border:0;letter-spacing:normal;text-transform:none;text-wrap:wrap;line-height:1.2}.ht-canvas p{margin:0;max-width:none}.ht-canvas .widget-status{display:block;font:14px/1.3 Arial,sans-serif;margin:4px 0 12px}
.ht-canvas .primitive{margin:0;padding:0}.ht-canvas .primitive+.primitive{margin-top:12px;padding-top:12px;border-top:1px solid #000}
.ht-canvas .reading{font-size:1.25em;line-height:1.2}.ht-canvas small{font:14px/1.3 Arial,sans-serif;display:block;margin-top:6px}
.ht-canvas .actions{margin-top:12px}.ht-canvas button{font:inherit;line-height:1.2;color:#000;background:#fff;border:2px solid #000;border-radius:0;padding:8px 12px;min-height:44px;min-width:64px;max-width:100%;cursor:pointer}
.ht-canvas button[aria-pressed="true"]{background:#000;color:#fff}.ht-canvas button:disabled{cursor:default;border-style:dotted}.ht-canvas button:focus{outline:3px solid #000;outline-offset:2px}
.ht-canvas .power-controls .actions{margin-top:6px}.ht-canvas .power-controls .actions:first-child{margin-top:0}.ht-canvas .power-controls button{font-size:.85em;padding:3px 8px;min-height:32px;min-width:44px;border-width:1px}
.ht-canvas .widget-text{white-space:pre-wrap}.ht-canvas .canvas-widget[data-kind="rule"]{padding:0;background:#000}
.ht-canvas .widget-clock{font-variant-numeric:tabular-nums;line-height:1.2}
`;

export function canvasLayoutCss(canvas: CanvasLayout): string {
  return `#kindle-canvas{width:${canvas.width}px;height:${canvas.height}px}` + canvas.widgets.map((w, index) => `#canvas-widget-${w.id}{left:${w.x}px;top:${w.y}px;width:${w.width}px;height:${w.height}px;font-size:${w.fontSize}px;text-align:${w.align};border-width:${w.border ? 2 : 0}px;z-index:${index + 1}}`).join("");
}

export function renderCanvas(canvas: CanvasLayout, snapshot: KindleSnapshot, ctx: PageContext): string {
  const rows = new Map(snapshot.rows.map((row) => [row.widgetId, row]));
  const widgets = canvas.widgets.map((widget, index) => {
    let body = "";
    if (widget.kind === "text") body = `<div class="widget-text">${e(widget.text)}</div>`;
    if (widget.kind === "clock") body = `<div class="widget-clock">${e(widget.format === "dateTime" ? ctx.i18n.dateTime(snapshot.generatedAt) : new Intl.DateTimeFormat(ctx.i18n.locale, { hour: "numeric", minute: "2-digit" }).format(new Date(snapshot.generatedAt)))}</div>`;
    if (widget.kind === "device") {
      const row = rows.get(widget.id);
      body = `${widget.showLabel ? `<h2 class="widget-title">${e(row?.label ?? (widget.label || widget.deviceId))}</h2>` : ""}`;
      body += !row || row.missing ? `<p>${e(ctx.i18n.t("kindle.missing"))}</p>` : row.primitives.map((primitive) => renderPrimitive(row, primitive)).join("") || `<p>${e(ctx.i18n.t(`status.${row.availability}`))}</p>`;
    }
    return `<div id="canvas-widget-${widget.id}" class="canvas-widget" data-widget="${widget.id}" data-kind="${widget.kind}" data-x="${widget.x}" data-y="${widget.y}" data-width="${widget.width}" data-height="${widget.height}" data-font="${widget.fontSize}" data-align="${widget.align}" data-border="${widget.border ? 2 : 0}" data-layer="${index + 1}">${body}</div>`;
  }).join("");
  return `<div id="kindle-canvas" class="ht-canvas" data-width="${canvas.width}" data-height="${canvas.height}">${widgets}</div>`;
}
