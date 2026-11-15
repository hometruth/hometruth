/**
 * Apple Home bridges: the list, one page per bridge, and the panel on element pages.
 *
 * A bridge page is the one place to decide what Apple Home sees. The top table is
 * exactly what the bridge exports, one row per accessory, with the name Apple Home
 * receives and the accessory type it appears as. Below it, everything that can be
 * added. Custom mappings stay available for items HomeTruth cannot map by itself.
 *
 * Connection state arrives over the bridge's own status stream; nothing polls.
 */
import { escapeHtml as h, renderPage, type PageContext } from "./shell";
import type { BridgeDefinition, BridgeStatus, SharedItem } from "../bridges/model";

/** Something the bridge can share, as the add list shows it. */
export interface BridgeCandidate {
  key: string;
  name: string;
  context: string;
  kind: string;
  page: string;
  room?: string;
  /** The device element a capability or sensor belongs to. */
  device?: string;
  /** Accessory types automatic settings would create on this bridge; empty means a custom mapping is needed. */
  automatic: string[];
}
export interface BridgePageData {
  bridge: BridgeDefinition;
  status: BridgeStatus;
  items: SharedItem[];
  candidates: BridgeCandidate[];
  catalog: unknown;
}

const json = (value: unknown) => JSON.stringify(value).replaceAll("<", "\\u003c");
const css = `
.bridge-status{display:flex;flex-wrap:wrap;gap:var(--s2) var(--s4);align-items:baseline;padding-block:var(--s2);border-block:var(--rule-w) solid var(--rule)}
.bridge-status[data-availability="offline"]{color:var(--bad)}
.bridge-pairing{display:grid;grid-template-columns:auto minmax(0,1fr);gap:var(--s4);align-items:center}
.bridge-pairing img{width:12rem;max-width:100%}
.bridge-code{font-family:var(--font-mono);font-size:1.5rem;letter-spacing:.08em}
.bridge-shared td,.bridge-shared th{vertical-align:middle}
.bridge-shared input,.bridge-shared select{width:100%}
.bridge-item>th{padding-block-start:var(--s4)}
.bridge-item-head{display:flex;flex-wrap:wrap;gap:var(--s1) var(--s3);align-items:baseline;justify-content:space-between}
.bridge-item-head .row-actions{display:flex;gap:var(--s2)}
.bridge-shared tr[data-hidden] input,.bridge-shared tr[data-hidden] select{color:var(--fg-2)}
.bridge-shared tr[data-availability="offline"] .bridge-state{color:var(--bad)}
.bridge-state{white-space:nowrap;color:var(--fg-2);font-size:.875rem}
.bridge-add{display:flex;flex-wrap:wrap;gap:var(--s2) var(--s4);align-items:end}
.bridge-add .field{flex:1 1 16rem}
.bridge-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(13rem,1fr));gap:var(--s2)}
.bridge-actions{display:flex;gap:var(--s2);flex-wrap:wrap;margin-block:var(--s2)}
.bridge-mapping{border-block-start:var(--rule-w) solid var(--rule);padding-block:var(--s3);margin-block:var(--s3)}
.bridge-mapping fieldset{margin-block:var(--s2);padding:var(--s2);border:1px solid var(--hair)}
.bridge-mapping textarea{min-height:4rem;width:100%}
[data-mapping-editor][hidden]{display:none}`;

const protocolName = (ctx: PageContext, protocol: BridgeDefinition["protocol"]) => ctx.i18n.t(`bridges.protocol.${protocol}`);

/** One line on what the bridge is doing; the same wording the bridge page's stream repaints. */
export function bridgeStatusText(ctx: PageContext, bridge: Pick<BridgeDefinition, "enabled">, status: BridgeStatus): string {
  const { t } = ctx.i18n;
  if (!bridge.enabled) return t("bridges.status.disabled");
  if (!status.running) return status.fault ? t("bridges.status.stopped", { detail: status.fault }) : t("bridges.status.starting");
  return `${t(status.paired ? "bridges.status.paired" : "bridges.status.unpaired")} · ${t("bridges.status.responding", { reachable: status.reachable, total: status.accessories })}`;
}

