import { Hono } from "hono";
import type { Site } from "../site";
import { DogAnnouncer } from "./dog-announcer";
import { renderDogAutomationPage } from "../ui/dog-automation-page";
import { errorJson, pageContext, requestJson, type AppEnvironment } from "../server/http";

export function dogRoutes(automation: DogAnnouncer, site: Site, onChange?: (automation: DogAnnouncer) => void) {
  const app = new Hono<AppEnvironment>();
  app.get("/automations/dog-announcer", c => c.html(renderDogAutomationPage(pageContext(c), site.pages().page("service", automation.id), view())));
  const view = () => ({ ...automation.view(), cameras: site.list().filter(d => d.capabilities.includes("camera")), speakers: site.list().filter(d => d.capabilities.includes("speaker")) });
  app.get("/api/automations/dog-announcer", c => { c.header("Cache-Control", "no-store"); return c.json(view()); });
  app.get("/api/automations/dog-announcer/stream.mjpeg", async c => {
    const cameraId = c.req.query("cameraId") ?? "";
    if (!site.get(cameraId)?.capability("camera")) return errorJson(c, 404, "not_found", "Choose a camera");
    try { return await automation.stream(cameraId, c.req.raw.signal); }
    catch { return errorJson(c, 502, "preview_unavailable", "The camera preview is unavailable. Check its recorder connection."); }
  });
  app.put("/api/automations/dog-announcer", async c => {
    try { await automation.configure(await requestJson(c)); onChange?.(automation); return c.json(view()); }
    catch (e) { return errorJson(c, 400, "invalid_request", e instanceof Error ? e.message : "Could not save automation"); }
  });
  app.put("/api/automations/dog-announcer/enabled", async c => {
    try {
      const input = await requestJson(c) as { enabled?: unknown } | null;
      await automation.setEnabled(input?.enabled);
      onChange?.(automation);
      return c.json(view());
    } catch (e) { return errorJson(c, 400, "invalid_request", e instanceof Error ? e.message : "Could not change automation state"); }
  });
  app.post("/api/automations/dog-announcer/preview", async c => {
    try { return c.json(await automation.preview(await requestJson(c))); }
    catch (e) { return errorJson(c, 400, "preview_failed", e instanceof Error ? e.message : "Could not check Frigate"); }
  });
  return app;
}
