import type { KindlePrimitive, KindleRow } from "../kindle/presentation";
import { escapeHtml as e } from "./shell";

export function renderPrimitive(row: KindleRow, primitive: KindlePrimitive): string {
  const powerControls = primitive.actions.some((action) => action.control === "turnOn") && primitive.actions.some((action) => action.control === "turnOff");
  const redundantReading = powerControls && primitive.actions.some((action) => action.pressed && action.label === primitive.detail);
  const actions = primitive.actions.map((action) => {
    const url = action.url ?? `/api/devices/${encodeURIComponent(row.deviceId)}/capabilities/${action.capability}/controls/${action.control}`;
    return `<button type="button" disabled data-kindle-action="${e(url)}" data-result-label="${e(row.label + " · " + action.label)}"${action.confirmation ? ` data-confirmation="${e(action.confirmation)}"` : ""}${action.pressed === undefined ? "" : ` aria-pressed="${action.pressed}"`}>${e(action.label)}</button>`;
  }).join(" ");
  return `<div class="primitive${powerControls ? " power-controls" : ""}" data-capability="${primitive.capability}" role="group" aria-label="${e(row.label + " · " + primitive.label)}">${redundantReading ? "" : `<div class="reading">${e(primitive.detail)}</div>`}${row.primitives.length > 1 ? `<small>${e(primitive.label)}</small>` : ""}${actions ? `<div class="actions">${actions}</div>` : ""}</div>`;
}
