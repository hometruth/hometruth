import type { Availability } from "../models/capability";
import type { RegisteredDevice } from "../site";
import { deviceNode, type NodeId } from "../state/protocol";
import { escapeHtml, htElement, renderDeviceHead, renderPage, type PageContext } from "./shell";

export interface SwitchPageOptions {
  ctx: PageContext;
  device: RegisteredDevice;
  /** The graph node `<ht-switch>` is bound to: the device's own node unless a group switch passes `group/<id>`. */
  node?: NodeId;
  header?: string;
  details?: string;
  css?: string;
  settingsView?: boolean;
}

/** Shared by the speaker, light, and blaster pages: a state line, an action bar, and a feedback line. */
export function renderStateLine(ctx: PageContext, snapshot: { availability: Availability; label?: string; detail?: string } = { availability: "unknown" }): string {
  const { t } = ctx.i18n;
  return `<div class="state" aria-live="polite">
    <span class="mark" id="state-mark" data-availability="${escapeHtml(snapshot.availability)}" aria-hidden="true"></span>
    <span class="state-value" id="state-label">${escapeHtml(snapshot.label ?? t(`status.${snapshot.availability}`))}</span>
    <span class="state-detail" id="state-detail">${escapeHtml(snapshot.detail ?? "")}</span>
  </div>`;
}

/**
 * Words for the members that keep a group from being a switch. The switch
 * element derives the same sentence from its node (`switchGaps` in
 * `browser/kinds/switch.ts`); these stay for the group page's shared-controls
 * script until that page moves onto elements.
 */
export const SWITCH_GAP_CSS = String.raw`
  .switch-gap { color: var(--bad); }
`;
/**
 * The group page's "Shared properties" table, recomputed here from each
 * member's own `device/<id>` graph node instead of the REST snapshot, so it
 * updates the moment any member's node changes. Ports the flatten/alias/
 * intersect logic `src/models/device-group.ts` runs server-side for
 * properties (actions and switch-eligibility stay server-side: a node's
 * value carries no actions/bounds documents). `ht.state` is installed by the
 * theme's module script, which runs after this classic script, so callers
 * poll briefly for it via `groupProperties.whenReady`.
 */
