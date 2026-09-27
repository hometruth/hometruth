/** Initial HTML from domain records. Browser elements hydrate the same shipped records. */
import type { HomeTruthObject } from "../schemas";
import type { NodeRecord } from "../state/protocol";
import { isCold } from "../state/persistence";
import { escapeHtml as e, type HtTag, type PageContext } from "./shell";

export function renderStateSnapshot(ctx: PageContext, tag: HtTag, record?: NodeRecord): string {
  const object = record?.value as HomeTruthObject | undefined;
  const capabilities = object?.capabilities;
  const cold = isCold(record?.observedAt);
  const availability = record?.fault ? "offline" : object?.status ?? "unknown";
  const reading = capabilities?.binarySwitch ?? capabilities?.light ?? capabilities?.stringLight;
  const state = reading?.state;
  const power = state && ("value" in state ? state.value === "on" ? true : state.value === "off" ? false : undefined : "on" in state ? state.on : undefined);
  const current = !record?.fault && !cold;
  let body = "";
  const powerView = tag === "ht-switch" || tag === "ht-switch-row" || tag === "ht-light";
  if (powerView) {
    body = `<div class="bar">${([true, false] as const).map(on => `<button type="button" class="btn" disabled aria-pressed="${current && power === on}" data-state="${current && power !== undefined ? power === on ? "active" : "inactive" : "unknown"}">${e(ctx.i18n.t(on ? "action.on" : "action.off"))}</button>`).join("")}</div>`;
    if (!current && power !== undefined) body += `<span class="muted">${e(ctx.i18n.t(power ? "action.on" : "action.off"))}</span>`;
    if (state && "brightnessPercent" in state && typeof state.brightnessPercent === "number") body += `<span>${e(ctx.i18n.number(state.brightnessPercent))}%</span>`;
  } else if (tag === "ht-television") {
    const tv = capabilities?.television?.state;
    body = `<dl class="kv"><dt>${e(ctx.i18n.t("tv.power"))}</dt><dd>${e(tv?.power === "on" ? ctx.i18n.t("action.on") : tv?.power === "standby" ? ctx.i18n.t("action.off") : ctx.i18n.t("status.unknown"))}</dd>${tv?.artMode ? `<dt>${e(ctx.i18n.t("tv.artMode"))}</dt><dd>${e(tv.artMode)}</dd>` : ""}</dl>`;
  } else if (tag === "ht-button") {
    body = `<button class="btn" type="button" disabled>${e(ctx.i18n.t("button.press"))}</button>`;
  } else if (tag === "ht-sensor" || tag === "ht-sensor-row") {
    const sensors = capabilities?.sensor?.state.sensors ?? object?.sensors ?? [];
    body = sensors.length ? `<dl class="kv">${sensors.map(sensor => {
      const value = "state" in sensor ? sensor.state.value : sensor.value;
      return `<dt>${e(sensor.name)}</dt><dd>${value === undefined ? e(ctx.i18n.t("status.unknown")) : e(`${ctx.i18n.number(value)} ${sensor.unit}`)}</dd>`;
    }).join("")}</dl>` : "";
    const sensor = capabilities?.contactSensor?.state ?? capabilities?.occupancySensor?.state;
    if (sensor) {
      const word = "open" in sensor && typeof sensor.open === "boolean" ? ctx.i18n.t(sensor.open ? "sensor.open" : "sensor.closed")
        : "occupied" in sensor && typeof sensor.occupied === "boolean" ? ctx.i18n.t(sensor.occupied ? "sensor.occupied" : "sensor.clear") : ctx.i18n.t(`status.${availability}`);
      body += `<span>${e(object?.name ?? "")} · ${e(word)}</span>${!("batteryPercent" in sensor) || sensor.batteryPercent === undefined ? "" : `<span>${e(ctx.i18n.number(sensor.batteryPercent / 100, { style: "percent" }))}</span>`}`;
    }
  }
  if (!body || tag === "ht-status" || record?.fault) body += `<span>${e(record?.fault?.message ?? ctx.i18n.t(`status.${availability}`))}</span>`;
  const freshness = record?.observedAt
    ? `<span class="muted small">${e(ctx.i18n.t("status.readAt", { time: ctx.i18n.dateTime(record.observedAt) }))}</span>`
    : `<span class="muted small">${e(ctx.i18n.t("status.unknown"))}</span>`;
  return `<div data-state-snapshot${record?.observedAt ? ` data-live="${e(record.observedAt)}"` : ""} data-availability="${e(availability)}" data-stale="${!current}">${body}${freshness}</div>`;
}
