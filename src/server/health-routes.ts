import { Hono } from "hono";
import type { Context } from "hono";
import type { Site } from "../site";
import { DAY, type HealthKind } from "../health/model";
import { HealthService } from "../health/service";
import { renderHealthPage } from "../ui/health-page";
import type { PageContext } from "../ui/shell";
import { errorJson, type AppEnvironment } from "./http";

export function healthRoutes(site: Site, pageContext: (context: Context<AppEnvironment>) => PageContext) {
  const app = new Hono<AppEnvironment>();
  const monitor = () => { const service = site.getService("health"); return service instanceof HealthService ? service : undefined; };
  for (const path of ["/health", "/api/health/report"]) app.get(path, context => {
    context.header("Cache-Control", "no-store");
    const period = context.req.query("period") ?? "24h";
    const days = period === "24h" ? 1 : period === "7d" ? 7 : period === "30d" ? 30 : undefined;
    if (!days) return errorJson(context, 400, "invalid_period", "Choose 24h, 7d, or 30d");
    const health = monitor();
    if (!health) return errorJson(context, 503, "not_ready", "Health monitoring is starting");
    const report = health.report(days * DAY);
    return path === "/health" ? context.html(renderHealthPage(pageContext(context), report, period,
      (kind, id) => kind === "device" ? site.view(id)?.page : site.pages().page("service", id))) : context.json(report);
  });
  for (const kind of ["device", "service"] as const) {
    const path = `/api/${kind}s/:id/health`;
    app.get(path, context => {
      context.header("Cache-Control", "no-store");
      const health = monitor();
      if (!health) return errorJson(context, 503, "not_ready", "Health monitoring is starting");
      const row = health.report().entities.find(row => row.kind === kind && row.id === context.req.param("id")!);
      return row ? context.json(row.health) : errorJson(context, 404, "not_found", "No monitored device or service with that id");
    });
    app.post(path + "/check", async context => {
      context.header("Cache-Control", "no-store");
      const health = monitor();
      if (!health) return errorJson(context, 503, "not_ready", "Health monitoring is starting");
      const result = await health.check(kind as HealthKind, context.req.param("id")!);
      return result ? context.json(result) : errorJson(context, 404, "not_found", "No monitored device or service with that id");
    });
  }
  return app;
}