export function renderBridgesPage(ctx: PageContext, bridges: (BridgeDefinition & { status: BridgeStatus })[]): string {
  const { t } = ctx.i18n;
  const list = bridges.length ? `<ul class="rows">${bridges.map(b => `<li><a class="row" href="/bridges/${h(b.id)}"${b.enabled && !b.status.running && b.status.fault ? ' data-availability="offline"' : ""}>
      <span class="row-name">${h(b.name)}</span>
      <span class="row-meta">${h(protocolName(ctx, b.protocol))} · ${h(t("bridges.items", { count: b.members.length }))}</span>
      <span class="row-side">${h(bridgeStatusText(ctx, b, b.status))}</span></a></li>`).join("")}</ul>`
    : `<p class="empty">${h(t("bridges.empty"))}</p>`;
  return renderPage({ ctx, title: t("bridges.title"), nav: "bridges", css, messages: ["bridges."], body: `<h1>${h(t("bridges.title"))}</h1>${list}
    <section><h2>${h(t("bridges.create.title"))}</h2><form data-create-bridge><div class="bridge-fields">
      <label class="field"><span>${h(t("bridges.field.name"))}</span><input name="name" required maxlength="100" value="${h(t("bridges.create.defaultName"))}"></label>
      <label class="field"><span>${h(t("bridges.field.protocol"))}</span><select name="protocol"><option value="homekit">${h(t("bridges.create.homekit"))}</option><option value="matter">${h(t("bridges.create.matter"))}</option></select></label>
    </div><div class="bridge-actions"><button class="btn btn-primary" type="submit">${h(t("bridges.create.submit"))}</button></div><p role="status" class="feedback"></p></form></section>`,
  script: String.raw`
(() => {
  const form = document.querySelector('[data-create-bridge]');
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      const result = await ht.request('/api/bridges', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      location.href = result.page;
    } catch (error) { ht.say(form.querySelector('.feedback'), error.message, 'bad'); button.disabled = false; }
  });
})();` });
}

export function renderBridgePage(ctx: PageContext, data: BridgePageData): string {
  const { t } = ctx.i18n, { bridge, status } = data;
  return renderPage({ ctx, title: bridge.name, nav: "bridges", css, messages: ["bridges."], body: `<p><a href="/bridges">${h(t("bridges.all"))}</a></p>
    <h1 data-bridge-title>${h(bridge.name)}</h1>
    <script type="application/json" nonce="${h(ctx.nonce)}" data-bridge-data>${json(data)}</script>
    <p class="bridge-status" data-bridge-status><span>${h(protocolName(ctx, bridge.protocol))}</span><span data-status-text>${h(bridgeStatusText(ctx, bridge, status))}</span></p>
    <section data-pairing hidden></section>
    <section aria-labelledby="bridge-shared-title"><h2 id="bridge-shared-title">${h(t("bridges.shared.title"))}</h2>
      <div data-shared></div><p class="feedback" role="status" data-shared-feedback></p>
      <p class="note">${h(t("bridges.shared.naming"))}</p></section>
    <section aria-labelledby="bridge-add-title"><h2 id="bridge-add-title">${h(t("bridges.add.title"))}</h2>
      <div class="bridge-add"><label class="field"><span>${h(t("bridges.add.search"))}</span><input type="search" data-add-search autocomplete="off"></label>
        <label><input type="checkbox" data-add-all> ${h(t("bridges.add.all"))}</label></div>
      <ul class="rows" data-candidates></ul><p class="note" data-candidates-more></p><p class="feedback" role="status" data-add-feedback></p></section>
    <section data-mapping-editor hidden aria-labelledby="bridge-mapping-title"><h2 id="bridge-mapping-title" data-mapping-title></h2>
      <p>${h(t("bridges.mapping.intro"))}</p><div data-mappings></div>
      <div class="bridge-actions"><select data-new-profile aria-label="${h(t("bridges.mapping.type"))}"></select><button type="button" class="btn" data-add-mapping>${h(t("bridges.mapping.add"))}</button></div>
      <div class="bridge-actions"><button type="button" class="btn btn-primary" data-save-mappings>${h(t("bridges.mapping.save"))}</button><button type="button" class="btn" data-automatic-mappings>${h(t("bridges.mapping.automatic"))}</button><button type="button" class="btn" data-cancel-mappings>${h(t("bridges.mapping.cancel"))}</button></div>
      <p class="feedback" role="status" data-mapping-feedback></p></section>
    <section aria-labelledby="bridge-settings-title"><h2 id="bridge-settings-title">${h(t("bridges.settings.title"))}</h2><form data-settings><div class="bridge-fields">
      <label class="field"><span>${h(t("bridges.field.name"))}</span><input name="name" value="${h(bridge.name)}" maxlength="100" required></label></div>
      <p><label><input name="enabled" type="checkbox"${bridge.enabled ? " checked" : ""}> ${h(t("bridges.settings.enabled"))}</label></p>
      <div class="bridge-actions"><button class="btn">${h(t("bridges.settings.save"))}</button><button type="button" class="btn btn-danger" data-delete-bridge>${h(t("bridges.settings.delete"))}</button></div>
      <p class="feedback" role="status" data-settings-feedback></p></form>
      <p class="note">${h(t("bridges.settings.limits"))}</p></section>`, script: BRIDGE_PAGE_SCRIPT });
}

