import type { NetworkAddressClient } from "../network/adapter";
import { isIPv4 } from "node:net";
import type { MatterBridgeSettings } from "../integrations/matter/settings";
import { schemaPagePath } from "../schema-catalog";
import type { RegisteredDevice } from "../site";
import { renderRoomPicker, ROOM_PICKER_SCRIPT } from "./room-picker";
import { capabilityLabel, deviceConnectionLabel, deviceNav, escapeHtml, renderDeviceHead, renderPage, type PageContext } from "./shell";
import { SWITCH_DEFINITION_CSS } from "./switch-definition";

export interface DeviceSettingsPageOptions {
  ctx: PageContext;
  device: RegisteredDevice;
  matter?: MatterBridgeSettings;
  matterError?: string;
  switchDefinition?: string;
  networkClients?: readonly NetworkAddressClient[];
  networkMac?: string | undefined;
  networkWritable?: boolean;
}

const SETTINGS_CSS = String.raw`
  .qr { display: block; width: min(16rem, 100%); background: #fff; padding: var(--s2); border: var(--rule-w) solid var(--rule); }
  .manual-code { font-family: var(--font-mono); font-size: 1.25rem; letter-spacing: .1em; overflow-wrap: anywhere; }
  .pairing { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--s4); align-items: start; }
  @media (max-width: 36rem) { .pairing { grid-template-columns: 1fr; } }
`;

/** Rename and Wi-Fi reconnect; the room form has its own script. */
const SETTINGS_SCRIPT = String.raw`
  (() => {
    const renameForm = document.querySelector("[data-device-rename]");
    if (renameForm instanceof HTMLFormElement) {
      const input = renameForm.elements.namedItem("name");
      const button = renameForm.querySelector("button[type=submit]");
      const feedback = renameForm.querySelector("[data-device-rename-feedback]");
      renameForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!(input instanceof HTMLInputElement)) return;
        const name = input.value.trim();
        if (!name) return;
        if (button instanceof HTMLButtonElement) button.disabled = true;
        ht.say(feedback, ht.t("feedback.saving"));
        try {
          const result = await ht.request("/api/devices/" + encodeURIComponent(renameForm.dataset.deviceId || "") + "/name", { method: "POST", body: JSON.stringify({ name }) });
          ht.say(feedback, ht.t("feedback.savedReloading"), "ok");
          window.location.assign(result.page + "/settings");
        } catch (error) {
          ht.say(feedback, error instanceof Error ? error.message : ht.t("settings.nameFailed"), "bad");
          if (button instanceof HTMLButtonElement) button.disabled = false;
        }
      });
    }
    const enabledToggle = document.querySelector("[data-device-enabled]");
    if (enabledToggle instanceof HTMLInputElement) {
      const feedback = document.querySelector("[data-device-enabled-feedback]");
      enabledToggle.addEventListener("change", async () => {
        const enabled = enabledToggle.checked;
        enabledToggle.disabled = true;
        ht.say(feedback, ht.t("feedback.saving"));
        try {
          enabledToggle.checked = await ht.request("/api/devices/" + encodeURIComponent(enabledToggle.dataset.deviceId || "") + (enabled ? "/enable" : "/disable"), { method: "POST", headers: { "content-type": "application/json" } });
          ht.say(feedback, enabled ? ht.t("settings.enabled.enabledOk") : ht.t("settings.enabled.disabledOk"), "ok");
        } catch (error) {
          enabledToggle.checked = !enabled;
          ht.say(feedback, error instanceof Error ? error.message : ht.t("settings.enabled.failed"), "bad");
        } finally {
          enabledToggle.disabled = false;
        }
      });
    }
    const reconnect = document.querySelector("[data-network-reconnect]");
    const status = document.querySelector("[data-network-reconnect-feedback]");
    if (reconnect instanceof HTMLButtonElement) {
      const id = encodeURIComponent(reconnect.dataset.deviceId || "");
      reconnect.addEventListener("click", async () => {
        reconnect.disabled = true;
        ht.say(status, ht.t("settings.network.asking"));
        try {
          const payload = await ht.request("/api/devices/" + id + "/network/reconnect", { method: "POST", body: "{}" });
          ht.say(status, payload.message || ht.t("settings.network.requested"), "ok");
          window.setTimeout(() => window.location.reload(), 5000);
        } catch (error) {
          ht.say(status, error instanceof Error ? error.message : ht.t("settings.network.failed"), "bad");
          reconnect.disabled = false;
        }
      });
    }
    const rescan = document.querySelector("[data-network-rescan]");
    if (rescan instanceof HTMLButtonElement) {
      const id = encodeURIComponent(rescan.dataset.deviceId || "");
      const line = (result) => {
        const values = { name: result.name, address: result.currentAddress || result.address, previous: result.address, mac: result.mac || "", detail: result.detail || "" };
        const key = { moved: "rescan.moved", identified: "rescan.identified", missing: "rescan.missing", unidentified: "rescan.unidentified", ambiguous: "rescan.ambiguous", failed: "rescan.failed", unchanged: "rescan.unchanged" }[result.outcome];
        return key ? ht.t(key, values) : result.detail || "";
      };
      rescan.addEventListener("click", async () => {
        rescan.disabled = true;
        ht.say(status, ht.t("rescan.running"));
        try {
          const payload = await ht.request("/api/devices/" + id + "/network/rescan", { method: "POST", body: "{}" });
          const result = payload.result || {};
          const good = result.outcome === "moved" || result.outcome === "identified" || result.outcome === "unchanged";
          ht.say(status, line(result), good ? "ok" : "bad");
          if (result.outcome === "moved") {
            ht.say(status, line(result) + " " + ht.t("rescan.reloading"), "ok");
            window.setTimeout(() => window.location.reload(), 1500);
            return;
          }
        } catch (error) {
          ht.say(status, error instanceof Error && error.message ? error.message : ht.t("rescan.unavailable"), "bad");
        }
        rescan.disabled = false;
      });
    }
    const form = document.querySelector("[data-ip-settings]");
    if (!(form instanceof HTMLFormElement)) return;
    const select = form.elements.namedItem("mac");
    const address = form.elements.namedItem("address");
    const submit = form.querySelector("button[type=submit]");
    const ipStatus = form.querySelector("[data-ip-status]");
    const detail = form.querySelector("[data-ip-detail]");
    if (!(select instanceof HTMLSelectElement) || !(address instanceof HTMLInputElement)) return;
    const url = "/api/devices/" + encodeURIComponent(form.dataset.deviceId) + "/network/settings";
    const clients = JSON.parse(form.querySelector("[data-network-clients]").textContent);
    const selected = () => {
      const client = clients.find((row) => row.mac === select.value);
      detail.textContent = client
        ? ht.t("settings.ip.current", { address: client.address, reserved: client.fixedAddress || ht.t("settings.ip.none"), network: (client.network || client.ssid || ht.t("settings.ip.unknown")) + (client.subnet ? " (" + client.subnet + ")" : "") })
        : ht.t("settings.ip.selectHint");
      submit.disabled = !client;
    };
    select.addEventListener("change", selected);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      submit.disabled = true;
      ht.say(ipStatus, ht.t("feedback.saving"));
      try {
        const body = await ht.request(url, { method: "POST", body: JSON.stringify({ address: address.value.trim(), mac: select.value }) });
        ht.say(ipStatus, body.message, "ok");
        detail.textContent = ht.t("settings.ip.reserved", { address: body.address, mac: body.mac });
        select.disabled = true;
      } catch (error) { ht.say(ipStatus, error.message || ht.t("settings.ip.saveFailed"), "bad"); }
      finally { submit.disabled = false; }
    });
  })();
`;

