import type { Availability, CapabilityKind } from "../models/capability";
import type { Device } from "../models/device";
import type { GroupSnapshot } from "../models/device-group";
import type { NodeRecord } from "../state/protocol";
import { isCold } from "../state/persistence";
import type { HomeTruthObject } from "../schemas";
import { type Site, summaryDetail } from "../site";
import type { MessageKey, Translator } from "../ui/i18n";
import type { KindleConfig, KindleItem } from "./config";
import { kindleElements, type KindleElement } from "./elements";

export interface KindleAction {
  url?: string;
  capability: CapabilityKind;
  control: string;
  label: string;
  pressed?: boolean;
  confirmation?: string;
}
export interface KindlePrimitive {
  capability: CapabilityKind;
  label: string;
  availability: Availability;
  detail: string;
  actions: KindleAction[];
}
export interface KindleRow {
  source?: "device" | "group";
  widgetId?: string;
  deviceId: string;
  label: string;
  room: string;
  model: string;
  availability: Availability;
  primitives: KindlePrimitive[];
  missing: boolean;
}
export interface KindleSnapshot { generatedAt: string; rows: KindleRow[] }
type Document = { state?: { availability?: Availability; value?: string; on?: boolean }; actions?: Record<string, { confirmation?: string }> };
export interface KindleAdapter {
  controls: readonly { control: string; label: MessageKey }[];
}
const power: KindleAdapter = { controls: [{ control: "turnOn", label: "action.on" }, { control: "turnOff", label: "action.off" }] };
/** Capability adapters are shared by every model. Unregistered kinds always get status. */
export const KINDLE_ADAPTERS: Partial<Record<CapabilityKind, KindleAdapter>> = {
  binarySwitch: power,
  light: power,
  button: { controls: [{ control: "press", label: "button.press" }] },
};

export function configuredItems(config: KindleConfig, site: Site): KindleItem[] {
  if (config.canvas) return config.canvas.widgets.filter((widget) => widget.kind === "device").map(({ deviceId, source, capability, mode, label }) => ({ deviceId, ...(source ? { source } : {}), capability, mode, label }));
  if (config.selection === "custom") return config.items;
  return [...site.list()].sort((a, b) => (a.room ?? "").localeCompare(b.room ?? "") || a.name.localeCompare(b.name)).map((device) => ({ deviceId: device.id, capability: "auto", mode: "auto", label: "" }));
}

function groupPrimitives(element: KindleElement, snapshot: GroupSnapshot, item: KindleItem, i18n: Translator): KindlePrimitive[] {
  const kinds = item.capability === "auto" ? element.capabilities : [item.capability];
  const powerKind = element.capabilities.includes("light") ? "light" : "binarySwitch";
  return kinds.map(kind => {
    const namespace = kind === powerKind ? "power" : kind;
    const properties = snapshot.properties.filter(property => property.id.startsWith(kind + ".") || kind === powerKind && property.id === "power.on");
    const detail = properties.map(property => {
      const value = property.status === "mixed" ? i18n.t("grouping.mixed") : property.status === "unknown" ? i18n.t("status.unknown") : typeof property.value === "boolean" ? i18n.t(property.value ? "action.on" : "action.off") : typeof property.value === "object" ? JSON.stringify(property.value) : String(property.value);
      if (property.id === "power.on") return value;
      const name = property.id.split(".").pop()!;
      const label = i18n.lookup(`grouping.label.${name}`) ?? name.replace(/([a-z])([A-Z])/g, "$1 $2");
      return `${label}: ${value}`;
    }).join(" · ") || i18n.t(`status.${snapshot.availability}`);
    const actions: KindleAction[] = [];
    if (item.mode === "auto" && snapshot.availability !== "offline") {
      for (const action of KINDLE_ADAPTERS[kind]?.controls ?? []) {
        const shared = snapshot.actions.find(shared => shared.id === `${namespace}.${action.control}` && shared.input === "none");
        if (!shared) continue;
        const power = snapshot.properties.find(property => property.id === "power.on");
        const on = power?.status === "shared" && typeof power.value === "boolean" ? power.value : undefined;
        actions.push({ capability: kind, control: action.control, label: i18n.t(action.label),
          url: `/api/device-groups/${encodeURIComponent(element.id)}/controls/${encodeURIComponent(shared.id)}`,
          ...(on === undefined || namespace !== "power" ? {} : { pressed: action.control === "turnOn" ? on : !on }),
          ...(shared.confirmation ? { confirmation: i18n.t("grouping.confirm", { action: i18n.t(action.label), count: snapshot.members.length }) } : {}),
        });
      }
    }
    return { capability: kind, label: i18n.t(`cap.${kind}`), availability: snapshot.availability, detail, actions };
  });
}

