import { isIPv4 } from "node:net";
import type { NetworkAddressClient } from "../network/adapter";
import type { IsolationStatus } from "../network/isolation";
import type { RegisteredDevice } from "../site";
import { escapeHtml, type PageContext } from "./shell";

/** Show only this device's network identity; never guess among address matches. */
export function renderDeviceNetwork(ctx: PageContext, device: RegisteredDevice, clients: readonly NetworkAddressClient[], mac?: string, isolation?: IsolationStatus): string {
  if (!isIPv4(device.host)) return "";
  const { t } = ctx.i18n;
  const matches = clients.filter(client => mac ? client.mac.toLowerCase() === mac.toLowerCase()
    : [client.address, client.fixedAddress, client.lastAddress].includes(device.host));
  const client = matches.length === 1 && matches[0]!.connected !== false ? matches[0] : undefined;
  const state = isolation?.devices.find(entry => entry.deviceId === device.id);
  const writable = Boolean(state && isolation?.canIsolate);
  return `<div data-device-network data-device-id="${escapeHtml(device.id)}" data-can-isolate="${writable}">
    <dl class="kv">
      <dt>${escapeHtml(t("settings.network.vlan"))}</dt><dd data-network-vlan>${escapeHtml(client?.vlan === undefined ? t("settings.network.notReported") : String(client.vlan))}</dd>
      <dt>${escapeHtml(t("settings.network.ssid"))}</dt><dd data-network-ssid>${escapeHtml(client?.ssid ?? t("settings.network.notReported"))}</dd>
      <dt>${escapeHtml(t("settings.network.internet"))}</dt><dd data-internet-state role="status">${escapeHtml(t("settings.network.checking"))}</dd>
    </dl>
    <p class="note">${escapeHtml(t("settings.network.isolationHint"))}</p>
    <div class="bar"><button type="button" class="btn" data-device-isolate disabled>${escapeHtml(t("settings.network.block"))}</button></div>
    ${writable ? "" : `<p class="note">${escapeHtml(t("settings.network.isolationUnavailable"))}</p>`}
    <p class="feedback" data-isolation-feedback role="status" aria-live="polite"></p>
  </div>`;
}

export const DEVICE_NETWORK_SCRIPT = String.raw`
  (() => {
    const panel = document.querySelector("[data-device-network]");
    if (!(panel instanceof HTMLElement)) return;
    const button = panel.querySelector("[data-device-isolate]");
    const state = panel.querySelector("[data-internet-state]");
    const feedback = panel.querySelector("[data-isolation-feedback]");
    const vlan = panel.querySelector("[data-network-vlan]");
    const ssid = panel.querySelector("[data-network-ssid]");
    const url = "/api/devices/" + encodeURIComponent(panel.dataset.deviceId);
    const writable = panel.dataset.canIsolate === "true";
    let next = true;
    const show = (rule, requested) => {
      const blocked = rule === "on";
      const known = blocked || rule === "off" || rule === "missing";
      state.textContent = ht.t(blocked ? "settings.network.blocked" : known ? "settings.network.unblocked" : "settings.network.unverified");
      next = !(known ? blocked : requested === true);
      button.textContent = ht.t(next ? "settings.network.block" : "settings.network.allow");
      button.disabled = !writable;
      const mismatch = typeof requested === "boolean" && (!known || requested !== blocked);
      ht.say(feedback, mismatch ? ht.t(requested ? "settings.network.blockPending" : "settings.network.releasePending") : "", mismatch ? "bad" : "");
    };
    const load = async () => {
      const result = await ht.request(url + "/network");
      vlan.textContent = result.vlan === undefined ? ht.t("settings.network.notReported") : String(result.vlan);
      ssid.textContent = result.ssid || ht.t("settings.network.notReported");
      show(result.isolation.internetBlock, result.isolation.requested);
    };
    load().catch((error) => {
      state.textContent = ht.t("settings.network.unverified");
      ht.say(feedback, error instanceof Error ? error.message : ht.t("settings.network.unavailable"), "bad");
    });
    button.addEventListener("click", async () => {
      const isolated = next;
      button.disabled = true;
      ht.say(feedback, ht.t("settings.network.applying"));
      try {
        const result = await ht.request(url + "/isolation", { method: "POST", body: JSON.stringify({ isolated }) });
        const device = result.device;
        show(device?.internetBlock, device?.isolated);
        const applied = isolated ? device?.internetBlock === "on" : device?.internetBlock === "off" || device?.internetBlock === "missing";
        ht.say(feedback, [applied ? ht.t("settings.network.applied") : ht.t(isolated ? "settings.network.blockPending" : "settings.network.releasePending"), device?.detail, result.message].filter(Boolean).join(" "), applied ? "ok" : "bad");
      } catch (error) {
        // A failed response can follow a persisted change. Re-read before retrying.
        await load().catch(() => { state.textContent = ht.t("settings.network.unverified"); });
        ht.say(feedback, error instanceof Error ? error.message : ht.t("settings.network.isolationFailed"), "bad");
      } finally {
        button.disabled = !writable;
      }
    });
  })();
`;