function renderAppleHome(ctx: PageContext, device: RegisteredDevice, matter?: MatterBridgeSettings, matterError?: string): string {
  const { t } = ctx.i18n;
  const section = (inner: string) => `<section aria-labelledby="apple-home-title"><h2 id="apple-home-title">${escapeHtml(t("settings.apple.title"))}</h2>${inner}</section>`;
  if (!device.capabilities.includes("binarySwitch")) return section(`<p class="note">${escapeHtml(t("settings.apple.notExported"))}</p>`);
  if (!matter?.qrCodeDataUrl) return section(`<p class="feedback" data-tone="bad">${escapeHtml(matterError ?? t("settings.apple.noCode"))}</p>`);
  const included = matter.switchIds.includes(device.id);
  const updated = matter.updatedAt ? `<p class="note">${escapeHtml(t("settings.apple.updated", { time: ctx.i18n.dateTime(matter.updatedAt) }))}</p>` : "";
  if (matter.commissioned) {
    return section(`
      <p class="status" data-availability="${matter.running ? "online" : "offline"}"><span class="mark" data-availability="${matter.running ? "online" : "offline"}" aria-hidden="true"></span>${escapeHtml(matter.running ? t("settings.apple.paired") : t("settings.apple.pairedStopped"))}</p>
      <p>${escapeHtml(included ? t("settings.apple.included") : t("settings.apple.pending"))} ${escapeHtml(t("settings.apple.roomsNote"))}</p>
      <p class="note">${escapeHtml(t("settings.apple.dontScan"))}</p>
      <details><summary>${escapeHtml(t("settings.apple.showCode"))}</summary><img class="qr" data-matter-pairing-qr src="${escapeHtml(matter.qrCodeDataUrl)}" alt="${escapeHtml(t("settings.apple.qrAlt"))}"></details>
      ${updated}`);
  }
  return section(`
    <div class="pairing">
      <img class="qr" data-matter-pairing-qr src="${escapeHtml(matter.qrCodeDataUrl)}" alt="${escapeHtml(t("settings.apple.qrAlt"))}">
      <div>
        <p class="status" data-availability="${matter.running ? "online" : "offline"}"><span class="mark" data-availability="${matter.running ? "online" : "offline"}" aria-hidden="true"></span>${escapeHtml(matter.running ? t("settings.apple.ready") : t("settings.apple.stopped"))}</p>
        <p>${escapeHtml(t("settings.apple.scanOnce"))} ${escapeHtml(t("settings.apple.roomsNote"))}</p>
        ${matter.manualPairingCode ? `<p class="muted small">${escapeHtml(t("settings.apple.manualCode"))}</p><p class="manual-code">${escapeHtml(matter.manualPairingCode)}</p>` : ""}
        ${updated}
      </div>
    </div>`);
}

