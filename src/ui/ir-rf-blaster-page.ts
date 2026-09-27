import type { HomeTruthObject, SavedSignalCode } from "../schemas";
import { deviceNode } from "../state/protocol";
import type { RegisteredDevice } from "../site";
import { escapeHtml, renderDeviceHead, renderPage, type PageContext } from "./shell";
import { renderStateLine } from "./switch-page";

export interface IrRfBlasterPageOptions {
  ctx: PageContext;
  device: RegisteredDevice;
  codes?: readonly SavedSignalCode[];
}

/** The same-origin routes used by the IR/RF blaster page. `:codeId` is filled in per saved button. */
export const IR_RF_BLASTER_API = {
  state: "/api/ir-rf-blasters/:id",
  send: "/api/ir-rf-blasters/:id/send",
  learn: "/api/ir-rf-blasters/:id/learn",
  saveCode: "/api/ir-rf-blasters/:id/codes",
  sendCode: "/api/ir-rf-blasters/:id/codes/:codeId/send",
  updateCode: "/api/ir-rf-blasters/:id/codes/:codeId/update",
  deleteCode: "/api/ir-rf-blasters/:id/codes/:codeId/delete",
} as const;

/** Bounds of the hold fields, in seconds; the API takes whole milliseconds from 0 to 60000. */
const HOLD_MAX_S = 60;

