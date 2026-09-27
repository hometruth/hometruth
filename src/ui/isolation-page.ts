/**
 * The isolation settings page: which devices are cut off from the public
 * internet, and the switch for each.
 *
 * Isolation is configuration, not a running service, so this is a settings
 * page rather than a service's log. What an isolated device does while cut
 * off belongs to whichever service stands in for its cloud, read on that
 * service's page or the device's own.
 */
import type { IsolationStatus } from "../network/isolation";
import type { RegisteredDevice } from "../site";
import { escapeHtml, renderPage, type PageContext } from "./shell";

export interface IsolationPageOptions {
  ctx: PageContext;
  status: IsolationStatus | undefined;
  devices: readonly RegisteredDevice[];
  /** Where a device's events can be read, when a service stands in for its cloud. */
  logPageOf?: (deviceId: string) => string | undefined;
}

/** The device list with a switch each, and the DNS records the isolated ones need. */
export function renderIsolationPanel(ctx: PageContext, status: IsolationStatus | undefined, devices: readonly RegisteredDevice[], logPageOf?: (deviceId: string) => string | undefined): string {
  const { t } = ctx.i18n;
  if (!status) return `<p class="note">${escapeHtml(t("isolation.unchecked"))}</p>`;
  const pageOf = new Map(devices.map((device) => [device.id, device.page]));
  const rows = status.devices.map((device) => {
    const parts = device.isolated
      ? [t("isolation.isolated"), t("isolation.block", { state: device.internetBlock }), t("isolation.capture", { state: device.capture }), device.hostnames.length > 0 ? t("isolation.standsIn", { hosts: device.hostnames.join(", ") }) : t("isolation.nothingStandsIn")]
      : [t("isolation.open"), ...(device.hostnames.length > 0 ? [t("isolation.wouldStandIn", { hosts: device.hostnames.join(", ") })] : [])];
    if (device.detail) parts.push(device.detail);
    const page = pageOf.get(device.deviceId);
    const name = page ? `<a href="${escapeHtml(page)}">${escapeHtml(device.name)}</a>` : escapeHtml(device.name);
    const log = logPageOf?.(device.deviceId);
    const meta = [`<span class="mono">${escapeHtml(device.host)}</span>`, ...(device.mac ? [`<span class="mono">${escapeHtml(device.mac)}</span>`] : []), ...(log ? [`<a href="${escapeHtml(log)}">${escapeHtml(t("isolation.events"))}</a>`] : [])].join(" · ");
    return `<li class="row" data-isolated="${device.isolated}" data-device-id="${escapeHtml(device.deviceId)}">
      <span class="row-name">${name} <span class="muted small">${meta}</span></span>
      <span class="row-meta">${escapeHtml(parts.join(" · "))}</span>
      <span class="row-actions"><button type="button" class="btn${device.isolated ? "" : " btn-primary"}" data-isolate="${device.isolated ? "false" : "true"}" data-name="${escapeHtml(device.name)}"${status.canIsolate ? "" : " disabled"}>${escapeHtml(device.isolated ? t("isolation.release") : t("isolation.isolate"))}</button></span>
    </li>`;
  }).join("");
  const dns = status.dns.length > 0
    ? `<p class="note">${escapeHtml(t("isolation.dns", { ip: status.overrideIp ?? "?" }))}: ${status.dns.map((record) => `${escapeHtml(record.domain)} (${escapeHtml(record.record)}${record.resolvedTo ? `, ${escapeHtml(t("isolation.resolves", { ip: record.resolvedTo }))}` : ""})`).join("; ")}</p>`
    : "";
  const note = status.canIsolate ? "" : `<p class="note">${escapeHtml(t("isolation.adapterCannot", { adapter: status.adapter, detail: status.detail ? `: ${status.detail}` : "" }))}</p>`;
  return `${note}<ul class="rows" id="isolation-devices">${rows || `<li class="empty">${escapeHtml(t("isolation.empty"))}</li>`}</ul>${dns}`;
}

const ISOLATION_SCRIPT = String.raw`
  (() => {
    const list = document.querySelector("#isolation-devices");
    if (!(list instanceof HTMLElement)) return;
    list.addEventListener("click", async (event) => {
      const button = event.target instanceof Element ? event.target.closest("button[data-isolate]") : null;
      if (!(button instanceof HTMLButtonElement)) return;
      const row = button.closest("[data-device-id]");
      const deviceId = row instanceof HTMLElement ? row.dataset.deviceId : "";
      const isolated = button.dataset.isolate === "true";
      const name = button.dataset.name || deviceId;
      if (!window.confirm(ht.t(isolated ? "isolation.confirmIsolate" : "isolation.confirmRelease", { name }))) return;
      const label = button.textContent;
      button.disabled = true;
      button.textContent = ht.t(isolated ? "isolation.isolating" : "isolation.releasing");
      try {
        await ht.request("/api/devices/" + encodeURIComponent(deviceId || "") + "/isolation", { method: "POST", body: JSON.stringify({ isolated }) });
        window.location.reload();
      } catch (error) {
        button.disabled = false;
        button.textContent = label;
        window.alert(error instanceof Error ? error.message : ht.t("isolation.failed"));
      }
    });
  })();
`;

export function renderIsolationPage({ ctx, status, devices, logPageOf }: IsolationPageOptions): string {
  const { t } = ctx.i18n;
  return renderPage({
    ctx,
    title: t("isolation.title"),
    nav: "network",
    body: `<h1>${escapeHtml(t("isolation.title"))}</h1>
      <section aria-labelledby="network-commands"><h2 id="network-commands">${escapeHtml(t("networkCommand.section"))}</h2>
        <ul class="rows"><li><a class="row" href="/network/commands/accept-next"><span class="row-name">${escapeHtml(t("networkCommand.title"))}</span><span class="row-meta">${escapeHtml(t("networkCommand.summary"))}</span><span class="row-side" aria-hidden="true">→</span></a></li></ul>
      </section>
      ${renderIsolationPanel(ctx, status, devices, logPageOf)}`,
    script: ISOLATION_SCRIPT,
    messages: ["isolation."],
  });
}
