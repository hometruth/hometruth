import type { WifiAdmissionSetup } from "../network/wifi-admission-command";
import type { WifiAdmissionRun } from "../network/wifi-admission-service";
import { escapeHtml as esc, renderPage, type PageContext } from "./shell";

export interface WifiAdmissionPageOptions {
  ctx: PageContext;
  setup?: WifiAdmissionSetup;
  run?: WifiAdmissionRun;
  error?: string;
}

const SCRIPT = String.raw`
(() => {
  const root = document.querySelector("[data-wifi-admission]");
  if (!root) return;
  const api = "/api/network/commands/accept-next";
  let setup = JSON.parse(root.dataset.setup || "null");
  let current = JSON.parse(root.dataset.run || "null");
  let busy = false;
  let mutation = 0;
  let connected = true;
  let lastRender = "";
  const form = document.querySelector("#admission-form");
  const ssid = document.querySelector("#admission-ssid");
  const duration = document.querySelector("#admission-duration");
  const runButton = document.querySelector("#admission-run");
  const cancel = document.querySelector("#admission-cancel");
  const recover = document.querySelector("#admission-recover");
  const feedback = document.querySelector("#admission-feedback");
  const activity = document.querySelector("#admission-activity");
  const active = () => current && ["running", "stopping"].includes(current.status);
  const errorMessage = error => error instanceof Error ? error.message : ht.t("networkCommand.failed");
  function controls() {
    const network = setup?.networks.find(n => n.ssid === ssid.value);
    runButton.disabled = busy || !connected || active() || !!setup?.recovery || !network?.available;
    ssid.disabled = busy || active();
    duration.disabled = busy || active();
    cancel.hidden = !active() || !!current?.recovery;
    cancel.disabled = busy || current?.status === "stopping";
    recover.hidden = !setup?.recovery || setup.recovery.active || active();
    recover.disabled = busy || !connected;
    document.querySelector("#admission-network-note").textContent = network
      ? ht.t(network.available ? "networkCommand.allowedCount" : "networkCommand.ineligible", { count: network.allowedCount }) : "";
    const recoveryNote = document.querySelector("#admission-recovery-note");
    recoveryNote.hidden = !setup?.recovery || active();
    recoveryNote.textContent = setup?.recovery ? ht.t(setup.recovery.active ? "networkCommand.externalRun" : "networkCommand.recoveryNeeded", { ssid: setup.recovery.ssid }) : "";
  }
  function render(run) {
    current = run;
    if (active()) { ssid.value = current.ssid; duration.value = String(current.timeoutSeconds); }
    controls();
    const fingerprint = JSON.stringify(run);
    if (fingerprint === lastRender) return;
    lastRender = fingerprint;
    const status = run?.status === "complete" ? run.result.status : run?.status || "ready";
    document.querySelector("#admission-status-text").textContent = ht.t("networkCommand.state." + status);
    document.querySelector("#admission-status").dataset.availability = active() ? "connecting" : status === "failed" ? "offline" : status === "ready" ? "unknown" : "online";
    document.querySelector("#admission-status .mark").dataset.availability = document.querySelector("#admission-status").dataset.availability;
    const runDetails = document.querySelector("#admission-run-details");
    runDetails.hidden = !run;
    if (run) {
      document.querySelector("#admission-run-network").textContent = run.ssid;
      document.querySelector("#admission-started").textContent = ht.dateTime(run.startedAt);
    }
    const result = document.querySelector("#admission-result");
    result.hidden = !run?.result;
    if (run?.result) document.querySelector("#admission-restored").textContent = ht.t("networkCommand.restored", { count: run.result.allowedCount });
    const joined = document.querySelector("#admission-joined");
    joined.hidden = !run?.result?.client;
    if (run?.result?.client) {
      const client = run.result.client;
      document.querySelector("#admission-device-name").textContent = client.name || ht.t("networkCommand.unnamed");
      document.querySelector("#admission-device-mac").textContent = client.mac;
      document.querySelector("#admission-device-ip").textContent = client.address || ht.t("networkCommand.awaitingAddress");
    }
    const failure = document.querySelector("#admission-error");
    failure.hidden = !run?.error;
    failure.textContent = run?.error || "";
    activity.replaceChildren();
    for (const event of run?.activity || []) {
      const row = document.createElement("li");
      const time = document.createElement("time");
      const message = document.createElement("span");
      row.className = "admission-event";
      time.dateTime = event.at;
      time.textContent = ht.time(event.at);
      message.textContent = event.message;
      row.append(time, message);
      activity.append(row);
    }
    document.querySelector("#admission-empty").hidden = !!run?.activity.length;
  }
  async function refreshSetup() {
    try { setup = await ht.request(api + "/options"); controls(); }
    catch (error) { ht.say(feedback, errorMessage(error), "bad"); }
  }
  async function poll() {
    const version = mutation;
    try {
      const { run } = await ht.request(api);
      if (busy || version !== mutation) return;
      const wasActive = active();
      if (!connected) ht.say(feedback, "");
      connected = true;
      render(run);
      if (wasActive && !active() || setup?.recovery && !active()) await refreshSetup();
    } catch (error) {
      if (busy || version !== mutation) return;
      connected = false;
      controls();
      ht.say(feedback, ht.t("networkCommand.connectionLost"), "bad");
    } finally { window.setTimeout(poll, active() ? 1000 : 3000); }
  }
  async function start(recovery) {
    if (busy || active()) return;
    busy = true;
    mutation++;
    controls();
    ht.say(feedback, "");
    try {
      const body = recovery ? { ssid: setup.recovery.ssid, recover: true }
        : { ssid: ssid.value, timeoutSeconds: Number(duration.value) };
      const { run } = await ht.request(api, { method: "POST", body: JSON.stringify(body) });
      render(run);
    } catch (error) { ht.say(feedback, errorMessage(error), "bad"); }
    finally { busy = false; mutation++; controls(); }
  }
  form.addEventListener("submit", event => { event.preventDefault(); if (form.reportValidity()) void start(false); });
  ssid.addEventListener("change", controls);
  cancel.addEventListener("click", async () => {
    if (!current || busy) return;
    busy = true;
    mutation++;
    controls();
    try { const { run } = await ht.request(api + "/" + encodeURIComponent(current.id) + "/cancel", { method: "POST", body: "{}" }); render(run); }
    catch (error) { ht.say(feedback, errorMessage(error), "bad"); }
    finally { busy = false; mutation++; controls(); }
  });
  recover.addEventListener("click", () => void start(true));
  render(current);
  if (!setup) void refreshSetup();
  void poll();
})();
`;