export const GROUP_PROPERTIES_SCRIPT = String.raw`
  const groupProperties = (() => {
    const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
    const flatten = (value, prefix, output) => {
      for (const [key, child] of Object.entries(value)) {
        if (key === "observedAt" || key === "availability") continue;
        const path = prefix + "." + key;
        const nested = record(child);
        if (nested) flatten(nested, path, output);
        else output[path] = child;
      }
    };
    // object.status is already the device's combined availability (Device.describe() computes it server-side).
    const memberProperties = (object) => {
      const kinds = new Set();
      const properties = {};
      for (const [kind, capability] of Object.entries((object && object.capabilities) || {})) {
        if (!capability) continue;
        kinds.add(kind);
        const state = record(capability.state) || {};
        flatten(state, kind, properties);
        const isLightLike = kind === "light" || kind === "stringLight";
        const power = isLightLike ? state.on : kind === "binarySwitch" ? (state.value === "on" ? true : state.value === "off" ? false : undefined) : undefined;
        if (isLightLike || kind === "binarySwitch") {
          delete properties[kind + "." + (isLightLike ? "on" : "value")];
          properties["power.on"] = power;
          if (isLightLike) {
            properties["light.brightnessPercent"] = state.brightnessPercent;
            properties["light.colorTemperatureKelvin"] = state.colorTemperatureKelvin;
            properties["light.color"] = state.color;
          }
        }
      }
      for (const sensor of (object && object.sensors) || []) {
        kinds.add("sensor");
        const prefix = "sensor." + sensor.id;
        const state = record(sensor.state) || {};
        properties[prefix + ".unit"] = sensor.unit;
        properties[prefix + ".value"] = state.value;
      }
      const status = object && object.status;
      const availability = status === "online" || status === "offline" || status === "degraded" ? status : "unknown";
      return { availability, kinds, properties };
    };
    const isUnread = (availability) => availability === "offline" || availability === "degraded" || availability === "unknown";
    // Same-length structural equality; property values here are always JSON-safe (booleans, numbers, strings, plain objects).
    const isDeepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    /** members: [{id, name, availability, kinds, properties}]; mirrors the "shared"/"mixed"/"unknown" reducer in device-group.ts's inspect(). */
    const computeSharedProperties = (members) => {
      const keys = [...new Set(members.flatMap(member => Object.keys(member.properties)))];
      return keys.filter(key => members.every(member => {
        if (Object.hasOwn(member.properties, key)) return true;
        if (!isUnread(member.availability)) return false;
        return key === "power.on"
          ? member.kinds.has("light") || member.kinds.has("stringLight") || member.kinds.has("binarySwitch")
          : member.kinds.has(key.split(".")[0]);
      })).map(id => {
        const values = members.map(member => member.properties[id]);
        const status = values.some(value => value === undefined) ? "unknown" : values.every(value => isDeepEqual(value, values[0])) ? "shared" : "mixed";
        return status === "shared" ? { id, status, value: values[0] } : { id, status };
      });
    };
    /** Resolves once ht.state exists (installed by the theme's module script, which runs after this classic script), or after ~2s if it never does. */
    const whenReady = () => new Promise(resolve => {
      if (ht.state) { resolve(ht.state); return; }
      let attempts = 0;
      const poll = () => {
        if (ht.state) { resolve(ht.state); return; }
        if (++attempts > 100) { resolve(undefined); return; }
        requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
    });
    return { memberProperties, computeSharedProperties, whenReady };
  })();
`;

export const SWITCH_GAP_SCRIPT = String.raw`
  const switchGaps = (() => {
    const order = ["power.on", "power.turnOn", "power.turnOff", "power.toggle"];
    const label = (id) => id === "power.on" ? ht.t("switch.powerState") : id === "power.turnOn" ? ht.t("action.on") : id === "power.turnOff" ? ht.t("action.off") : ht.t("action.toggle");
    const list = (ids, type) => {
      const labels = order.filter(id => ids.includes(id)).map(label);
      return typeof Intl.ListFormat === "function" ? new Intl.ListFormat(ht.locale, { type }).format(labels) : labels.join(", ");
    };
    const odd = (snapshot) => (snapshot && Array.isArray(snapshot.members) ? snapshot.members : []).filter(member => Array.isArray(member.missingForSwitch) && member.missingForSwitch.length);
    return {
      lacks: (missing) => ht.t("switch.lacks", { controls: list(missing, "disjunction") }),
      summary: (snapshot) => {
        const members = odd(snapshot);
        if (!members.length) return "";
        return ht.t("switch.notSharedBy", { controls: list(members.flatMap(member => member.missingForSwitch), "conjunction"), count: members.length, total: snapshot.members.length });
      },
    };
  })();
`;

/**
 * A device whose schema is the BinarySwitch document: the head, then one
 * `<ht-switch>` bound to its node. The element reads the document's actions,
 * subscribes to the state stream, and sends commands; the page ships no
 * script of its own. The Settings tab shows the definition instead.
 */
export function renderSwitchPage({ ctx, device, node = deviceNode(device.id), header, details = "", css = "", settingsView = false }: SwitchPageOptions): string {
  return renderPage({
    ctx,
    title: device.name,
    nav: "switches",
    mainAttributes: `data-switch-page data-device-id="${escapeHtml(device.id)}"`,
    body: `${header ?? renderDeviceHead(ctx, device, "controls")}
      ${settingsView ? "" : htElement(ctx, "ht-switch", node)}${details}`,
    css,
    nodes: settingsView ? [] : [node],
    messages: ["state.", "summary.", "switch.", "grouping."],
  });
}
