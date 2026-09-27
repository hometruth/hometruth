import { Hono } from "hono";
import { WifiAdmissionBusyError, type WifiAdmissionService } from "../network/wifi-admission-service";
import { renderWifiAdmissionPage } from "../ui/wifi-admission-page";
import { errorJson, pageContext, requestJson, type AppEnvironment } from "./http";

const API = "/api/network/commands/accept-next";

export function networkCommandRoutes(service?: WifiAdmissionService): Hono<AppEnvironment> {
  const app = new Hono<AppEnvironment>();
  app.get("/network/commands/accept-next", context => {
    context.header("Cache-Control", "no-store");
    let error: string | undefined;
    const setup = service?.configuration();
    return context.html(renderWifiAdmissionPage({ ctx: pageContext(context), ...(setup ? { setup } : {}),
      ...(service?.snapshot() ? { run: service.snapshot()! } : {}), ...(error ? { error } : {}) }));
  });
  app.get(API, context => context.json({ run: service?.snapshot() ?? null }));
  app.get(`${API}/options`, async context => {
    if (!service) return errorJson(context, 409, "not_supported", "Wi-Fi admission is not configured for this network provider");
    return context.json(await service.inspect());
  });
  app.post(API, async context => {
    if (!service) return errorJson(context, 409, "not_supported", "Wi-Fi admission is not configured for this network provider");
    const body = await requestJson(context) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !["ssid", "timeoutSeconds", "recover"].includes(key))
      || typeof body.ssid !== "string" || !body.ssid.trim() || body.ssid.length > 128
      || (body.timeoutSeconds !== undefined && (!Number.isInteger(body.timeoutSeconds) || Number(body.timeoutSeconds) < 10 || Number(body.timeoutSeconds) > 600))
      || (body.recover !== undefined && typeof body.recover !== "boolean")) {
      return errorJson(context, 400, "invalid_request", "Choose a Wi-Fi network and a duration from 10 to 600 seconds");
    }
    try { return context.json({ run: service.start(body.ssid, body.timeoutSeconds as number | undefined, body.recover === true) }, 202); }
    catch (error) {
      if (error instanceof WifiAdmissionBusyError) return errorJson(context, 409, "busy", error.message);
      throw error;
    }
  });
  app.post(`${API}/:id/cancel`, async context => {
    if (!service) return errorJson(context, 409, "not_supported", "Wi-Fi admission is not configured for this network provider");
    try { return context.json({ run: service.cancel(context.req.param("id")) }); }
    catch (error) { return errorJson(context, 409, "not_running", error instanceof Error ? error.message : String(error)); }
  });
  return app;
}