function renderIpSettings(ctx: PageContext, device: RegisteredDevice, clients: readonly NetworkAddressClient[], mac: string | undefined, writable: boolean): string {
  const { t } = ctx.i18n;
  if (!isIPv4(device.host)) return "";
  const matches = clients.filter(client => mac ? client.mac === mac.toLowerCase() : [client.address, client.fixedAddress, client.lastAddress].includes(device.host));
  const selected = mac?.toLowerCase() ?? (matches.length === 1 ? matches[0]!.mac : undefined);
  const client = clients.find(client => client.mac === selected);
  const choices = [...clients].filter(client => !selected || client.mac === selected).sort((a, b) => (a.name || a.hostname || a.mac).localeCompare(b.name || b.hostname || b.mac, ctx.i18n.locale));
  const detail = client ? t("settings.ip.current", { address: client.address, reserved: client.fixedAddress || t("settings.ip.none"), network: (client.network || client.ssid || t("settings.ip.unknown")) + (client.subnet ? " (" + client.subnet + ")" : "") }) : t("settings.ip.selectHint");
  return `<section aria-labelledby="ip-settings-title">
    <h2 id="ip-settings-title">${escapeHtml(t("settings.ip.title"))}</h2>
    <form data-ip-settings data-device-id="${escapeHtml(device.id)}">
      <script type="application/json" nonce="${escapeHtml(ctx.nonce)}" data-network-clients>${JSON.stringify(clients).replaceAll("<", "\\u003c")}</script>
      <label class="field"><span>${escapeHtml(t("settings.ip.device"))}</span><select name="mac" required${selected || !writable ? " disabled" : ""}><option value="">${escapeHtml(t("settings.ip.choose"))}</option>${choices.map(client => `<option value="${escapeHtml(client.mac)}"${client.mac === selected ? " selected" : ""}>${escapeHtml((client.name || client.hostname || client.mac) + " · " + client.mac + " · " + client.address)}</option>`).join("")}</select></label>
      <p class="note" data-ip-detail>${escapeHtml(detail)}</p>
      <label class="field"><span>${escapeHtml(t("settings.ip.address"))}</span><input name="address" class="mono" value="${escapeHtml(device.host)}" required inputmode="decimal" autocomplete="off" spellcheck="false"></label>
      <div class="bar"><button type="submit" class="btn btn-primary"${!writable || !client ? " disabled" : ""}>${escapeHtml(t("settings.ip.save"))}</button></div>
      <p class="feedback" data-ip-status role="status" aria-live="polite">${writable ? "" : escapeHtml(t("settings.ip.unavailable"))}</p>
    </form>
  </section>`;
}