/** The Apple Home section on an element page: which bridges share this item. */
export function renderBridgeMembership(ctx: PageContext, key: string): string {
  if (!ctx.features.admin) return "";
  const { t } = ctx.i18n;
  const messages = Object.fromEntries(["bridges.membership.none", "bridges.membership.configure", "bridges.saved", "bridges.protocol.homekit", "bridges.protocol.matter"].map(id => [id, t(id as Parameters<typeof t>[0])]));
  return `<section data-bridge-membership data-element-key="${h(key)}" aria-labelledby="element-bridges-title"><h2 id="element-bridges-title">${h(t("bridges.membership.title"))}</h2>
    <script type="application/json" nonce="${h(ctx.nonce)}" data-bridge-membership-messages>${json(messages)}</script>
    <div data-bridge-options></div><p class="feedback" role="status" data-membership-feedback></p><p><a href="/bridges">${h(t("bridges.membership.manage"))}</a></p></section>`;
}
export const BRIDGE_MEMBERSHIP_SCRIPT = String.raw`
(() => {
  const panel = document.querySelector('[data-bridge-membership]');
  if (!panel) return;
  const words = JSON.parse(panel.querySelector('[data-bridge-membership-messages]').textContent);
  const list = panel.querySelector('[data-bridge-options]'), feedback = panel.querySelector('[data-membership-feedback]');
  let key = panel.dataset.elementKey, epoch = 0;
  async function load() {
    const version = ++epoch;
    try {
      const result = await ht.request('/api/bridges/options/' + encodeURIComponent(key));
      if (version !== epoch) return;
      list.replaceChildren();
      panel.hidden = !result.eligible;
      if (!result.eligible) return;
      if (!result.bridges.length) { const p = document.createElement('p'); p.textContent = words['bridges.membership.none']; list.append(p); }
      for (const bridge of result.bridges) {
        const row = document.createElement('div'), label = document.createElement('label'), input = document.createElement('input');
        input.type = 'checkbox'; input.checked = Boolean(bridge.member);
        label.append(input, document.createTextNode(' ' + bridge.name + ' · ' + words['bridges.protocol.' + bridge.protocol]));
        const configure = document.createElement('a');
        configure.href = '/bridges/' + bridge.id + '?element=' + encodeURIComponent(key);
        configure.textContent = words['bridges.membership.configure'];
        row.append(label, document.createTextNode(' '), configure);
        list.append(row);
        input.addEventListener('change', async () => {
          if (input.checked && !bridge.automatic.length) { location.href = configure.href; return; }
          input.disabled = true;
          try {
            await ht.request('/api/bridges/' + bridge.id + '/members/' + encodeURIComponent(key), { method: input.checked ? 'PUT' : 'DELETE', body: JSON.stringify({ revision: bridge.revision, ...(input.checked ? { mappings: [] } : {}) }) });
            ht.say(feedback, words['bridges.saved'], 'ok');
            await load();
          } catch (error) { input.checked = !input.checked; input.disabled = false; ht.say(feedback, error.message, 'bad'); }
        });
      }
    } catch (error) { if (version === epoch) ht.say(feedback, error.message, 'bad'); }
  }
  window.addEventListener('ht-element-selected', event => { if (event.detail === key) return; key = event.detail; if (key) load(); else panel.hidden = true; });
  load();
})();`;