function primitive(kind: CapabilityKind, object: HomeTruthObject | undefined, device: Device, mode: KindleItem["mode"], i18n: Translator, current: boolean): KindlePrimitive {
  const document = object?.capabilities[kind] as Document | undefined;
  const availability = document?.state?.availability ?? "unknown";
  let detail = i18n.t(`status.${availability}`);
  if (document && availability !== "offline" && (availability !== "unknown" || kind === "button")) {
    // Only the selected capability participates; no host, config, or secret is rendered.
    const isolated = { ...object, capabilities: { [kind]: document } } as HomeTruthObject;
    detail = summaryDetail(isolated) ?? detail;
    if (detail === "On") detail = i18n.t("action.on");
    if (detail === "Off") detail = i18n.t("action.off");
    if (kind === "button") detail = i18n.t("kindle.buttonReady");
  }
  const actions: KindleAction[] = [];
  if (mode === "auto" && document && current && availability !== "offline") {
    for (const action of KINDLE_ADAPTERS[kind]?.controls ?? []) {
      if (!Object.hasOwn(document.actions ?? {}, action.control) || !device.capability(kind)?.controlIds.includes(action.control)) continue;
      const confirmation = document.actions?.[action.control]?.confirmation;
      const on = document.state?.on ?? (document.state?.value === "on" ? true : document.state?.value === "off" ? false : undefined);
      actions.push({ capability: kind, control: action.control, label: i18n.t(action.label),
        ...(on === undefined || action.control === "press" ? {} : { pressed: action.control === "turnOn" ? on : !on }),
        ...(confirmation ? { confirmation } : {}),
      });
    }
  }
  return { capability: kind, label: i18n.t(`cap.${kind}`), availability, detail, actions };
}

export interface KindleState {
  record(id: string): NodeRecord | undefined;
  group(id: string): GroupSnapshot | undefined;
}

/** Presentation is a pure projection of shipped state, including on a cold cache. */
export function buildKindleSnapshot(site: Site, config: KindleConfig, state: KindleState, i18n: Translator): KindleSnapshot {
  const items = configuredItems(config, site);
  const elements = kindleElements(site);
  const widgetIds = config.canvas?.widgets.filter((widget) => widget.kind === "device").map((widget) => widget.id);
  return { generatedAt: new Date().toISOString(), rows: items.map((item, index) => {
    if (item.source === "group") {
      const element = elements.find(element => element.source === "group" && element.id === item.deviceId);
      const snapshot = state.group(item.deviceId);
      const missing = !element || !snapshot || item.capability !== "auto" && !element.capabilities.includes(item.capability);
      return { ...(widgetIds?.[index] ? { widgetId: widgetIds[index] } : {}), source: "group", deviceId: item.deviceId,
        label: item.label || element?.name || item.deviceId, room: element?.room ?? "", model: i18n.t("grouping.group"), missing,
        availability: snapshot?.availability ?? "unknown", primitives: !missing && element && snapshot ? groupPrimitives(element, snapshot, item, i18n) : [],
      };
    }
    const device = site.get(item.deviceId);
    const record = state.record(item.deviceId);
    const cached = record?.value as HomeTruthObject | undefined;
    const unavailable = record?.fault ? "offline" : isCold(record?.observedAt) ? "unknown" : undefined;
    const object = cached && unavailable ? {
      ...cached, status: unavailable,
      capabilities: Object.fromEntries(Object.entries(cached.capabilities).map(([kind, doc]) => [kind, doc ? { ...doc, state: { ...doc.state, availability: unavailable } } : doc])),
      ...(cached.sensors ? { sensors: cached.sensors.map(sensor => ({ ...sensor, state: { ...sensor.state, availability: unavailable } })) } : {}),
    } as HomeTruthObject : cached;
    const sensorView = !!device?.sensors.length && item.capability === "auto";
    const kinds = item.capability === "auto" ? device?.model.capabilities ?? [] : [item.capability];
    const missing = !device || kinds.some((kind) => !device.model.capabilities.includes(kind));
    const primitives = !missing && device ? kinds.map((kind) => primitive(kind, object, device, item.mode, i18n, !unavailable)) : [];
    if (sensorView && device) for (const sensor of device.sensors) {
      const state = object?.sensors?.find(document => document.id === sensor.id)?.state;
      primitives.push({ capability: "sensor", label: sensor.name, availability: state?.availability ?? "unknown", actions: [],
        detail: state?.availability === "online" && state.value !== undefined
          ? `${i18n.number(state.value, { maximumFractionDigits: 2 })} ${sensor.unit}` : i18n.t("status.unavailable"),
      });
    }
    return {
      ...(widgetIds?.[index] ? { widgetId: widgetIds[index] } : {}),
      deviceId: item.deviceId, label: item.label || device?.name || item.deviceId,
      room: device?.room ?? "", model: device?.model.title ?? "", missing,
      availability: missing ? "unknown" : object?.status ?? "unknown", primitives,
    };
  }) };
}
