import type { RegisteredDevice } from "../site";
import { deviceNode } from "../state/protocol";
import { escapeHtml, htElement, renderDeviceHead, renderPage, type PageContext } from "./shell";

/** The server's own English detail for an accessory awaiting a HomeKit pairing; compared, never shown. */
const PAIRING_REQUIRED = "Pairing required";

const SENSOR_SCRIPT = String.raw`
(() => {
  const root = document.querySelector("[data-sensor-page]");
  const mark = document.querySelector("#state-mark");
  const status = document.querySelector("#state-label");
  const details = document.querySelector("#sensor-details");
  const components = document.querySelector("#device-sensors");
  const updated = document.querySelector("#state-detail");
  const pairing = document.querySelector("#pairing");
  // The value half of a reading is state and takes the mark; the label half is not.
  // confirmedAt is whatever the frame being drawn carries, so no call site has to pass it.
  const row = (label, value) => {
    const term = document.createElement("dt"); term.textContent = label;
    const reading = document.createElement("dd"); reading.textContent = value;
    details.append(term, reading);
    ht.live(reading, confirmedAt);
  };
  const yesNo = (value, yes, no) => value ? ht.t(yes) : ht.t(no);
  /**
   * How long ago a reading was taken, in words. A Matter subscription only reports on change, so a
   * quiet door's timestamp ages while the connection is perfectly healthy: age is worth showing,
   * but it is never grounds for hiding the reading or calling the device unreachable.
   */
  const ageOf = (observedAt) => {
    if (!observedAt) return "";
    const seconds = Math.max(0, Math.round((Date.now() - new Date(observedAt).getTime()) / 1000));
    if (seconds < 90) return ht.t("sensor.age.now");
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return ht.t("sensor.age.minutes", { count: minutes });
    const hours = Math.round(minutes / 60);
    if (hours < 24) return ht.t("sensor.age.hours", { count: hours });
    return ht.t("sensor.age.days", { count: Math.round(hours / 24) });
  };
  // Serial numbers of the accessories that already have a HomeTruth device of their own; those are
  // listed with live state in the Connected devices table, so they are not repeated in this list.
  const bridgedSerials = new Set(JSON.parse(root.dataset.bridgedSerials || "[]").map(serial => serial.toLowerCase()));
  function renderSensors(object) {
    if (mark instanceof HTMLElement) mark.dataset.availability = object.status || "unknown";
    status.textContent = ht.t("status." + (object.status || "unknown"));
    ht.live(mark, confirmedAt); ht.live(status, confirmedAt);
    updated.textContent = "";
    components.replaceChildren();
    for (const sensor of object.sensors) {
      const card = document.createElement("article"); card.className = "sensor-component"; card.dataset.sensorId = sensor.id;
      const title = document.createElement("h3"); title.textContent = sensor.name;
      const type = document.createElement("p"); type.className = "muted small"; type.textContent = ht.t("sensor.type." + sensor.kind);
      const value = document.createElement("p"); value.className = "sensor-value";
      value.textContent = sensor.state.availability === "online" && typeof sensor.state.value === "number"
        ? ht.number(sensor.state.value, { maximumFractionDigits: 2 }) + " " + sensor.unit : ht.t("status.unavailable");
      const state = document.createElement("p"); state.className = "small";
      const indicator = document.createElement("span"); indicator.className = "mark"; indicator.dataset.availability = sensor.state.availability; indicator.setAttribute("aria-hidden", "true");
      state.append(indicator, " " + ht.t("status." + sensor.state.availability));
      const time = document.createElement("p"); time.className = "muted small";
      time.textContent = sensor.state.observedAt ? ht.t("status.readAt", { time: ht.time(sensor.state.observedAt) }) : ht.t("sensor.noReading");
      ht.live(value, confirmedAt); ht.live(state, confirmedAt);
      card.append(title, type, value, state, time);
      if (sensor.state.detail) { const detail = document.createElement("p"); detail.className = "note"; detail.textContent = sensor.state.detail; card.append(detail); }
      components.append(card);
    }
  }
  let renderSignature = "";
  /** When the graph last confirmed this device, set from each frame's own node record. */
  let confirmedAt;
  function render(object, observedAt) {
    confirmedAt = observedAt;
    const signature = JSON.stringify([object, observedAt]);
    if (signature === renderSignature) return;
    renderSignature = signature;
    if (components && object.sensors) { renderSensors(object); return; }
    const caps = object.capabilities;
    const state = (caps.sensor || caps.occupancySensor || caps.contactSensor || caps.hub).state;
    details?.replaceChildren();
    if (mark instanceof HTMLElement) mark.dataset.availability = state.availability || "unknown";
    status.textContent = state.detail || (state.availability === "online" ? ht.t("sensor.connected") : ht.t("sensor.unavailable"));
    ht.live(mark, confirmedAt); ht.live(status, confirmedAt);
    if (pairing) pairing.hidden = state.detail !== ${JSON.stringify(PAIRING_REQUIRED)};
    for (const sensor of state.sensors || []) {
      const available = sensor.availability === "online" && typeof sensor.value === "number";
      row(sensor.name, sensor.availability === "online" && sensor.detail
        ? sensor.detail + (sensor.quantity.endsWith("-event") || sensor.quantity === "rotation" ? " · " + ht.dateTime(sensor.observedAt) : "")
        : available ? ht.number(sensor.value, { maximumFractionDigits: 2 }) + " " + sensor.unit : ht.t("status.unavailable"));
    }
    // <ht-sensor> above already says open/occupied and the battery, in the same words this page
    // used to repeat here; the list keeps what the row has no cell for.
    const hasRow = Boolean(document.querySelector("ht-sensor"));
    if (!hasRow && typeof state.occupied === "boolean") row(ht.t("sensor.presence"), yesNo(state.occupied, "sensor.occupied", "sensor.clear"));
    if (!hasRow && typeof state.open === "boolean") row(ht.t("sensor.door"), yesNo(state.open, "sensor.open", "sensor.closed"));
    if (!hasRow && typeof state.batteryPercent === "number") row(ht.t("sensor.battery"), ht.number(state.batteryPercent / 100, { style: "percent" }));
    if (typeof state.illuminanceLux === "number") row(ht.t("sensor.illuminance"), ht.number(state.illuminanceLux) + " lx");
    if (typeof state.tampered === "boolean") row(ht.t("sensor.tamper"), yesNo(state.tampered, "sensor.detected", "sensor.clear"));
    if (state.securityState) row(ht.t("sensor.security"), state.securityState);
    for (const zone of state.zones || []) row(zone.name, typeof zone.occupied === "boolean" ? yesNo(zone.occupied, "sensor.occupied", "sensor.clear") : ht.t("status.unavailable"));
    // Accessories that became HomeTruth devices are listed in the Connected devices table below,
    // with their live state; only the ones with no device of their own are worth repeating here.
    for (const accessory of state.accessories || []) {
      if (accessory.serialNumber && bridgedSerials.has(accessory.serialNumber.toLowerCase())) continue;
      row(accessory.name, accessory.model || ht.t("sensor.accessory"));
    }
    // An empty list still draws its rule, which reads as a section that failed to load rather
    // than one with nothing to add; a sensor whose whole reading is the row above has nothing.
    if (details) details.hidden = !details.children.length;
    const stamp = confirmedAt || state.observedAt;
    updated.textContent = stamp ? ht.t("status.readAt", { time: ht.time(stamp) }) : ht.t("sensor.awaiting");
    if (stamp) updated.title = ageOf(stamp);
    ht.live(updated, stamp);
  }
  function showUnavailable() {
    details?.replaceChildren();
    components?.replaceChildren();
    if (mark instanceof HTMLElement) mark.dataset.availability = "offline";
    status.textContent = ht.t("sensor.connectionUnavailable");
    updated.textContent = ht.t("sensor.noReading");
    // Nothing here is a current reading any more, so nothing here claims a freshness.
    confirmedAt = undefined;
    for (const node of [mark, status, updated]) ht.live(node, undefined);
  }
  // Nothing on this page polls. The first paint is rendered server-side from the graph's cached
  // record, and every value after it arrives on the page's one state stream. ht.state is
  // installed by the theme's module script, which runs after this classic inline script, so wait
  // for it rather than fetching anything.
  const whenStateReady = () => new Promise(resolve => {
    if (ht.state) { resolve(ht.state); return; }
    let attempts = 0;
    const check = () => {
      if (ht.state) { resolve(ht.state); return; }
      if (++attempts > 100) { resolve(undefined); return; }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
  whenStateReady().then(state => {
    if (!state) return;
    state.subscribe("device/" + root.dataset.deviceId, record => {
      if (record.value) render(record.value, record.observedAt);
      else if (record.fault) showUnavailable();
    }, "live");
  });
  // No visibility or pagehide handling here: the state client already closes its stream while the
  // page is hidden and reopens it on return (src/ui/browser/state.ts).
  document.querySelector("#sync-button")?.addEventListener("click", async () => {
    const button = document.querySelector("#sync-button");
    const feedback = document.querySelector("#sync-feedback");
    button.disabled = true;
    ht.say(feedback, ht.t("sensor.sync.syncing"));
    try {
      const result = await ht.request("/api/aqara/" + encodeURIComponent(root.dataset.deviceId) + "/sync", { method: "POST", body: "{}" });
      ht.say(feedback, ht.t("sensor.sync.result", { count: result.added.length }), "ok");
    } catch (error) { ht.say(feedback, error.message || ht.t("sensor.sync.failed"), "bad"); }
    finally { button.disabled = false; }
  });
  document.querySelector("#pair-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = document.querySelector("#pair-code");
    const button = document.querySelector("#pair-button");
    const feedback = document.querySelector("#pair-feedback");
    const pin = input.value; input.value = ""; button.disabled = true;
    ht.say(feedback, ht.t("sensor.pair.pairing"));
    try {
      await ht.request("/api/aqara/" + encodeURIComponent(root.dataset.deviceId) + "/pair", { method: "POST", body: JSON.stringify({ pin }) });
      // The pairing changes the device, so the graph pushes the new reading on its own.
      ht.say(feedback, ht.t("sensor.pair.done"), "ok");
    } catch (error) { ht.say(feedback, error.message || ht.t("sensor.pair.failed"), "bad"); }
    finally { button.disabled = false; }
  });
})();`;