const BRIDGE_PAGE_SCRIPT = String.raw`
(() => {
  const seed = JSON.parse(document.querySelector('[data-bridge-data]').textContent);
  let bridge = seed.bridge, items = seed.items, status = seed.status;
  const { candidates, catalog } = seed;
  const t = ht.t, $ = selector => document.querySelector(selector);
  const el = (tag, text, parent, className) => {
    const e = document.createElement(tag);
    if (text !== undefined) e.textContent = text;
    if (className) e.className = className;
    if (parent) parent.append(e);
    return e;
  };
  const option = (select, value, text) => { const e = el('option', text, select); e.value = value; return e; };
  const button = (text, parent, onclick, className = 'btn btn-small') => { const b = el('button', text, parent, className); b.type = 'button'; b.onclick = onclick; return b; };
  const profileName = id => { const key = 'bridges.profile.' + id, text = t(key); return text === key ? id : text; };
  const api = (suffix = '', method = 'GET', body) => ht.request('/api/bridges/' + bridge.id + suffix, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  const memberPath = key => '/members/' + encodeURIComponent(key);
  const member = key => bridge.members.find(m => m.element === key);
  const accept = result => { bridge = result.bridge; if (result.items) items = result.items; render(); };
  const attempt = async (feedback, job, saved = true) => {
    try { await job(); if (saved) ht.say(feedback, t('bridges.saved'), 'ok'); return true; }
    catch (error) { ht.say(feedback, error.message, 'bad'); return false; }
  };

  // ---- Connection and pairing ----------------------------------------------------------------
  function statusText() {
    if (!bridge.enabled) return t('bridges.status.disabled');
    if (!status.running) return status.fault ? t('bridges.status.stopped', { detail: status.fault }) : t('bridges.status.starting');
    return t(status.paired ? 'bridges.status.paired' : 'bridges.status.unpaired') + ' · ' + t('bridges.status.responding', { reachable: status.reachable, total: status.accessories });
  }
  let painted = '';
  function paintStatus() {
    const box = $('[data-bridge-status]');
    $('[data-status-text]').textContent = statusText();
    if (bridge.enabled && !status.running && status.fault) box.dataset.availability = 'offline'; else delete box.dataset.availability;
    const pairing = $('[data-pairing]');
    const codes = [];
    if (status.running && status.pairing) codes.push({ name: bridge.name, code: status.pairing.code });
    for (const a of status.externalAccessories || []) if (!a.paired && a.code) codes.push({ name: t('bridges.pairing.separate', { name: a.name }), code: a.code, accessory: a.id });
    const signature = JSON.stringify([codes, bridge.protocol, status.paired]);
    if (signature === painted) return;
    painted = signature;
    pairing.replaceChildren();
    pairing.hidden = !codes.length;
    if (!codes.length) return;
    el('h2', t('bridges.pairing.title'), pairing);
    el('p', t('bridges.pairing.help'), pairing);
    for (const entry of codes) {
      const row = el('div', undefined, pairing, 'bridge-pairing');
      const image = el('img', undefined, row);
      image.alt = t('bridges.pairing.qr', { name: entry.name });
      image.src = ht.apiPath('/api/bridges/' + bridge.id + '/qr' + (entry.accessory ? '?accessory=' + encodeURIComponent(entry.accessory) : ''));
      const text = el('div', undefined, row);
      el('h3', entry.name, text);
      el('p', entry.code, text, 'bridge-code');
    }
    if (bridge.protocol === 'matter' && status.running && !status.paired) {
      const feedback = el('p', undefined, undefined, 'feedback');
      button(t('bridges.pairing.open'), pairing, () => attempt(feedback, () => api('/pair', 'POST', {}), false), 'btn');
      pairing.append(feedback);
    }
  }
  function follow() {
    const stream = new EventSource(ht.apiPath('/api/bridges/' + bridge.id + '/stream'));
    stream.addEventListener('status', event => {
      try { status = JSON.parse(event.data); } catch { return; }
      paintStatus(); paintStates();
    });
    window.addEventListener('pagehide', () => stream.close(), { once: true });
  }

  // ---- What Apple Home sees ------------------------------------------------------------------
  const sharedFeedback = $('[data-shared-feedback]');
  /** Overrides rebuilt from the current accessories, so a role the device no longer has is dropped. */
  function overrides(item, change) {
    const current = member(item.element)?.accessories || {};
    const next = {};
    for (const a of item.accessories) {
      const o = { ...(current[a.slot] || {}) };
      change?.(a, o);
      if (!o.name || o.name === a.automaticName) delete o.name;
      if (!o.profile || o.profile === a.automaticProfile) delete o.profile;
      if (!o.hidden) delete o.hidden;
      if (Object.keys(o).length) next[a.slot] = o;
    }
    return next;
  }
  async function saveAutomatic(item, change) {
    const accessories = overrides(item, change);
    return attempt(sharedFeedback, async () => accept(await api(memberPath(item.element), 'PUT', { revision: bridge.revision, mappings: [], ...(Object.keys(accessories).length ? { accessories } : {}) })));
  }
  async function renameCustom(item, slot, name) {
    const mappings = member(item.element).mappings.map(m => m.id === slot ? { ...m, name } : m);
    return attempt(sharedFeedback, async () => accept(await api(memberPath(item.element), 'PUT', { revision: bridge.revision, mappings })));
  }
  const removeItem = item => attempt(sharedFeedback, async () => accept(await api(memberPath(item.element), 'DELETE', { revision: bridge.revision })));

  function renderShared() {
    const box = $('[data-shared]');
    const focused = document.activeElement?.dataset?.focus;
    box.replaceChildren();
    if (!items.length) { el('p', t('bridges.shared.empty'), box, 'empty'); return; }
    const wrap = el('div', undefined, box, 'table-wrap');
    const table = el('table', undefined, wrap, 'table bridge-shared');
    const head = el('tr', undefined, el('thead', undefined, table));
    for (const title of [t('bridges.shared.name'), t('bridges.shared.type'), t('bridges.shared.state')]) el('th', title, head).scope = 'col';
    for (const item of items) {
      const body = el('tbody', undefined, table);
      const headRow = el('tr', undefined, body, 'bridge-item');
      const cell = el('th', undefined, headRow);
      cell.colSpan = 3; cell.scope = 'rowgroup';
      const line = el('div', undefined, cell, 'bridge-item-head');
      const title = el('span', undefined, line);
      const link = el(item.page ? 'a' : 'span', item.name, title);
      if (item.page) link.href = item.page;
      const facts = [item.room, item.custom ? t('bridges.shared.custom') : t('bridges.shared.automatic')].filter(Boolean).join(' · ');
      el('span', ' · ' + facts, title, 'muted');
      const actions = el('span', undefined, line, 'row-actions');
      button(item.custom ? t('bridges.shared.editMapping') : t('bridges.shared.customize'), actions, () => openEditor(item.element));
      button(t('bridges.shared.remove'), actions, () => removeItem(item));
      if (item.missing) {
        const row = el('tr', undefined, body);
        row.dataset.availability = 'offline';
        const problem = el('td', item.problem || t('bridges.shared.missing'), row, 'bridge-state');
        problem.colSpan = 3;
        continue;
      }
      const visible = item.accessories.filter(a => !a.hidden).length;
      for (const accessory of item.accessories) {
        const row = el('tr', undefined, body);
        row.dataset.accessory = accessory.id;
        if (accessory.hidden) row.dataset.hidden = '';
        const nameCell = el('td', undefined, row);
        const name = el('input', undefined, nameCell);
        name.value = accessory.name; name.placeholder = accessory.automaticName; name.maxLength = 100;
        name.setAttribute('aria-label', t('bridges.shared.nameFor', { name: accessory.automaticName }));
        name.dataset.focus = item.element + '|' + accessory.slot + '|name';
        name.onchange = () => {
          const value = name.value.trim();
          if (item.custom) { if (!value) { name.value = accessory.name; return; } renameCustom(item, accessory.slot, value); }
          else saveAutomatic(item, (a, o) => { if (a.slot === accessory.slot) o.name = value; });
        };
        const typeCell = el('td', undefined, row);
        if (accessory.profiles.length > 1) {
          const type = el('select', undefined, typeCell);
          type.setAttribute('aria-label', t('bridges.shared.typeFor', { name: accessory.name }));
          type.dataset.focus = item.element + '|' + accessory.slot + '|type';
          for (const id of accessory.profiles) option(type, id, profileName(id));
          type.value = accessory.profile;
          type.onchange = () => saveAutomatic(item, (a, o) => { if (a.slot === accessory.slot) o.profile = type.value; });
        } else typeCell.textContent = profileName(accessory.profile);
        const stateCell = el('td', undefined, row);
        el('span', '', stateCell, 'bridge-state');
        // A single-accessory item is removed, not left out.
        if (!item.custom && item.accessories.length > 1) {
          const hiding = !accessory.hidden;
          const toggle = button(hiding ? t('bridges.shared.hide') : t('bridges.shared.show'), stateCell,
            () => saveAutomatic(item, (a, o) => { if (a.slot === accessory.slot) o.hidden = hiding; }));
          toggle.dataset.focus = item.element + '|' + accessory.slot + '|hide';
          if (hiding && visible === 1) { toggle.disabled = true; toggle.title = t('bridges.shared.lastVisible'); }
        }
      }
    }
    if (focused) [...box.querySelectorAll('[data-focus]')].find(e => e.dataset.focus === focused)?.focus();
    paintStates();
  }
  /** Per-accessory state from the latest status frame; hidden accessories are simply not in Apple Home. */
  function paintStates() {
    const unreachable = new Set(status.unreachable || []);
    for (const row of $('[data-shared]').querySelectorAll('tr[data-accessory]')) {
      const state = row.querySelector('.bridge-state');
      if (row.hasAttribute('data-hidden')) { state.textContent = t('bridges.shared.hidden'); delete row.dataset.availability; continue; }
      const down = status.running && unreachable.has(row.dataset.accessory);
      state.textContent = !status.running ? '' : down ? t('bridges.shared.unavailable') : t('bridges.shared.available');
      if (down) row.dataset.availability = 'offline'; else delete row.dataset.availability;
    }
  }

  // ---- Adding ----------------------------------------------------------------------------------
  const addFeedback = $('[data-add-feedback]'), search = $('[data-add-search]'), showAll = $('[data-add-all]');
  const LIMIT = 40;
  function renderCandidates() {
    const list = $('[data-candidates]');
    list.replaceChildren();
    const shared = new Set(bridge.members.map(m => m.element));
    const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = candidates.filter(c => !shared.has(c.key) && !(c.device && shared.has(c.device))
      // A device brings its capabilities along, so they are listed on their own only on request.
      && (showAll.checked || c.automatic.length && !c.device)
      && words.every(word => (c.name + ' ' + (c.room || '') + ' ' + c.context + ' ' + c.automatic.map(profileName).join(' ')).toLowerCase().includes(word)))
      .sort((a, b) => (a.room || '￿').localeCompare(b.room || '￿') || a.name.localeCompare(b.name));
    for (const candidate of matches.slice(0, LIMIT)) {
      const row = el('li', undefined, list, 'row');
      const name = el('span', undefined, row, 'row-name');
      const link = el('a', candidate.name, name); link.href = candidate.page;
      const meta = [candidate.room, candidate.context && candidate.context !== candidate.room ? candidate.context : '',
        candidate.automatic.length ? t('bridges.add.becomes', { types: [...new Set(candidate.automatic)].map(profileName).join(', ') }) : t('bridges.add.needsMapping')].filter(Boolean);
      el('span', meta.join(' · '), row, 'row-meta');
      const actions = el('span', undefined, row, 'row-actions');
      if (candidate.automatic.length) button(t('bridges.add.add'), actions, () => attempt(addFeedback, async () => {
        accept(await api(memberPath(candidate.key), 'PUT', { revision: bridge.revision, mappings: [] }));
        search.focus();
      }), 'btn btn-small btn-primary');
      else button(t('bridges.add.map'), actions, () => openEditor(candidate.key));
    }
    if (!matches.length) el('li', t(search.value ? 'bridges.add.noMatches' : 'bridges.add.nothing'), list, 'empty');
    $('[data-candidates-more]').textContent = matches.length > LIMIT ? t('bridges.add.more', { shown: LIMIT, total: matches.length }) : '';
  }
  search.oninput = renderCandidates;
  showAll.onchange = renderCandidates;

  // ---- Custom mappings -------------------------------------------------------------------------
  const editor = $('[data-mapping-editor]'), mappingBox = $('[data-mappings]'), mappingFeedback = $('[data-mapping-feedback]');
  let editing = null;
  const field = (parent, label, type = 'text', value = '') => {
    const wrap = el('label', undefined, parent, 'field');
    el('span', label, wrap);
    const input = el(type === 'select' ? 'select' : type === 'textarea' ? 'textarea' : 'input', undefined, wrap);
    if (input.tagName === 'INPUT') input.type = type;
    input.value = value;
    return input;
  };
  const parseValue = value => { try { return JSON.parse(value); } catch { return value; } };
  const availableProfiles = catalog.profiles.filter(p => p.protocols.includes(bridge.protocol));
  for (const profile of availableProfiles) option($('[data-new-profile]'), profile.id, profileName(profile.id));
  const elementName = key => catalog.elements.find(e => e.key === key)?.name ?? candidates.find(c => c.key === key)?.name ?? t('bridges.mapping.item');
  function transformFields(parent, title, binding) {
    const detail = el('details', undefined, parent);
    el('summary', title, detail);
    const grid = el('div', undefined, detail, 'bridge-fields');
    const scale = field(grid, t('bridges.mapping.scale'), 'number', binding?.scale ?? ''), offset = field(grid, t('bridges.mapping.offset'), 'number', binding?.offset ?? '');
    scale.step = offset.step = 'any';
    const conversion = field(grid, t('bridges.mapping.conversion'), 'select');
    for (const id of ['', 'kelvin-mired', 'battery-low', 'co2-high', 'pm25-quality']) option(conversion, id, t('bridges.conversion.' + (id || 'none')));
    conversion.value = binding?.conversion ?? '';
    const values = field(detail, t('bridges.mapping.values'), 'textarea', binding?.values ? JSON.stringify(binding.values) : '');
    return () => ({
      ...(scale.value !== '' ? { scale: Number(scale.value) } : {}),
      ...(offset.value !== '' ? { offset: Number(offset.value) } : {}),
      ...(conversion.value ? { conversion: conversion.value } : {}),
      ...(values.value.trim() ? { values: JSON.parse(values.value) } : {}),
    });
  }
  function mappingCard(mapping) {
    const profile = availableProfiles.find(p => p.id === mapping.profile);
    if (!profile) return;
    const card = el('div', undefined, mappingBox, 'bridge-mapping');
    el('h3', profileName(profile.id), card);
    const name = field(card, t('bridges.mapping.name'), 'text', mapping.name);
    name.maxLength = 100;
    const type = field(card, t('bridges.mapping.type'), 'select');
    for (const p of availableProfiles) option(type, p.id, profileName(p.id));
    type.value = profile.id;
    type.onchange = () => {
      const replacement = mappingCard({ id: mapping.id, name: name.value, profile: type.value, characteristics: {} });
      if (replacement) card.replaceWith(replacement);
    };
    button(t('bridges.mapping.remove'), card, () => card.remove(), 'btn');
    if (profile.id === 'MomentarySwitch') {
      const trigger = field(card, t('bridges.mapping.button'), 'select');
      option(trigger, '', t('bridges.mapping.chooseButton'));
      for (const b of catalog.buttons) option(trigger, b.key, b.name);
      trigger.value = mapping.characteristics.On?.trigger?.element ?? '';
      el('p', t('bridges.mapping.momentary'), card, 'note');
      card.read = () => {
        if (!trigger.value) throw new Error(t('bridges.mapping.needButton'));
        return { id: mapping.id, name: name.value, profile: profile.id, characteristics: { On: { trigger: { element: trigger.value } } } };
      };
      return card;
    }
    let camera;
    if (['Camera', 'VideoDoorbell'].includes(profile.id)) {
      camera = field(card, t('bridges.mapping.camera'), 'select');
      option(camera, '', t('bridges.mapping.chooseCamera'));
      for (const c of catalog.cameras) option(camera, c.key, c.name);
      camera.value = mapping.camera ?? '';
    }
    const readers = [];
    for (const definition of profile.characteristics) {
      const existing = mapping.characteristics[definition.key];
      const group = el('fieldset', undefined, card);
      const legend = el('legend', definition.name + (definition.required ? ' · ' + t('bridges.mapping.required') : ''), group);
      const enabled = el('input', undefined, legend);
      enabled.type = 'checkbox'; enabled.checked = definition.required || Boolean(existing); enabled.disabled = definition.required;
      const contents = el('div', undefined, group);
      contents.hidden = !enabled.checked;
      enabled.onchange = () => contents.hidden = !enabled.checked;
      el('p', [definition.unit,
        definition.values ? t('bridges.mapping.allowed', { values: definition.values.join(', ') }) : '',
        definition.minimum !== undefined ? t('bridges.mapping.minimum', { value: definition.minimum }) : '',
        definition.maximum !== undefined ? t('bridges.mapping.maximum', { value: definition.maximum }) : ''].filter(Boolean).join(' · '), contents, 'note');
      let source, path, getRead, constant, control, getWrite, eventSource;
      const commands = [];
      if (definition.key === 'ProgrammableSwitchEvent') {
        eventSource = field(contents, t('bridges.mapping.eventSource'), 'select');
        option(eventSource, '', t('bridges.mapping.chooseButton'));
        for (const b of catalog.buttons) option(eventSource, b.key, b.name);
        eventSource.value = existing?.event?.element ?? '';
      }
      if (definition.readable && definition.key !== 'ProgrammableSwitchEvent') {
        const grid = el('div', undefined, contents, 'bridge-fields');
        source = field(grid, t('bridges.mapping.readFrom'), 'select');
        option(source, '', t('bridges.mapping.chooseSource'));
        for (const s of catalog.sources) option(source, s.key, s.name);
        source.value = existing?.read?.element ?? '';
        path = field(grid, t('bridges.mapping.path'), 'text', existing?.read?.path ?? '');
        source.onchange = () => path.value = catalog.sources.find(s => s.key === source.value)?.path ?? '';
        getRead = transformFields(contents, t('bridges.mapping.convertRead'), existing?.read);
      }
      if (definition.configuration) constant = field(contents, t('bridges.mapping.fixed'), 'text', existing?.constant === undefined ? '' : JSON.stringify(existing.constant));
      if (definition.writable) {
        control = field(contents, t('bridges.mapping.sendTo'), 'select');
        option(control, '', t('bridges.mapping.chooseControl'));
        for (const c of catalog.controls) option(control, c.key, c.name);
        control.value = existing?.write?.element ?? '';
        getWrite = transformFields(contents, t('bridges.mapping.convertWrite'), existing?.write);
        const values = definition.format === 'bool' ? [false, true] : definition.values?.length <= 16 ? definition.values : [];
        const detail = el('details', undefined, contents);
        el('summary', t('bridges.mapping.perValue'), detail);
        for (const value of values || []) {
          const grid = el('div', undefined, detail, 'bridge-fields');
          const selected = field(grid, t('bridges.mapping.whenValue', { value: String(value) }), 'select');
          option(selected, '', t('bridges.mapping.mainControl'));
          for (const c of catalog.controls) option(selected, c.key, c.name);
          selected.value = existing?.commands?.[String(value)]?.element ?? '';
          const fixed = field(grid, t('bridges.mapping.argument'), 'text', existing?.commands?.[String(value)]?.value === undefined ? '' : JSON.stringify(existing.commands[String(value)].value));
          commands.push({ value, selected, fixed });
        }
      }
      readers.push(() => {
        if (!enabled.checked) return null;
        const binding = {};
        if (eventSource?.value) binding.event = { element: eventSource.value };
        if (source?.value) binding.read = { element: source.value, path: path.value, ...getRead() };
        if (constant?.value.trim()) binding.constant = parseValue(constant.value);
        if (control?.value) binding.write = { element: control.value, ...getWrite() };
        const perValue = Object.fromEntries(commands.filter(c => c.selected.value).map(c => [String(c.value), { element: c.selected.value, ...(c.fixed.value !== '' ? { value: parseValue(c.fixed.value) } : {}) }]));
        if (Object.keys(perValue).length) binding.commands = perValue;
        return [definition.key, binding];
      });
    }
    card.read = () => ({ id: mapping.id, name: name.value, profile: profile.id, ...(camera?.value ? { camera: camera.value } : {}), characteristics: Object.fromEntries(readers.map(read => read()).filter(Boolean)) });
    return card;
  }
  function openEditor(key) {
    editing = key;
    editor.hidden = false;
    mappingBox.replaceChildren();
    ht.say(mappingFeedback, '');
    $('[data-mapping-title]').textContent = t('bridges.mapping.title', { name: elementName(key) });
    for (const m of member(key)?.mappings ?? []) mappingCard(m);
    const automatic = candidates.find(c => c.key === key)?.automatic.length || items.some(i => i.element === key && !i.custom);
    $('[data-automatic-mappings]').hidden = !automatic || !member(key)?.mappings.length;
    editor.scrollIntoView({ block: 'nearest' });
  }
  $('[data-add-mapping]').onclick = () => mappingCard({ id: crypto.randomUUID(), name: elementName(editing), profile: $('[data-new-profile]').value, characteristics: {} });
  $('[data-save-mappings]').onclick = () => attempt(mappingFeedback, async () => {
    const mappings = [...mappingBox.children].map(card => card.read());
    if (!mappings.length) throw new Error(t('bridges.mapping.needOne'));
    accept(await api(memberPath(editing), 'PUT', { revision: bridge.revision, mappings }));
    editor.hidden = true;
    ht.say(sharedFeedback, t('bridges.saved'), 'ok');
  }, false);
  $('[data-automatic-mappings]').onclick = () => attempt(mappingFeedback, async () => {
    accept(await api(memberPath(editing), 'PUT', { revision: bridge.revision, mappings: [] }));
    editor.hidden = true;
    ht.say(sharedFeedback, t('bridges.saved'), 'ok');
  }, false);
  $('[data-cancel-mappings]').onclick = () => { editor.hidden = true; };

  // ---- Settings --------------------------------------------------------------------------------
  const settingsFeedback = $('[data-settings-feedback]');
  $('[data-settings]').onsubmit = event => {
    event.preventDefault();
    const data = new FormData(event.target);
    attempt(settingsFeedback, async () => {
      accept(await api('', 'PUT', { revision: bridge.revision, name: data.get('name'), enabled: data.has('enabled') }));
      $('[data-bridge-title]').textContent = bridge.name;
      document.title = document.title.replace(seed.bridge.name, bridge.name);
      paintStatus();
    });
  };
  $('[data-delete-bridge]').onclick = () => {
    if (confirm(t('bridges.settings.confirmDelete'))) attempt(settingsFeedback, async () => { await api('', 'DELETE', { revision: bridge.revision }); location.href = '/bridges'; }, false);
  };

  function render() { renderShared(); renderCandidates(); }
  render();
  paintStatus();
  const selected = new URL(location.href).searchParams.get('element');
  // Arriving from an element page: show that item where it already is, or offer it for adding.
  const arriving = selected && candidates.find(c => c.key === selected);
  if (selected && member(selected)?.mappings.length) openEditor(selected);
  else if (selected && member(selected)) [...$('[data-shared]').querySelectorAll('[data-focus]')].find(e => e.dataset.focus.startsWith(selected + '|'))?.focus();
  else if (arriving?.automatic.length) { search.value = arriving.name; renderCandidates(); search.scrollIntoView({ block: 'nearest' }); }
  else if (arriving) openEditor(selected);
  follow();
})();`;