function renderIdentity(ctx: PageContext, device: RegisteredDevice): string {
  const { t } = ctx.i18n;
  const lightSync = device.capabilities.includes("camera") ? ` · <a href="${escapeHtml(device.page)}/light-sync">${escapeHtml(t("lightSync.link"))}</a>` : "";
  const connection = deviceConnectionLabel(ctx, device);
  const schemaLink = (schemaId: string) => {
    const page = schemaPagePath(schemaId);
    return page ? `<a href="${escapeHtml(page)}">${escapeHtml(schemaId)}</a>` : escapeHtml(schemaId);
  };
  return `<section aria-labelledby="identity-title">
    <h2 id="identity-title">${escapeHtml(t("settings.identity.title"))}</h2>
    <dl class="kv" data-model="${escapeHtml(device.model)}">
      <dt>${escapeHtml(t("device.model"))}</dt><dd>${escapeHtml(device.modelTitle)} <span class="muted mono small">${escapeHtml(device.model)}</span></dd>
      ${device.capabilities.length ? `<dt>${escapeHtml(t("device.capabilities"))}</dt><dd>${escapeHtml(device.capabilities.map((kind) => capabilityLabel(ctx, kind)).join(" + "))}</dd>` : ""}
      ${(device.sensors ?? []).map(sensor => `<dt>${escapeHtml(sensor.name)}</dt><dd>${schemaLink(sensor.schemaId)}</dd>`).join("")}
      ${connection ? `<dt>${escapeHtml(t("device.connection"))}</dt><dd data-connection-types>${escapeHtml(connection)}</dd>` : ""}
      <dt>${escapeHtml(t("device.address"))}</dt><dd class="mono">${escapeHtml(device.host)}</dd>
      <dt>${escapeHtml(t("device.id"))}</dt><dd class="mono">${escapeHtml(device.id)}</dd>
      <dt>${escapeHtml(t("device.schema"))}</dt><dd>${schemaLink(device.schemaId)}</dd>
      <dt>${escapeHtml(t("device.json"))}</dt><dd><a href="/api/devices/${encodeURIComponent(device.id)}">/api/devices/${escapeHtml(device.id)}</a>${lightSync}</dd>
    </dl>
  </section>`;
}

/** Every device gets this settings surface; exportable devices also get their pairing code. */
export function renderDeviceSettingsPage({ ctx, device, matter, matterError, switchDefinition = "", networkClients = [], networkMac, networkWritable = false }: DeviceSettingsPageOptions): string {
  const { t } = ctx.i18n;
  return renderPage({
    ctx,
    title: `${t("settings.title")} · ${device.name}`,
    nav: deviceNav(device),
    css: SETTINGS_CSS + SWITCH_DEFINITION_CSS,
    mainAttributes: `data-device-settings data-device-id="${escapeHtml(device.id)}"`,
    body: `${renderDeviceHead(ctx, device, "settings")}
      ${switchDefinition}
      <section aria-labelledby="name-title">
        <h2 id="name-title">${escapeHtml(t("settings.name"))}</h2>
        <form data-device-rename data-device-id="${escapeHtml(device.id)}">
          <div class="field-row"><input name="name" aria-label="${escapeHtml(t("settings.name"))}" value="${escapeHtml(device.name)}" required maxlength="200" autocomplete="off"><button type="submit" class="btn">${escapeHtml(t("settings.saveName"))}</button></div>
          <output class="feedback" data-device-rename-feedback role="status" aria-live="polite"></output>
        </form>
      </section>
      <section aria-labelledby="room-title">
        <h2 id="room-title">${escapeHtml(t("room.label"))}</h2>
        ${renderRoomPicker(ctx, device)}
      </section>
      <section aria-labelledby="enabled-title">
        <h2 id="enabled-title">${escapeHtml(t("settings.enabled.title"))}</h2>
        <label class="field-row"><input type="checkbox" data-device-enabled data-device-id="${escapeHtml(device.id)}" ${device.enabled ? "checked" : ""}> ${escapeHtml(t("settings.enabled.label"))}</label>
        <p class="note">${escapeHtml(t("settings.enabled.hint"))}</p>
        <output class="feedback" data-device-enabled-feedback role="status" aria-live="polite"></output>
      </section>
      ${device.parent ? "" : `<section aria-labelledby="network-title">
        <h2 id="network-title">${escapeHtml(t("settings.network.title"))}</h2>
        <div class="bar"><button type="button" class="btn" data-network-reconnect data-device-id="${escapeHtml(device.id)}" title="${escapeHtml(t("settings.network.reconnectHint"))}">${escapeHtml(t("settings.network.reconnect"))}</button><button type="button" class="btn" data-network-rescan data-device-id="${escapeHtml(device.id)}" title="${escapeHtml(t("rescan.deviceHint"))}">${escapeHtml(t("rescan.device"))}</button></div>
        <p class="feedback" data-network-reconnect-feedback role="status" aria-live="polite"></p>
      </section>
      ${renderIpSettings(ctx, device, networkClients, networkMac, networkWritable)}`}
      ${renderAppleHome(ctx, device, matter, matterError)}
      ${renderIdentity(ctx, device)}`,
    script: SETTINGS_SCRIPT + ROOM_PICKER_SCRIPT,
    messages: ["settings.network.", "settings.ip.", "settings.enabled.", "settings.nameFailed", "room.", "rescan."],
  });
}
