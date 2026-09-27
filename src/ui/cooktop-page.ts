import type { HomeTruthObject } from "../schemas";
import type { RegisteredDevice } from "../site";
import { deviceNode } from "../state/protocol";
import { escapeHtml, renderDeviceHead, renderPage, type PageContext } from "./shell";

const SCRIPT = String.raw`
(() => {
  const root = document.querySelector('[data-cooktop]');
  const endpoint = '/api/devices/' + encodeURIComponent(root.dataset.deviceId);
  const status = document.querySelector('#cooktop-status');
  const readings = document.querySelector('#cooktop-readings');
  const zones = document.querySelector('#cooktop-zones');
  const feedback = document.querySelector('#feedback');
  const inputs = [...document.querySelectorAll('[data-cooktop-control]')];
  let busy = false, actions = {};
  const controls = () => { for (const input of inputs) input.disabled = busy || !actions[input.dataset.cooktopControl]; };
  // The value half of a reading is state; the label half is not. Only the value is marked.
  function row(label, value, observedAt) {
    const dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = label; dd.textContent = value; readings.append(dt, dd);
    ht.live(dd, observedAt);
  }
  // The graph node's value is this device's whole describe() document, the same shape the REST
  // route returns as result.object, so the cooktop capability reads straight off the record.
  function render(object, observedAt) {
    const doc = ((object || {}).capabilities || {}).cooktop;
    if (!doc) return;
    const state = doc.state;
    actions = doc.actions || {}; controls();
    status.dataset.availability = state.availability;
    status.textContent = state.detail || ht.t('status.' + state.availability);
    ht.live(status, observedAt);
    readings.replaceChildren(); zones.replaceChildren();
    if (state.power) row(ht.t('cooktop.power'), ht.t('cooktop.' + state.power), observedAt);
    if (typeof state.childLocked === 'boolean') row(ht.t('cooktop.childLock'), ht.t(state.childLocked ? 'cooktop.locked' : 'cooktop.unlocked'), observedAt);
    if (typeof state.timerSeconds === 'number') row(ht.t('cooktop.timer'), ht.number(Math.floor(state.timerSeconds / 60)) + ':' + String(state.timerSeconds % 60).padStart(2, '0'), observedAt);
    for (const zone of state.zones || []) {
      const card = document.createElement('article'), title = document.createElement('h3'), value = document.createElement('p');
      card.className = 'cooktop-zone'; card.dataset.position = zone.position; title.textContent = ht.t('cooktop.' + zone.position);
      value.textContent = ht.t('cooktop.zone.' + zone.state);
      if (zone.mode && zone.mode !== 'normal') value.textContent += ' · ' + ht.t('cooktop.' + zone.mode);
      else if (typeof zone.level === 'number' && zone.level > 0) value.textContent += ' · ' + ht.number(zone.level);
      ht.live(value, observedAt);
      card.append(title, value); zones.append(card);
    }
    document.querySelector('#cooktop-updated').textContent = state.observedAt ? ht.t('status.readAt', { time: ht.time(state.observedAt) }) : '';
  }
  function showUnavailable() {
    actions = {}; controls(); readings.replaceChildren(); zones.replaceChildren();
    status.textContent = ht.t('status.unavailable'); status.dataset.availability = 'offline';
    ht.live(status, undefined);
    document.querySelector('#cooktop-updated').textContent = '';
  }
  // Nothing on this page polls. The first paint comes from the record the server seeded into
  // #ht-state, and every later value arrives on the page's one state stream. ht.state is installed
  // by the theme's module script, which runs after this classic inline script, so wait for it.
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
    state.subscribe('device/' + root.dataset.deviceId, record => {
      if (record.value) render(record.value, record.observedAt);
      if (record.fault) {
        actions = {}; controls(); status.dataset.availability = 'offline'; status.textContent = record.fault.message;
      }
    }, 'live');
  });
  async function send(action, value) {
    if (busy) return;
    busy = true; controls();
    try {
      await ht.request(endpoint + '/controls/' + action, { method: 'POST', body: JSON.stringify({ value }) });
      // The control route describes the device again and publishes it, so the new state arrives
      // on the stream; there is nothing to re-fetch here.
      ht.say(feedback, ht.t('cooktop.saved'), 'ok');
    } catch (error) { ht.say(feedback, error.message, 'bad'); }
    finally { busy = false; controls(); }
  }
  document.querySelector('#cooktop-lock').addEventListener('click', () => send('setChildLock', true));
  document.querySelector('#cooktop-unlock').addEventListener('click', () => send('setChildLock', false));
  document.querySelector('#cooktop-cancel').addEventListener('click', () => send('setTimer', 0));
  document.querySelector('#cooktop-timer').addEventListener('submit', event => {
    event.preventDefault(); send('setTimer', Number(document.querySelector('#timer-minutes').value) * 60);
  });
  // No visibility or pagehide handling: the state client already closes its stream while the page
  // is hidden and reopens it on return (src/ui/browser/state.ts).
})();`;

