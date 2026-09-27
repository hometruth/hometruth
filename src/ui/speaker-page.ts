import type { HomeTruthObject } from "../schemas";
import { deviceNode } from "../state/protocol";
import type { RegisteredDevice } from "../site";
import { deviceNav, escapeHtml, renderDeviceHead, renderPage, type PageContext } from "./shell";
import { renderStateLine } from "./switch-page";

export interface SpeakerPageOptions {
  ctx: PageContext;
  device: RegisteredDevice;
}

/** The generic device/capability routes this page drives; see server/app.ts. */
export const SPEAKER_API = {
  state: "/api/devices/:id",
  control: "/api/devices/:id/capabilities/speaker/controls/:controlId",
} as const;

const SPEAKER_SCRIPT = String.raw`
  (() => {
    const root = document.querySelector("[data-speaker-page]");
    if (!(root instanceof HTMLElement)) return;
    const id = encodeURIComponent(root.dataset.deviceId || "");
    const api = JSON.parse(root.dataset.api || "{}");
    const stateUrl = api.state.replace(":id", id);
    const controlUrl = (controlId) => api.control.replace(":id", id).replace(":controlId", controlId);
    const mark = document.querySelector("#state-mark");
    const label = document.querySelector("#state-label");
    const detail = document.querySelector("#state-detail");
    const groupLine = document.querySelector("#group-line");
    const volume = document.querySelector("#volume");
    const volumeOutput = document.querySelector("#volume-value");
    const feedback = document.querySelector("#feedback");
    const sayInput = document.querySelector("#say-text");
    const buttons = Array.from(document.querySelectorAll("button[data-action]"));
    const setBusy = (busy) => { for (const button of buttons) button.disabled = busy; };
    const playbackLabel = (playback) => playback === "playing" ? ht.t("speaker.playing") : playback === "paused" ? ht.t("speaker.paused") : playback === "stopped" ? ht.t("speaker.stopped") : playback === "transitioning" ? ht.t("speaker.transitioning") : ht.t("status.unknown");
    const show = (body) => {
      const speaker = body && body.object && body.object.capabilities ? body.object.capabilities.speaker : undefined;
      const state = speaker ? speaker.state : undefined;
      const availability = state ? state.availability : "unknown";
      if (mark instanceof HTMLElement) mark.dataset.availability = availability;
      if (label instanceof HTMLElement) label.textContent = availability !== "online" ? ht.availability(availability) : playbackLabel(state.playback);
      if (detail instanceof HTMLElement) detail.textContent = availability === "online" && state.observedAt ? ht.t("status.readAt", { time: ht.time(state.observedAt) }) : (state && state.detail ? state.detail : availability === "offline" ? ht.t("status.notReachable") : "");
      if (volume instanceof HTMLInputElement && state && typeof state.volumePercent === "number") {
        volume.value = String(state.volumePercent);
        if (volumeOutput instanceof HTMLElement) volumeOutput.textContent = ht.number(state.volumePercent / 100, { style: "percent" });
      }
      if (groupLine instanceof HTMLElement) {
        groupLine.textContent = state && state.group
          ? (state.group.isCoordinator ? ht.t("speaker.coordinator") : ht.t("speaker.groupedWith", { host: state.group.coordinatorHost })) + (state.group.memberHosts ? " · " + ht.t("speaker.members", { count: state.group.memberHosts.length }) : "")
          : "";
      }
      ht.say(feedback, "");
    };
    const fail = (error) => ht.say(feedback, error instanceof Error ? error.message : ht.t("feedback.noResponse"), "bad");
    const refresh = async () => show(await ht.request(stateUrl));
    const control = async (controlId, value) => {
      setBusy(true);
      try {
        show(await ht.request(controlUrl(controlId), { method: "POST", body: JSON.stringify(value === undefined ? {} : { value }) }));
      } catch (error) {
        fail(error);
      } finally {
        setBusy(false);
      }
    };
    for (const button of buttons) {
      button.addEventListener("click", () => {
        const action = button.dataset.action;
        if (action === "refresh") return refresh().catch(fail);
        if (action === "play" || action === "pause" || action === "stop" || action === "leaveGroup") return control(action);
        if (action === "say") {
          const text = sayInput instanceof HTMLInputElement ? sayInput.value.trim() : "";
          if (!text) return;
          return control("say", text);
        }
      });
    }
    if (volume instanceof HTMLInputElement) {
      volume.addEventListener("input", () => { if (volumeOutput instanceof HTMLElement) volumeOutput.textContent = ht.number(Number(volume.value) / 100, { style: "percent" }); });
      volume.addEventListener("change", () => control("setVolume", Number(volume.value)));
    }
    const connect = () => {
      if (!ht.state) { requestAnimationFrame(connect); return; }
      ht.state.subscribe('device/' + root.dataset.deviceId, record => {
        ht.live(label, record.observedAt); ht.live(volumeOutput, record.observedAt); ht.live(groupLine, record.observedAt);
        if (record.value) show({ object: record.value });
        if (record.fault) { if (mark) mark.dataset.availability = 'offline'; if (label) label.textContent = ht.t('status.offline'); if (detail) detail.textContent = record.fault.message; }
      }, 'live');
    };
    connect();
  })();
`;

