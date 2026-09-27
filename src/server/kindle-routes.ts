import { Hono } from "hono";
import type { StateHub } from "../state/hub";
import { CAPABILITY_KINDS } from "../models/capability";
import type { Site } from "../site";
import { KindleConfigError, parseKindleConfig } from "../kindle/config";
import { buildKindleSnapshot, KINDLE_ADAPTERS } from "../kindle/presentation";
import { kindleElements } from "../kindle/elements";
import { renderKindleBoard, renderKindlePage } from "../ui/kindle-page";
import { renderKindleSettingsPage } from "../ui/kindle-settings-page";
import { canvasDraft } from "../kindle/canvas";
import { kindleRasterImage, rasterizeCanvas } from "../kindle/raster";
import { rasterLayoutCss, renderRasterCanvas } from "../ui/kindle-raster";
import { renderKindleDesigner } from "../ui/kindle-designer";
import { errorJson, pageContext, type AppEnvironment } from "./http";

export function kindleRoutes(site: Site, hub: StateHub) {
  const store = hub.data.kindle;
  const state = { record: (id: string) => hub.data.record(id), group: (id: string) => hub.data.group(id) };
  const app = new Hono<AppEnvironment>();
  const catalog = () => ({
    elements: kindleElements(site),
    devices: site.list().map(({ id, name, room, model, modelTitle, capabilities }) => ({ id, name, room, model, modelTitle, capabilities })),
    capabilities: CAPABILITY_KINDS.map((kind) => ({ kind, controls: KINDLE_ADAPTERS[kind]?.controls.map((action) => action.control) ?? [] })),
  });
  app.get("/api/kindle/catalog", (context) => context.json(catalog()));
  app.get("/api/kindle/config", async (context) => context.json(hub.data.kindleSettings()));
  app.get("/api/kindle/images/:image", (context) => {
    const name = context.req.param("image");
    const png = /^[a-f0-9]{64}\.png$/.test(name) ? kindleRasterImage(name.slice(0, -4)) : undefined;
    if (!png) return context.notFound();
    return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=86400, immutable" } });
  });
  app.post("/api/kindle/preview", async (context) => {
    try {
      const text = await context.req.text();
      if (text.length > 131072) return errorJson(context, 413, "invalid_request", "Kindle configuration is too large");
      const config = parseKindleConfig(JSON.parse(text));
      if (!config.canvas) return errorJson(context, 400, "invalid_request", "A canvas is required");
      const ctx = pageContext(context);
      const snapshot = buildKindleSnapshot(site, config, state, ctx.i18n);
      const frame = await rasterizeCanvas(config.canvas, snapshot, ctx);
      return context.json({ html: renderRasterCanvas(config.canvas, frame), css: rasterLayoutCss(config.canvas, frame), frame, generatedAt: snapshot.generatedAt });
    } catch (error) {
      if (error instanceof KindleConfigError || error instanceof SyntaxError) return errorJson(context, 400, "invalid_request", "Invalid canvas configuration");
      throw error;
    }
  });
  app.get("/kindle/designer", (context) => {
    const settings = hub.data.kindleSettings();
    const config = canvasDraft(settings.config, site.list());
    const ctx = pageContext(context);
    const snapshot = buildKindleSnapshot(site, config, state, ctx.i18n);
    return context.html(renderKindleDesigner({ ctx, settings: { ...settings, config }, elements: kindleElements(site), snapshot, savedCanvas: Boolean(settings.config.canvas) }));
  });
  app.put("/api/kindle/config", async (context) => {
    if (Number(context.req.header("content-length")) > 131072) return errorJson(context, 413, "invalid_request", "Kindle configuration is too large");
    try {
      const text = await context.req.text();
      if (text.length > 131072) return errorJson(context, 413, "invalid_request", "Kindle configuration is too large");
      const body = JSON.parse(text) as { config?: unknown; revision?: unknown };
      if (!body || typeof body.revision !== "string" || Object.keys(body).some((key) => key !== "config" && key !== "revision")) return errorJson(context, 400, "invalid_request", "Provide configuration and revision");
      return context.json(await store.save(parseKindleConfig(body.config), body.revision));
    } catch (error) {
      if (error instanceof KindleConfigError) return errorJson(context, error.code === "conflict" ? 409 : 400, `kindle_${error.code}`, error.message);
      if (error instanceof SyntaxError) return errorJson(context, 400, "invalid_request", "Invalid JSON");
      throw error;
    }
  });
  app.get("/api/kindle/snapshot", async (context) => {
    const { config } = hub.data.kindleSettings();
    return context.json(buildKindleSnapshot(site, config, state, pageContext(context).i18n));
  });
  app.get("/kindle/settings", async (context) => context.html(renderKindleSettingsPage({ ctx: pageContext(context), settings: hub.data.kindleSettings(), elements: kindleElements(site) })));
  app.get("/kindle", async (context) => {
    const { config } = hub.data.kindleSettings();
    const ctx = pageContext(context);
    const options = {
      ctx, config, snapshot: buildKindleSnapshot(site, config, state, ctx.i18n),
      room: context.req.query("room") ?? "", page: context.req.query("page") ?? "1",
      preview: context.req.query("preview") === "1",
    };
    context.header("Cache-Control", "no-store");
    context.header("X-HomeTruth-Kindle", "1");
    return context.html(context.req.query("fragment") === "1" ? renderKindleBoard(options) : renderKindlePage(options));
  });
  return app;
}
