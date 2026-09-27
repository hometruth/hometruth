/**
 * The generic on/off endpoint for any `Service` that exposes `switch`
 * (an automation's enabled flag): the same shape as a device group's switch
 * route, so `<ht-switch>` drives an automation exactly like a device or a
 * group. One mount per automation route module, keyed by the service's id.
 */
import { Hono } from "hono";
import type { Service } from "../models/service";
import { automationSwitchDocument } from "../state/automation-switch";
import { errorJson, type AppEnvironment } from "./http";

export function automationSwitchRoutes(service: Service, onChange: (service: Service) => void) {
  const app = new Hono<AppEnvironment>();
  const respond = async (context: Parameters<typeof errorJson>[0], action?: "turnOn" | "turnOff" | "toggle") => {
    const target = service.switch;
    if (!target) return errorJson(context, 404, "not_found", "No automation switch with that id");
    if (action) {
      await target.setEnabled(action === "toggle" ? !target.enabled : action === "turnOn");
      onChange(service);
    }
    const document = automationSwitchDocument(service.id, service.title, service.switch?.enabled ?? target.enabled, service.status().availability, new Date().toISOString());
    return context.json(document.capabilities.binarySwitch);
  };
  app.get(`/api/automations/${service.id}/switch`, context => respond(context));
  app.post(`/api/automations/${service.id}/switch/turn-on`, context => respond(context, "turnOn"));
  app.post(`/api/automations/${service.id}/switch/turn-off`, context => respond(context, "turnOff"));
  app.post(`/api/automations/${service.id}/switch/toggle`, context => respond(context, "toggle"));
  return app;
}