/** One device this hub bridges, as much as the hub's own page needs to link to it and group it by type. */
export interface BridgedDevice {
  readonly id: string;
  readonly name: string;
  readonly page: string;
  readonly modelTitle: string;
  /** The hub-side accessory this device is, so the hub's own accessory list can skip it. */
  readonly serialNumber?: string;
}

/**
 * What a hub bridges, one `ht-sensor-row` per device.
 *
 * The list is the grid; each element is `display: contents` and drops its four cells straight into
 * it, so nine sensors line up down the page while the identical element, alone on the sensor's own
 * page, is that grid with one row. Nothing here reads a value: the elements are bound to their own
 * nodes and keep themselves current, which is also what marks every reading live without this page
 * remembering to.
 */
function renderBridgedDevices(ctx: PageContext, bridged: readonly BridgedDevice[]): string {
  if (!bridged.length) return "";
  const { t } = ctx.i18n;
  const groups = new Map<string, BridgedDevice[]>();
  for (const member of bridged) groups.set(member.modelTitle, [...(groups.get(member.modelTitle) ?? []), member]);
  const lists = [...groups.entries()].map(([modelTitle, members]) => `
    <h3>${escapeHtml(modelTitle)}</h3>
    <div class="sensor-list">
      <span class="sensor-head">${escapeHtml(t("sensor.bridged.name"))}</span>
      <span class="sensor-head">${escapeHtml(t("sensor.bridged.status"))}</span>
      <span class="sensor-head">${escapeHtml(t("sensor.battery"))}</span>
      <span class="sensor-head">${escapeHtml(t("sensor.bridged.age"))}</span>
      ${members.map(member => htElement(ctx, "ht-sensor-row", deviceNode(member.id), `href="${escapeHtml(member.page)}"`)).join("")}
    </div>`).join("");
  return `<section aria-labelledby="bridged-heading"><h2 id="bridged-heading">${escapeHtml(t("sensor.bridged.title"))}</h2>${lists}</section>`;
}