const BLASTER_SCRIPT = String.raw`
  (() => {
    const root = document.querySelector("[data-blaster-page]");
    if (!(root instanceof HTMLElement)) return;
    const id = encodeURIComponent(root.dataset.deviceId || "");
    const api = JSON.parse(root.dataset.api || "{}");
    const url = (route, codeId) => route.replace(":id", id).replace(":codeId", encodeURIComponent(codeId || ""));
    const mark = document.querySelector("#state-mark");
    const label = document.querySelector("#state-label");
    const detail = document.querySelector("#state-detail");
    const feedback = document.querySelector("#feedback");
    const channelSelect = document.querySelector("#send-channel");
    const codeInput = document.querySelector("#send-code");
    const frequencyInput = document.querySelector("#send-frequency");
    const sendDurationInput = document.querySelector("#send-duration");
    const holdMaxSeconds = Number(root.dataset.holdMaxSeconds) || 60;
    const learnChannelSelect = document.querySelector("#learn-channel");
    const learnFrequencyInput = document.querySelector("#learn-frequency");
    const saveNameInput = document.querySelector("#save-name");
    const chips = document.querySelector("#buttons-grid");
    const emptyHint = document.querySelector("#buttons-empty");
    const buttons = Array.from(document.querySelectorAll("button[data-action]"));
    const setBusy = (busy) => { for (const button of buttons) button.disabled = busy; };
    const toggleFrequencyField = (select, field) => {
      if (!(select instanceof HTMLSelectElement) || !(field instanceof HTMLElement)) return;
      field.hidden = select.value !== "radio-frequency";
    };
    const ok = (message) => ht.say(feedback, message, "ok");
    const bad = (message) => ht.say(feedback, message, "bad");
    // Reads a hold field in seconds: whole milliseconds (0 = send once), undefined for blank, or throws.
    const holdMsOf = (input) => {
      if (!(input instanceof HTMLInputElement) || input.value.trim() === "") return undefined;
      const seconds = Number(input.value);
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > holdMaxSeconds) throw new Error(ht.t("blaster.holdRange", { max: holdMaxSeconds }));
      return Math.round(seconds * 1000);
    };
    const secondsText = (ms) => ht.number(ms ? Math.round(ms) / 1000 : 0, { maximumFractionDigits: 1 });
    const holdText = (ms) => (ms ? ht.t("blaster.holdFor", { seconds: secondsText(ms) }) : "");
    const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
    let knownCodes = [];
    const renderCodes = (codes) => {
      knownCodes = codes || [];
      if (!(chips instanceof HTMLElement)) return;
      chips.replaceChildren();
      const list = Array.isArray(codes) ? codes : [];
      if (emptyHint instanceof HTMLElement) emptyHint.hidden = list.length > 0;
      for (const saved of list) {
        const chip = el("div", "chip");
        const defaultMs = typeof saved.durationMs === "number" ? saved.durationMs : 0;
        const press = el("button", "btn", saved.name);
        press.type = "button";
        press.title = (saved.channel === "radio-frequency" && saved.frequencyHz ? ht.t("blaster.radio") + " · " + ht.number(saved.frequencyHz / 1e6, { maximumFractionDigits: 2 }) + " MHz" : ht.t("blaster.infrared")) + " · " + ht.t("blaster.defaultHold", { seconds: secondsText(defaultMs) });
        const hold = el("input");
        hold.type = "number"; hold.step = "0.1"; hold.min = "0"; hold.max = String(holdMaxSeconds);
        hold.value = String(defaultMs / 1000);
        hold.dataset.default = hold.value;
        hold.setAttribute("aria-label", ht.t("blaster.holdLabel", { name: saved.name }));
        const unit = el("span", "unit", "s");
        const setDefault = el("button", "btn", ht.t("blaster.setDefault"));
        setDefault.type = "button";
        setDefault.disabled = true;
        hold.addEventListener("input", () => { setDefault.disabled = hold.value === hold.dataset.default; });
        setDefault.addEventListener("click", () => setDefaultHold(saved.id, saved.name, hold));
        press.addEventListener("click", () => sendSaved(saved.id, saved.name, hold));
        const remove = el("button", "btn btn-danger", "×");
        remove.type = "button";
        remove.setAttribute("aria-label", ht.t("blaster.deleteLabel", { name: saved.name }));
        remove.addEventListener("click", () => deleteSaved(saved.id, saved.name));
        chip.append(press, hold, unit, setDefault, remove);
        chips.appendChild(chip);
      }
    };
    const showState = (document_) => {
      const online = document_ && document_.infrared && document_.infrared.state && document_.infrared.state.availability === "online";
      if (mark instanceof HTMLElement) mark.dataset.availability = online ? "online" : "offline";
      if (label instanceof HTMLElement) label.textContent = online ? ht.t("status.online") : ht.t("status.offline");
      if (detail instanceof HTMLElement) detail.textContent = online ? ht.t("blaster.ready") : ht.t("status.notReachable");
      renderCodes(document_ && document_.codes);
    };
    const fail = (error) => bad(error instanceof Error ? error.message : ht.t("feedback.noResponse"));
    const post = (route, codeId, body) => ht.request(url(route, codeId), { method: "POST", body: JSON.stringify(body || {}) });
    const run = async (work) => {
      setBusy(true);
      try { await work(); } catch (error) { fail(error); } finally { setBusy(false); }
    };
    const refresh = () => run(async () => showState(await ht.request(url(api.state))));
    const radioBody = (select, frequency, body) => {
      if (select instanceof HTMLSelectElement && select.value === "radio-frequency" && frequency instanceof HTMLInputElement && frequency.value) body.frequencyHz = Math.round(Number(frequency.value) * 1e6);
      return body;
    };
    const send = () => {
      const channel = channelSelect instanceof HTMLSelectElement ? channelSelect.value : "infrared";
      const code = codeInput instanceof HTMLTextAreaElement ? codeInput.value.trim() : "";
      if (!code) return bad(ht.t("blaster.enterCode"));
      let durationMs;
      try { durationMs = holdMsOf(sendDurationInput); } catch (error) { return fail(error); }
      const body = radioBody(channelSelect, frequencyInput, { channel, code });
      if (durationMs) body.durationMs = durationMs;
      return run(async () => { showState(await post(api.send, null, body)); ok(ht.t("blaster.sent", { hold: holdText(durationMs) })); });
    };
    const learn = () => {
      const channel = learnChannelSelect instanceof HTMLSelectElement ? learnChannelSelect.value : "infrared";
      const body = radioBody(learnChannelSelect, learnFrequencyInput, { channel });
      ok(ht.t(channel === "radio-frequency" && !body.frequencyHz ? "blaster.holdRemote" : "blaster.pointRemote"));
      return run(async () => {
        const payload = await post(api.learn, null, body);
        if (codeInput instanceof HTMLTextAreaElement) codeInput.value = payload.code || "";
        if (channelSelect instanceof HTMLSelectElement) { channelSelect.value = channel; toggleFrequencyField(channelSelect, frequencyInput); }
        if (payload.frequencyHz && frequencyInput instanceof HTMLInputElement) frequencyInput.value = String(payload.frequencyHz / 1e6);
        ok(ht.t("blaster.captured"));
      });
    };
    const saveCode = () => {
      const name = saveNameInput instanceof HTMLInputElement ? saveNameInput.value.trim() : "";
      const channel = channelSelect instanceof HTMLSelectElement ? channelSelect.value : "infrared";
      const code = codeInput instanceof HTMLTextAreaElement ? codeInput.value.trim() : "";
      if (!name) return bad(ht.t("blaster.nameFirst"));
      if (!code) return bad(ht.t("blaster.codeFirst"));
      let durationMs;
      try { durationMs = holdMsOf(sendDurationInput); } catch (error) { return fail(error); }
      const body = radioBody(channelSelect, frequencyInput, { name, channel, code });
      if (durationMs) body.durationMs = durationMs;
      return run(async () => {
        showState(await post(api.saveCode, null, body));
        if (saveNameInput instanceof HTMLInputElement) saveNameInput.value = "";
        ok(ht.t("blaster.saved", { name }));
      });
    };
    const sendSaved = (codeId, name, holdInput) => {
      let durationMs;
      try { durationMs = holdMsOf(holdInput); } catch (error) { return fail(error); }
      return run(async () => {
        const payload = await post(api.sendCode, codeId, durationMs === undefined ? {} : { durationMs });
        const sent = payload && Array.isArray(payload.codes) ? payload.codes.find((entry) => entry.id === codeId) : undefined;
        const heldMs = durationMs === undefined ? (sent && sent.durationMs) || 0 : durationMs;
        showState(payload);
        ok(ht.t("blaster.sentNamed", { name, hold: holdText(heldMs) }));
      });
    };
    const setDefaultHold = (codeId, name, holdInput) => {
      let durationMs;
      try { durationMs = holdMsOf(holdInput); } catch (error) { return fail(error); }
      if (durationMs === undefined) return bad(ht.t("blaster.enterHold"));
      return run(async () => { showState(await post(api.updateCode, codeId, { durationMs })); ok(ht.t("blaster.defaultSet", { name, seconds: secondsText(durationMs) })); });
    };
    const deleteSaved = (codeId, name) => run(async () => { showState(await post(api.deleteCode, codeId)); ok(ht.t("blaster.deleted", { name })); });
    for (const [select, field] of [[channelSelect, frequencyInput], [learnChannelSelect, learnFrequencyInput]]) {
      if (!(select instanceof HTMLSelectElement)) continue;
      toggleFrequencyField(select, field);
      select.addEventListener("change", () => toggleFrequencyField(select, field));
    }
    for (const button of buttons) {
      button.addEventListener("click", () => {
        const action = button.dataset.action;
        if (action === "refresh") return refresh();
        if (action === "send") return send();
        if (action === "learn") return learn();
        if (action === "save") return saveCode();
      });
    }
    const codes = JSON.parse(root.querySelector('[data-saved-codes]')?.textContent || '[]');
    renderCodes(codes);
    const connect = () => {
      if (!ht.state) { requestAnimationFrame(connect); return; }
      ht.state.subscribe('device/' + root.dataset.deviceId, record => {
        ht.live(label, record.observedAt);
        const capabilities = record.value?.capabilities;
        if (capabilities) showState({ infrared: capabilities.infraredBlaster, radioFrequency: capabilities.radioFrequencyBlaster, codes: knownCodes });
        if (record.fault) { if (mark) mark.dataset.availability = 'offline'; if (label) label.textContent = ht.t('status.offline'); if (detail) detail.textContent = record.fault.message; }
      }, 'live');
    };
    connect();
  })();
`;

