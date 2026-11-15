import type { MiddlewareHandler } from "hono";
import type { DeviceEventLogs } from "../models/device-event-log";
import type { Site } from "../site";
import type { HomeTruthObject } from "../schemas";
import { elementKey } from "../tags/identity";
import { errorJson, type AppEnvironment } from "./http";

/** Audit authorized control attempts, including errors handled by Hono's error handler. */
export function controlEvents(site: Site, logs: DeviceEventLogs, observe: (id: string) => Promise<HomeTruthObject>): MiddlewareHandler<AppEnvironment> {
  return async (context, next) => {
    const match = context.req.method === "POST" && /^\/api\/(devices|switches|lights|buttons|device-groups|automations)\/([^/]+)\/(.+)$/.exec(context.req.path);
    if (!match) return next();
    const [, family, encodedId, route] = match;
    const id = decodeURIComponent(encodedId!);
    const control = route!.startsWith("controls/") ? decodeURIComponent(route!.slice(9))
      : /^capabilities\/[^/]+\/controls\//.test(route!) ? route!.split("/").filter((_, index) => index === 1 || index === 3).map(decodeURIComponent).join(".")
      : ({ "turn-on": "turnOn", "turn-off": "turnOff", toggle: "toggle", press: "press", "switch/turn-on": "turnOn", "switch/turn-off": "turnOff", "switch/toggle": "toggle" } as Record<string, string>)[route!];
    const target = family === "device-groups" ? site.deviceGroups.find(group => group.id === id)
      : family === "automations" ? site.getService(id) : site.get(id);
    if (!control || !target) return next();
    const subject = family === "device-groups" ? elementKey("group", id) : family === "automations" ? elementKey("automation", id) : id;
    const name = "name" in target ? target.name : target.title;
    logs.record(subject, "device_control_requested", `${name}: ${control} requested`.slice(0, 1000), { data: { control: control.slice(0, 100) } });
    const action = control.split(".").at(-1);
    const device = site.get(id);
    const kind = control.includes(".") ? control.split(".")[0]!
      : family === "lights" ? "light" : device?.capabilities.binarySwitch ? "binarySwitch" : device?.capabilities.light ? "light" : "stringLight";
    let expected = action === "turnOn" ? "on" : action === "turnOff" ? "off" : undefined;
    if (action === "toggle" && device && family !== "device-groups" && family !== "automations" && ["binarySwitch", "light", "stringLight"].includes(kind)) {
      const object = await observe(id).catch(() => undefined);
      const state = object?.capabilities[kind as "binarySwitch" | "light" | "stringLight"]?.state;
      const current = state && ("value" in state ? state.value : "on" in state ? state.on === undefined ? undefined : state.on ? "on" : "off" : undefined);
      if (current === "on" || current === "off") expected = current === "on" ? "off" : "on";
    }
    await next();
    type State = { value?: string; on?: boolean; availability?: string };
    let result = await context.res.clone().json().catch(() => undefined) as { error?: { code?: string; message?: string; detail?: string }; ok?: boolean; results?: { ok: boolean; name: string; error?: string }[]; state?: State; object?: { capabilities: Record<string, { state: State }> } } | undefined;
    if (context.res.ok && expected) {
      const state = result?.object?.capabilities[kind]?.state ?? result?.state;
      if (state && ["binarySwitch", "light", "stringLight"].includes(kind)) {
        const actual = state.value ?? (state.on === undefined ? undefined : state.on ? "on" : "off");
        if (actual !== expected) {
          const reason = actual === undefined
            ? `The command was sent, but ${expected === "on" ? "On" : "Off"} could not be confirmed (${state.availability ?? "unknown"})`
            : `Requested ${expected === "on" ? "On" : "Off"}, but the device still reports ${actual === "on" ? "On" : "Off"}`;
          result = { error: { code: "state_not_applied", message: reason } };
          context.res = errorJson(context, 502, "state_not_applied", reason);
        }
      }
    }
    if (context.res.status >= 400 || result?.ok === false) {
      const reason = [context.error?.message ?? result?.error?.message, result?.error?.detail].filter(Boolean).join(": ")
        || result?.results?.filter(member => !member.ok).map(member => `${member.name}: ${member.error}`).join("; ")
        || `Request failed (HTTP ${context.res.status})`;
      logs.record(subject, "device_control_failed", `${name}: ${control} failed — ${reason}`.slice(0, 1000), {
        data: { control: control.slice(0, 100), reason: reason.slice(0, 1000) },
      });
    } else if (family === "device-groups" || family === "automations") {
      logs.record(subject, "device_control", `${name}: ${control} completed`, { data: { control } });
    }
  };
}
