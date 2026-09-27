import type { CanvasLayout } from "../kindle/config";
import type { KindleRaster } from "../kindle/raster";
import { escapeHtml as e } from "./shell";

export const RASTER_CSS = `
.ht-raster,.ht-raster *{box-sizing:border-box;-webkit-text-size-adjust:none;text-size-adjust:none}
.ht-raster{position:relative;overflow:hidden;background:#fff;color:#000;padding:0;margin:0;line-height:1}
.ht-raster .raster-image{position:absolute;left:0;top:0;width:100%;height:100%;max-width:none;border:0;margin:0;padding:0;display:block}
.ht-raster .raster-widget{position:absolute;overflow:hidden;background:transparent;border:0;margin:0;padding:0}
.ht-raster .raster-description{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}
.ht-raster button.raster-control{position:absolute;display:block;background:transparent!important;color:transparent!important;border:0!important;border-radius:0;padding:0!important;margin:0!important;min-width:0!important;min-height:0!important;max-width:none;font:0/0 sans-serif;box-shadow:none;cursor:pointer;-webkit-appearance:none;appearance:none}
.ht-raster button.raster-control:focus{outline:2px solid #000;outline-offset:-2px}.ht-raster button.raster-control:disabled{cursor:default}
`;

export function rasterLayoutCss(canvas: CanvasLayout, frame: KindleRaster): string {
  return `#kindle-canvas{width:${canvas.width}px;height:${canvas.height}px}` + canvas.widgets.map((w, index) =>
    `#canvas-widget-${w.id}{left:${w.x}px;top:${w.y}px;width:${w.width}px;height:${w.height}px;z-index:${index + 1}}` + (frame.widgets.find(value => value.id === w.id)?.controls ?? []).map((c, i) =>
      `#raster-control-${w.id}-${i}{left:${c.x}px;top:${c.y}px;width:${c.width}px;height:${c.height}px}`).join("")
  ).join("");
}

/** The PNG and hit regions come from one render, so text cannot reflow on the Kindle. */
export function renderRasterCanvas(canvas: CanvasLayout, frame: KindleRaster): string {
  return `<div id="kindle-canvas" class="ht-raster" data-raster="1" data-width="${canvas.width}" data-height="${canvas.height}"><img class="raster-image" src="${e(frame.imageUrl)}" width="${canvas.width}" height="${canvas.height}" alt="">${canvas.widgets.map((w, index) => {
    const widget = frame.widgets.find(value => value.id === w.id);
    return `<div id="canvas-widget-${w.id}" class="raster-widget" data-widget="${w.id}" data-x="${w.x}" data-y="${w.y}" data-width="${w.width}" data-height="${w.height}" data-layer="${index + 1}"><span class="raster-description">${e(widget?.description ?? "")}</span>${(widget?.controls ?? []).map((c, i) => `<button type="button" class="raster-control" id="raster-control-${w.id}-${i}" disabled data-kindle-action="${e(c.url)}" data-result-label="${e(c.resultLabel)}" data-x="${c.x}" data-y="${c.y}" data-width="${c.width}" data-height="${c.height}" aria-label="${e(c.label)}"${c.pressed === null ? "" : ` aria-pressed="${e(c.pressed)}"`}${c.confirmation === null ? "" : ` data-confirmation="${e(c.confirmation)}"`}>${e(c.label)}</button>`).join("")}</div>`;
  }).join("")}</div>`;
}