/** Full controls for a device whose schema is the IR/RF blaster document. */
export function renderIrRfBlasterPage({ ctx, device, codes = [] }: IrRfBlasterPageOptions): string {
  const { t } = ctx.i18n;
  const record = ctx.state.snapshot([deviceNode(device.id)])[0];
  const object = record?.value as HomeTruthObject | undefined;
  const availability = record?.fault ? "offline" : object?.status ?? "unknown";
  const channelOptions = `<option value="infrared">${escapeHtml(t("blaster.infrared"))}</option><option value="radio-frequency">${escapeHtml(t("blaster.radio"))}</option>`;
  return renderPage({
    ctx,
    title: device.name,
    nodes: [deviceNode(device.id)],
    nav: "devices",
    mainAttributes: `data-blaster-page data-device-id="${escapeHtml(device.id)}" data-api="${escapeHtml(JSON.stringify(IR_RF_BLASTER_API))}" data-hold-max-seconds="${HOLD_MAX_S}"`,
    body: `${renderDeviceHead(ctx, device, "controls")}
      ${renderStateLine(ctx, { availability, detail: record?.fault?.message ?? (record?.observedAt ? t("status.readAt", { time: ctx.i18n.dateTime(record.observedAt) }) : "") })}
      <div class="bar"><button type="button" class="btn" data-action="refresh">${escapeHtml(t("action.refresh"))}</button></div>
      <p class="feedback" id="feedback" role="status" aria-live="polite"></p>

      <h2>${escapeHtml(t("blaster.buttons"))}</h2>
      <div class="chips" id="buttons-grid">${codes.map(code => `<button class="btn" disabled>${escapeHtml(code.name)}</button>`).join("")}</div>
      <script type="application/json" data-saved-codes nonce="${escapeHtml(ctx.nonce)}">${JSON.stringify(codes).replaceAll("<", "\\u003c")}</script>
      <p class="note" id="buttons-empty"${codes.length ? " hidden" : ""}>${escapeHtml(t("blaster.noButtons"))}</p>

      <h2>${escapeHtml(t("blaster.send"))}</h2>
      <label class="field"><span>${escapeHtml(t("blaster.channel"))}</span><select id="send-channel">${channelOptions}</select></label>
      <label class="field" id="send-frequency"><span>${escapeHtml(t("blaster.frequency"))}</span><input type="number" class="num" step="0.001" min="0.1" max="10000" placeholder="433.92"></label>
      <label class="field"><span>${escapeHtml(t("blaster.code"))}</span><textarea id="send-code" class="mono" spellcheck="false"></textarea></label>
      <label class="field"><span>${escapeHtml(t("blaster.hold"))} · ${escapeHtml(t("blaster.holdHint"))}</span><input type="number" class="num" id="send-duration" step="0.1" min="0" max="${HOLD_MAX_S}" value="0"></label>
      <div class="bar"><button type="button" class="btn btn-primary" data-action="send">${escapeHtml(t("action.send"))}</button></div>
      <label class="field"><span>${escapeHtml(t("blaster.buttonName"))}</span><div class="field-row"><input type="text" id="save-name" maxlength="100"><button type="button" class="btn" data-action="save">${escapeHtml(t("blaster.saveAs"))}</button></div></label>

      <h2>${escapeHtml(t("blaster.learn"))}</h2>
      <label class="field"><span>${escapeHtml(t("blaster.channel"))}</span><select id="learn-channel">${channelOptions}</select></label>
      <label class="field" id="learn-frequency"><span>${escapeHtml(t("blaster.frequencyOptional"))}</span><input type="number" class="num" step="0.001" min="0.1" max="10000"></label>
      <div class="bar"><button type="button" class="btn" data-action="learn">${escapeHtml(t("blaster.startLearning"))}</button></div>`,
    script: BLASTER_SCRIPT,
    messages: ["blaster."],
  });
}