export function renderCooktopPage({ ctx, device }: { ctx: PageContext; device: RegisteredDevice }): string {
  const t = (key: Parameters<typeof ctx.i18n.t>[0]) => escapeHtml(ctx.i18n.t(key));
  const record = ctx.state.snapshot([deviceNode(device.id)])[0];
  const state = (record?.value as HomeTruthObject | undefined)?.capabilities.cooktop?.state;
  const head = { availability: record?.fault ? "offline" : state?.availability ?? "unknown",
    label: record?.fault?.message ?? state?.detail ?? ctx.i18n.t(`status.${state?.availability ?? "unknown"}`) };
  const row = (label: string, value: string) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`;
  const readings = (state?.power ? row(ctx.i18n.t("cooktop.power"), ctx.i18n.t(`cooktop.${state.power}`)) : "")
    + (typeof state?.childLocked === "boolean" ? row(ctx.i18n.t("cooktop.childLock"), ctx.i18n.t(state.childLocked ? "cooktop.locked" : "cooktop.unlocked")) : "")
    + (typeof state?.timerSeconds === "number" ? row(ctx.i18n.t("cooktop.timer"), `${Math.floor(state.timerSeconds / 60)}:${String(state.timerSeconds % 60).padStart(2, "0")}`) : "");
  const zones = (state?.zones ?? []).map(zone => `<article class="cooktop-zone" data-position="${escapeHtml(zone.position)}"><h3>${escapeHtml(ctx.i18n.t(`cooktop.${zone.position}`))}</h3><p>${escapeHtml(ctx.i18n.t(`cooktop.zone.${zone.state}`))}${zone.mode && zone.mode !== "normal" ? ` · ${escapeHtml(ctx.i18n.t(`cooktop.${zone.mode}`))}` : zone.level ? ` · ${zone.level}` : ""}</p></article>`).join("");
  return renderPage({ ctx, title: device.name, nav: "devices",
    nodes: [deviceNode(device.id)],
    mainAttributes: `data-cooktop data-device-id="${escapeHtml(device.id)}"`,
    body: `${renderDeviceHead(ctx, device, "controls")}
      <p id="cooktop-status" role="status" data-availability="${escapeHtml(head.availability)}">${escapeHtml(head.label)}</p>
      <dl id="cooktop-readings" class="kv">${readings}</dl>
      <div id="cooktop-zones">${zones}</div><p id="cooktop-updated" class="muted small">${record?.observedAt ? escapeHtml(ctx.i18n.t("status.readAt", { time: ctx.i18n.dateTime(record.observedAt) })) : ""}</p>
      <p class="note">${t("cooktop.monitoring")}</p>
      <section><h2>${t("cooktop.childLock")}</h2>
        <div class="field-row"><button class="btn" id="cooktop-lock" data-cooktop-control="setChildLock" disabled>${t("cooktop.lock")}</button>
        <button class="btn" id="cooktop-unlock" data-cooktop-control="setChildLock" disabled>${t("cooktop.unlock")}</button></div>
      </section>
      <section><h2>${t("cooktop.timer")}</h2><form id="cooktop-timer">
        <label class="field"><span>${t("cooktop.minutes")}</span><div class="field-row">
          <input type="number" id="timer-minutes" min="1" max="99" step="1" value="5" required data-cooktop-control="setTimer" disabled>
          <button class="btn btn-primary" type="submit" data-cooktop-control="setTimer" disabled>${t("cooktop.startTimer")}</button>
          <button class="btn" type="button" id="cooktop-cancel" data-cooktop-control="setTimer" disabled>${t("cooktop.cancelTimer")}</button>
        </div></label></form><p class="muted small">${t("cooktop.timerHelp")}</p></section>
      <p id="feedback" class="feedback" role="status"></p>`,
    css: `#cooktop-zones { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:var(--s3); }
      .cooktop-zone { border:var(--rule-w) solid var(--rule); padding:var(--s3); }
      .cooktop-zone[data-position="rearLeft"] { grid-area:1/1; } .cooktop-zone[data-position="rearRight"] { grid-area:1/2; }
      .cooktop-zone[data-position="frontLeft"] { grid-area:2/1; } .cooktop-zone[data-position="frontRight"] { grid-area:2/2; }
      .cooktop-zone[data-position="leftCombined"] { grid-column:1/-1; }
      .cooktop-zone h3 { margin-block-start:0; } #timer-minutes { max-width:7rem; }`,
    script: SCRIPT, messages: ["cooktop."],
  });
}