/** The one grid both pages lay a sensor row into, so a door reads the same in either place. */
export const SENSOR_LIST_CSS = `.sensor-list {
    display: grid; grid-template-columns: minmax(0, 1fr) max-content max-content max-content;
    column-gap: var(--s5); align-items: center;
    border-block-start: var(--rule-w) solid var(--rule); margin-block: var(--s3);
  }
  .sensor-head { padding-block: var(--s2); border-block-end: 1px solid var(--hair); color: var(--fg-2); font-size: .8125rem; }
  @media (max-width: 40rem) {
    .sensor-list { grid-template-columns: minmax(0, 1fr) max-content; column-gap: var(--s3); }
    .sensor-head:nth-of-type(n + 3) { display: none; }
    ht-sensor-row::part(battery), ht-sensor-row::part(age), ht-sensor::part(battery), ht-sensor::part(age) { display: none; }
  }`;

export function renderSensorPage({ ctx, device, bridged = [] }: { ctx: PageContext; device: RegisteredDevice; bridged?: readonly BridgedDevice[] }): string {
  const { t } = ctx.i18n;
  const composed = device.kind === "device";
  // The graph's cached record for this device, so the status beside the title is the real one on
  // first paint rather than a placeholder that swaps a moment later.
  const head = (() => {
    const [record] = ctx.state.snapshot([deviceNode(device.id)]);
    const value = record?.value as { status?: string; capabilities?: Record<string, { state?: Record<string, unknown> }> } | undefined;
    const state = value?.capabilities ? Object.values(value.capabilities)[0]?.state ?? {} : {};
    const availability = typeof state.availability === "string" ? state.availability : value?.status ?? "unknown";
    // The node's own observedAt: when this was last confirmed from the device, not when it changed.
    return {
      availability,
      label: typeof state.detail === "string" ? state.detail : t(availability === "online" ? "sensor.connected" : "sensor.unavailable"),
      detail: record?.observedAt ? t("status.readAt", { time: ctx.i18n.time(record.observedAt) }) : "",
      // The first paint is a reading too, so it is marked before any script runs.
      live: record?.observedAt ? ` data-live="${escapeHtml(record.observedAt)}"` : "",
    };
  })();
  // A door or presence sensor shows its own reading as the very row a hub lists it in: one
  // element, one grid, one vocabulary, so the two pages cannot drift apart again.
  const ownRow = device.capabilities.includes("contactSensor") || device.capabilities.includes("occupancySensor")
    ? `<div class="sensor-list">
      <span class="sensor-head">${escapeHtml(t("sensor.bridged.name"))}</span>
      <span class="sensor-head">${escapeHtml(t("sensor.bridged.status"))}</span>
      <span class="sensor-head">${escapeHtml(t("sensor.battery"))}</span>
      <span class="sensor-head">${escapeHtml(t("sensor.bridged.age"))}</span>
      ${htElement(ctx, "ht-sensor", deviceNode(device.id))}
    </div>`
    : "";
  const pairing = !device.model.startsWith("aqara-") ? "" : device.model === "aqara-door-window-sensor"
    ? `<section id="pairing" hidden><h2>${escapeHtml(t("sensor.pair.title"))}</h2><p class="note">${escapeHtml(t("sensor.pair.viaHub"))}</p></section>`
    : `<section id="pairing" hidden><h2>${escapeHtml(t("sensor.pair.title"))}</h2><p class="note">${escapeHtml(t("sensor.pair.help"))}</p>
      <form id="pair-form"><label class="field"><span>${escapeHtml(t("sensor.pair.code"))}</span><div class="field-row"><input id="pair-code" class="mono" type="password" inputmode="numeric" autocomplete="off" placeholder="XXX-XX-XXX" pattern="[0-9]{3}-[0-9]{2}-[0-9]{3}" required><button id="pair-button" type="submit" class="btn btn-primary">${escapeHtml(t("sensor.pair.submit"))}</button></div></label></form><p id="pair-feedback" class="feedback" role="status"></p></section>`;
  const sync = device.model !== "aqara-hub-m2" ? "" : `<section id="sync"><h2>${escapeHtml(t("sensor.sync.title"))}</h2><p class="note">${escapeHtml(t("sensor.sync.help"))}</p>
      <button id="sync-button" type="button" class="btn">${escapeHtml(t("sensor.sync.button"))}</button><p id="sync-feedback" class="feedback" role="status"></p></section>`;
  return renderPage({
    ctx,
    title: device.name,
    nav: "devices",
    nodes: [deviceNode(device.id), ...bridged.map(member => deviceNode(member.id))],
    mainAttributes: `data-sensor-page data-device-id="${escapeHtml(device.id)}" data-bridged-serials="${escapeHtml(JSON.stringify(bridged.flatMap(member => member.serialNumber ? [member.serialNumber] : [])))}"`,
    body: `${renderDeviceHead(ctx, device, "controls", `<p class="device-status" aria-live="polite">
        <span class="mark" id="state-mark" data-availability="${escapeHtml(head.availability)}" aria-hidden="true"></span>
        <span id="state-label"${head.live}>${escapeHtml(head.label)}</span>
        <span class="muted small" id="state-detail"${head.live}>${escapeHtml(head.detail)}</span>
      </p>`)}
      ${composed ? `<p class="muted">${escapeHtml(t("sensor.device"))} · ${escapeHtml(device.modelTitle)}</p>` : ""}
      ${composed ? `<section aria-labelledby="sensors-heading"><h2 id="sensors-heading">${escapeHtml(t("sensor.components"))}</h2><div id="device-sensors" aria-live="polite"></div></section>` : `${ownRow}<dl class="kv" id="sensor-details"></dl>`}
      ${pairing}${sync}${renderBridgedDevices(ctx, bridged)}`,
    css: `#device-sensors { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 13rem), 1fr)); gap: var(--s3); }
      .sensor-component { border-block-start: var(--rule-w) solid var(--rule); padding-block: var(--s3); }
      .sensor-component h3 { margin: 0; } .sensor-component p { margin-block: var(--s1); }
      .sensor-component .sensor-value { font-size: 2rem; font-variant-numeric: tabular-nums; margin-block: var(--s3); }
      ${SENSOR_LIST_CSS}
      `,
    script: SENSOR_SCRIPT,
    messages: ["sensor."],
  });
}