/** Controls for a device whose schema includes the Speaker capability document. */
export function renderSpeakerPage({ ctx, device }: SpeakerPageOptions): string {
  const { t } = ctx.i18n;
  const record = ctx.state.snapshot([deviceNode(device.id)])[0];
  const state = (record?.value as HomeTruthObject | undefined)?.capabilities.speaker?.state;
  const availability = record?.fault ? "offline" : state?.availability ?? "unknown";
  const label = availability === "online" && state?.playback && state.playback !== "unknown" ? t(`speaker.${state.playback}`) : t(`status.${availability}`);
  const group = state?.group ? (state.group.isCoordinator ? t("speaker.coordinator") : t("speaker.groupedWith", { host: state.group.coordinatorHost })) + (state.group.memberHosts ? ` · ${t("speaker.members", { count: state.group.memberHosts.length })}` : "") : "";
  return renderPage({
    nodes: [deviceNode(device.id)],
    ctx,
    title: device.name,
    nav: deviceNav(device),
    mainAttributes: `data-speaker-page data-device-id="${escapeHtml(device.id)}" data-api="${escapeHtml(JSON.stringify(SPEAKER_API))}"`,
    body: `${renderDeviceHead(ctx, device, "controls")}
      ${renderStateLine(ctx, { availability, label, detail: record?.fault?.message ?? (record?.observedAt ? t("status.readAt", { time: ctx.i18n.dateTime(record.observedAt) }) : "") })}
      <div class="bar">
        <button type="button" class="btn btn-primary" data-action="play">${escapeHtml(t("action.play"))}</button>
        <button type="button" class="btn" data-action="pause">${escapeHtml(t("action.pause"))}</button>
        <button type="button" class="btn" data-action="stop">${escapeHtml(t("action.stop"))}</button>
        <button type="button" class="btn" data-action="leaveGroup">${escapeHtml(t("speaker.leaveGroup"))}</button>
        <button type="button" class="btn" data-action="refresh">${escapeHtml(t("action.refresh"))}</button>
      </div>
      <div class="field">
        <label class="field-value" for="volume">${escapeHtml(t("speaker.volume"))} <output id="volume-value" for="volume">${state?.volumePercent === undefined ? "—" : escapeHtml(ctx.i18n.number(state.volumePercent / 100, { style: "percent" }))}</output></label>
        <input type="range" id="volume" min="0" max="100" value="${state?.volumePercent ?? 0}">
      </div>
      <div class="field">
        <label for="say-text">${escapeHtml(t("speaker.say"))}</label>
        <div class="field-row"><input type="text" id="say-text" placeholder="${escapeHtml(t("speaker.sayPlaceholder"))}" maxlength="500"><button type="button" class="btn" data-action="say">${escapeHtml(t("speaker.say"))}</button></div>
      </div>
      <p class="note" id="group-line">${escapeHtml(group)}</p>
      <p class="feedback" id="feedback" role="status" aria-live="polite"></p>`,
    script: SPEAKER_SCRIPT,
    messages: ["speaker."],
  });
}