export function renderWifiAdmissionPage({ ctx, setup, run, error }: WifiAdmissionPageOptions): string {
  const { t } = ctx.i18n;
  const busy = run?.status === "running" || run?.status === "stopping";
  const stateKeys = { running: "networkCommand.state.running", stopping: "networkCommand.state.stopping", complete: "networkCommand.state.accepted", failed: "networkCommand.state.failed" } as const;
  const resultKeys = { accepted: "networkCommand.state.accepted", timeout: "networkCommand.state.timeout", cancelled: "networkCommand.state.cancelled", restored: "networkCommand.state.restored", "dry-run": "networkCommand.state.ready" } as const;
  const label = t(run?.result ? resultKeys[run.result.status] : run ? stateKeys[run.status] : "networkCommand.state.ready");
  const client = run?.result?.client;
  return renderPage({ ctx, title: t("networkCommand.title"), nav: "network",
    mainAttributes: `data-wifi-admission data-setup="${esc(JSON.stringify(setup ?? null))}" data-run="${esc(JSON.stringify(run ?? null))}"`,
    body: `<h1>${esc(t("networkCommand.title"))}</h1>
      <p><a href="/network-isolation">${esc(t("networkCommand.back"))}</a></p>
      <p>${esc(t("networkCommand.intro"))}</p>
      ${!setup ? `<p class="feedback" data-tone="bad">${esc(error ?? t("networkCommand.unavailable"))}</p>` : ""}
      <form id="admission-form">
        <div class="admission-fields">
          <label class="field"><span id="admission-ssid-label">${esc(t("networkCommand.network"))}</span><select id="admission-ssid" aria-labelledby="admission-ssid-label" required${busy ? " disabled" : ""}>
            <option value="">${esc(t("networkCommand.choose"))}</option>
            ${(setup?.networks ?? []).map(network => `<option value="${esc(network.ssid)}"${network.ssid === run?.ssid ? " selected" : ""}${!network.available && network.ssid !== run?.ssid ? " disabled" : ""}>${esc(network.ssid)}</option>`).join("")}
          </select></label>
          <label class="field"><span>${esc(t("networkCommand.duration"))}</span><input id="admission-duration" type="number" min="10" max="600" step="1" required value="${run?.timeoutSeconds ?? 180}"${busy ? " disabled" : ""}></label>
        </div>
        <p class="note" id="admission-network-note"></p>
        <div class="bar"><button class="btn" id="admission-cancel" type="button"${busy && !run?.recovery ? "" : " hidden"}>${esc(t("networkCommand.cancel"))}</button>
          <button class="btn btn-primary" id="admission-run" type="submit" disabled>${esc(t("networkCommand.run"))}</button></div>
      </form>
      <p class="note" id="admission-recovery-note" hidden></p>
      <button class="btn" id="admission-recover" type="button" hidden>${esc(t("networkCommand.recover"))}</button>
      <p class="feedback" id="admission-feedback" role="status" aria-live="polite"></p>
      <section aria-labelledby="admission-status-heading"><h2 id="admission-status-heading">${esc(t("networkCommand.status"))}</h2>
        <p class="status" id="admission-status" data-availability="${busy ? "connecting" : run?.status === "failed" ? "offline" : run?.result ? "online" : "unknown"}" role="status" aria-live="polite"><span class="mark" data-availability="${busy ? "connecting" : run?.status === "failed" ? "offline" : run?.result ? "online" : "unknown"}" aria-hidden="true"></span><span id="admission-status-text">${esc(label)}</span></p>
        <dl class="kv" id="admission-run-details"${run ? "" : " hidden"}><dt>${esc(t("networkCommand.network"))}</dt><dd id="admission-run-network">${esc(run?.ssid ?? "")}</dd><dt>${esc(t("networkCommand.started"))}</dt><dd id="admission-started">${run ? esc(ctx.i18n.dateTime(run.startedAt)) : ""}</dd></dl>
        <p class="feedback" data-tone="bad" id="admission-error"${run?.error ? "" : " hidden"}>${esc(run?.error ?? "")}</p>
        <div id="admission-result"${run?.result ? "" : " hidden"}><p id="admission-restored">${run?.result ? esc(t("networkCommand.restored", { count: run.result.allowedCount })) : ""}</p></div>
      </section>
      <section id="admission-joined"${client ? "" : " hidden"} aria-labelledby="admission-joined-heading"><h2 id="admission-joined-heading">${esc(t("networkCommand.joined"))}</h2>
        <dl class="kv"><dt>${esc(t("networkCommand.deviceName"))}</dt><dd id="admission-device-name">${esc(client?.name ?? t("networkCommand.unnamed"))}</dd>
          <dt>${esc(t("networkCommand.mac"))}</dt><dd class="mono" id="admission-device-mac">${esc(client?.mac ?? "")}</dd>
          <dt>${esc(t("networkCommand.ip"))}</dt><dd class="mono" id="admission-device-ip">${esc(client?.address ?? t("networkCommand.awaitingAddress"))}</dd></dl>
      </section>
      <section aria-labelledby="admission-activity-heading"><h2 id="admission-activity-heading">${esc(t("networkCommand.activity"))}</h2>
        <p class="empty" id="admission-empty"${run?.activity.length ? " hidden" : ""}>${esc(t("networkCommand.empty"))}</p>
        <ol class="admission-activity" id="admission-activity" role="log" aria-live="polite">${(run?.activity ?? []).map(event => `<li class="admission-event"><time datetime="${esc(event.at)}">${esc(ctx.i18n.time(event.at))}</time><span>${esc(event.message)}</span></li>`).join("")}</ol>
      </section>`,
    css: `.admission-fields{display:grid;grid-template-columns:minmax(0,1fr) minmax(8rem,12rem);gap:var(--s4)}
      .admission-activity{list-style:none;padding:0;margin-block:0}
      .admission-event{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:var(--s3);padding-block:var(--s3);border-block-end:1px solid var(--hair);overflow-wrap:anywhere}
      .admission-event time{font-size:.875rem;color:var(--fg-2);font-variant-numeric:tabular-nums}
      #admission-joined dd,#admission-run-details dd{overflow-wrap:anywhere}
      @media(max-width:30rem){.admission-fields,.admission-event{grid-template-columns:1fr}}`,
    script: SCRIPT, messages: ["networkCommand."],
  });
}
