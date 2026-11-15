import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import type { Site } from "../site";
import { DAY, type HealthKind } from "../health/model";
import { HealthService } from "../health/service";
import { renderHealthInvestigationPage } from "../ui/health-investigation-page";
import { renderHealthPage } from "../ui/health-page";
import type { PageContext } from "../ui/shell";
import { errorJson, type AppEnvironment } from "./http";

/** Observe actual control results, including specialized routes that call capabilities directly. */
export function healthControlFailures(site: Site): MiddlewareHandler<AppEnvironment> {
  return async (context, next) => {
    const match = context.req.method === "POST" && /^\/api\/(devices|switches|lights|buttons|services|automations|radio-receivers|ir-rf-blasters)\/([^/]+)\/(.+)$/.exec(context.req.path);
    if (!match) return next();
    const [, family, encodedId, route] = match;
    const action = /^(?:controls\/|capabilities\/[^/]+\/controls\/|actions\/)/.test(route!) || /^(?:(?:switch\/)?(?:turn-on|turn-off|toggle)|press|brightness|color-temperature|color|reboot|start|stop|send|learn|quiet)$/.test(route!) || /^codes\/[^/]+\/send$/.test(route!);
    if (!action) return next();
    await next();
    // Authorization, malformed requests and missing controls do not prove an execution failure.
    if (context.res.status >= 400 && context.res.status < 500) {
      const code = String((context.error as { code?: unknown } | undefined)?.code);
      if (!context.error || ["invalid_value", "invalid_host", "invalid_url", "invalid", "confirmation_required", "unknown_control", "not_supported", "device_disabled", "no_such_capability", "ambiguous_control"].includes(code)) return;
    }
    const health = site.getService("health");
    if (!(health instanceof HealthService)) return;
    const body = await context.res.clone().json().catch(() => null) as { ok?: boolean } | null;
    const kind = family === "services" || family === "automations" ? "service" : "device";
    const id = decodeURIComponent(encodedId!);
    const succeeded = context.res.ok && body?.ok !== false;
    health.reportAction(kind, id, succeeded);
    if (!succeeded && (!context.get("principal") || context.get("principal")!.allowsSite("read"))) {
      const investigation = health.investigationFor(kind, id);
      if (investigation) context.header("X-HomeTruth-Investigation", investigation.href);
    }
  };
}

export function healthRoutes(site: Site, pageContext: (context: Context<AppEnvironment>) => PageContext) {
  const app = new Hono<AppEnvironment>();
  const monitor = () => { const service = site.getService("health"); return service instanceof HealthService ? service : undefined; };
  app.get("/api/health/investigations", context => {
    context.header("Cache-Control", "no-store");
    const health = monitor();
    return health ? context.json(health.investigations()) : errorJson(context, 503, "not_ready", "Health monitoring is starting");
  });
  app.get("/api/health/investigations/stream", context => {
    const health = monitor();
    if (!health) return errorJson(context, 503, "not_ready", "Health monitoring is starting");
    const encoder = new TextEncoder();
    let detach: (() => void) | undefined, heartbeat: ReturnType<typeof setInterval> | undefined;
    const stop = () => { detach?.(); clearInterval(heartbeat); context.req.raw.signal.removeEventListener("abort", stop); };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (items: ReturnType<HealthService["investigations"]>) => {
          try { controller.enqueue(encoder.encode(`event: investigations\ndata: ${JSON.stringify(items)}\n\n`)); } catch { stop(); }
        };
        detach = health.subscribeInvestigations(send);
        controller.enqueue(encoder.encode("retry: 1000\n\n"));
        send(health.investigations());
        heartbeat = setInterval(() => { try { controller.enqueue(encoder.encode(": heartbeat\n\n")); } catch { stop(); } }, 15000).unref();
        context.req.raw.signal.addEventListener("abort", stop, { once: true });
      }, cancel: stop,
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
  });
  for (const path of ["/health/investigations/:investigationId", "/api/health/investigations/:investigationId"]) app.get(path, context => {
    context.header("Cache-Control", "no-store");
    const health = monitor();
    if (!health) return errorJson(context, 503, "not_ready", "Health monitoring is starting");
    const value = health.investigation(context.req.param("investigationId")!);
    if (!value) return errorJson(context, 404, "not_found", "No investigation with that id");
    return path.startsWith("/api/") ? context.json(value) : context.html(renderHealthInvestigationPage(pageContext(context), value,
      (kind, id) => kind === "device" ? site.view(id)?.page : site.pages().page("service", id), health.advisorBudget()));
  });
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
    app.put(path + "/policy", async context => {
      context.header("Cache-Control", "no-store");
      const health = monitor();
      if (!health) return errorJson(context, 503, "not_ready", "Health monitoring is starting");
      const body: unknown = await context.req.json().catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || !("unreachableIsUnhealthy" in body) || typeof body.unreachableIsUnhealthy !== "boolean") {
        return errorJson(context, 400, "invalid_policy", "Provide only unreachableIsUnhealthy as a boolean");
      }
      return health.setUnreachableIsUnhealthy(kind, context.req.param("id")!, body.unreachableIsUnhealthy)
        ? context.json({ unreachableIsUnhealthy: body.unreachableIsUnhealthy })
        : errorJson(context, 404, "not_found", "No monitored device or service with that id");
    });
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
