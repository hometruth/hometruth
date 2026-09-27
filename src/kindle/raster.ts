import { createHash } from "node:crypto";
import { chromium } from "playwright";
import type { CanvasLayout } from "./config";
import type { KindleSnapshot } from "./presentation";
import { CANVAS_CSS, canvasLayoutCss, renderCanvas } from "../ui/kindle-canvas";
import type { PageContext } from "../ui/shell";

export interface RasterControl {
  x: number; y: number; width: number; height: number;
  url: string; label: string; resultLabel: string;
  pressed: string | null; confirmation: string | null;
}
export interface RasterWidget {
  id: string; description: string; controls: RasterControl[];
}
export interface KindleRaster {
  imageUrl: string; width: number; height: number;
  widgets: RasterWidget[]; overflow: string[];
}
type CachedFrame = { png: Buffer; frame: KindleRaster };
const cache = new Map<string, CachedFrame>();
let queue: Promise<unknown> = Promise.resolve();
let waiting = 0;

export function kindleRasterImage(key: string): Buffer | undefined {
  return cache.get(key)?.png;
}

/** Render only our escaped HTML, with scripts and all network access disabled. */
export async function rasterizeCanvas(canvas: CanvasLayout, snapshot: KindleSnapshot, ctx: PageContext): Promise<KindleRaster> {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>html,body{margin:0;padding:0;overflow:hidden}${CANVAS_CSS}${canvasLayoutCss(canvas)}.ht-canvas button:disabled{border-style:solid;opacity:1}</style></head><body>${renderCanvas(canvas, snapshot, ctx)}</body></html>`;
  const key = createHash("sha256").update(html).digest("hex");
  const cached = cache.get(key);
  if (cached) { cache.delete(key); cache.set(key, cached); return cached.frame; }
  if (waiting >= 8) throw new Error("Kindle image renderer is busy; retry the preview shortly");
  waiting++;
  const result = queue.catch(() => {}).then(async () => {
    const existing = cache.get(key);
    if (existing) return existing.frame;
    // A fresh browser is closed even on failure; no renderer processes survive hot reloads.
    const browser = await chromium.launch({ timeout: 10000 });
    try {
      const page = await browser.newPage({ viewport: { width: canvas.width, height: canvas.height }, deviceScaleFactor: 1, javaScriptEnabled: false, serviceWorkers: "block" });
      page.setDefaultTimeout(10000);
      await page.route("**/*", route => route.abort());
      await page.setContent(html, { waitUntil: "load" });
      const measured = await page.locator(".canvas-widget").evaluateAll(elements => ({
        overflow: elements.filter(el => el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2).map(el => el.getAttribute("data-widget")!),
        widgets: elements.map(el => {
          const rect = el.getBoundingClientRect();
          return {
            id: el.getAttribute("data-widget")!, description: (el as HTMLElement).innerText.trim(),
            controls: Array.from(el.querySelectorAll<HTMLButtonElement>("[data-kindle-action]")).map(button => {
              const b = button.getBoundingClientRect();
              return { x: b.left - rect.left, y: b.top - rect.top, width: b.width, height: b.height,
                url: button.getAttribute("data-kindle-action")!, label: button.textContent ?? "",
                resultLabel: button.getAttribute("data-result-label")!, pressed: button.getAttribute("aria-pressed"), confirmation: button.getAttribute("data-confirmation") };
            }),
          };
        }),
      }));
      const png = await page.screenshot({ type: "png", animations: "disabled", scale: "css" });
      const frame: KindleRaster = { imageUrl: `/api/kindle/images/${key}.png`, width: canvas.width, height: canvas.height, ...measured };
      cache.set(key, { png, frame });
      let bytes = [...cache.values()].reduce((sum, value) => sum + value.png.length, 0);
      while (cache.size > 24 || (bytes > 16 * 1024 * 1024 && cache.size > 1)) {
        const oldest = cache.keys().next().value!;
        bytes -= cache.get(oldest)!.png.length; cache.delete(oldest);
      }
      return frame;
    } finally { await browser.close(); }
  }).finally(() => { waiting--; });
  queue = result;
  return result;
}
