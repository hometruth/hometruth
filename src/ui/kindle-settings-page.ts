import type { KindleSettings } from "../kindle/store";
import { kindleElementKey, type KindleElement } from "../kindle/elements";
import { escapeHtml as e, renderPage, type PageContext } from "./shell";

const SCRIPT = String.raw`
(() => {
  const root = document.querySelector('[data-kindle-editor]');
  const initial = JSON.parse(root.dataset.settings);
  const devices = JSON.parse(root.dataset.devices);
  let revision = initial.revision;
  let items = initial.config.items;
  const form = document.getElementById('kindle-config');
  const list = document.getElementById('kindle-items');
  const custom = document.getElementById('kindle-custom');
  const feedback = document.getElementById('settings-feedback');
  const preview = document.getElementById('kindle-preview');
  const field = (name) => form.elements.namedItem(name);
  const option = (value, text) => new Option(text, value);
  const keyFor = item => item.source === 'group' ? 'group/' + item.deviceId : item.deviceId;
  const binding = key => key.startsWith('group/') ? { source: 'group', deviceId: key.slice(6) } : { deviceId: key };
  const select = (name, choices, value) => {
    const node = document.createElement('select'); node.dataset.field = name;
    for (const [key, label] of choices) node.add(option(key, label));
    node.value = value; return node;
  };
  const wrap = (label, node) => {
    const holder = document.createElement('label'); holder.className = 'field';
    const text = document.createElement('span'); text.textContent = label;
    holder.append(text, node); return holder;
  };
  const readItems = () => [...list.querySelectorAll('[data-item]')].map((row) => {
    const value = (key) => row.querySelector('[data-field="' + key + '"]').value;
    return { ...binding(value('deviceId')), capability: value('capability'), mode: value('mode'), label: value('label') };
  });
  const render = () => {
    list.replaceChildren();
    items.forEach((item, index) => {
      const device = devices.find((entry) => entry.key === keyFor(item));
      const row = document.createElement('fieldset'); row.dataset.item = String(index);
      const legend = document.createElement('legend'); legend.textContent = (index + 1) + '. ' + (item.label || device?.name || item.deviceId);
      row.append(legend);
      const inputs = document.createElement('div'); inputs.className = 'item-fields';
      const choices = devices.map((entry) => [entry.key, entry.name + ' · ' + entry.modelTitle]);
      if (!device) choices.unshift([keyFor(item), item.deviceId + ' · ' + ht.t('kindle.missing')]);
      const deviceSelect = select('deviceId', choices, keyFor(item));
      deviceSelect.addEventListener('change', () => {
        items = readItems(); items[index].capability = 'auto'; render();
      });
      const capabilities = [['auto', ht.t('designer.wholeElement')], ...(device?.capabilities || []).map((kind) => [kind, ht.t('cap.' + kind)])];
      if (!capabilities.some(([kind]) => kind === item.capability)) capabilities.push([item.capability, ht.t('cap.' + item.capability) + ' · ' + ht.t('kindle.missing')]);
      const label = document.createElement('input'); label.dataset.field = 'label'; label.value = item.label; label.maxLength = 80;
      inputs.append(wrap(ht.t('designer.element'), deviceSelect), wrap(ht.t('kindle.capability'), select('capability', capabilities, item.capability)), wrap(ht.t('kindle.display'), select('mode', [['auto', ht.t('kindle.interactive')], ['status', ht.t('kindle.statusOnly')]], item.mode)), wrap(ht.t('kindle.customLabel'), label));
      row.append(inputs);
      const bar = document.createElement('div'); bar.className = 'bar';
      for (const [action, key, disabled] of [['up', 'kindle.moveUp', index === 0], ['down', 'kindle.moveDown', index === items.length - 1], ['remove', 'action.remove', false]]) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'btn'; button.textContent = ht.t(key); button.disabled = disabled;
        button.addEventListener('click', () => {
          items = readItems();
          if (action === 'remove') items.splice(index, 1);
          else { const other = index + (action === 'up' ? -1 : 1); [items[index], items[other]] = [items[other], items[index]]; }
          render();
        });
        bar.append(button);
      }
      row.append(bar); list.append(row);
    });
    document.getElementById('kindle-empty').hidden = items.length !== 0;
  };
  field('selection').addEventListener('change', () => { custom.hidden = field('selection').value !== 'custom'; });
  document.getElementById('kindle-add').addEventListener('click', () => {
    if (!devices.length) return;
    items = readItems();
    if (items.length >= 200) return;
    items.push({ ...binding(document.getElementById('kindle-add-device').value), capability: 'auto', mode: 'auto', label: '' });
    render();
    list.lastElementChild?.scrollIntoView({ block: 'nearest' });
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    items = readItems();
    const config = { version: 1, title: field('title').value.trim(), refreshSeconds: Number(field('refreshSeconds').value), rowsPerPage: Number(field('rowsPerPage').value), fontSize: Number(field('fontSize').value), selection: field('selection').value, items };
    if (initial.config.canvas) config.canvas = initial.config.canvas;
    const save = document.getElementById('kindle-save'); save.disabled = true;
    ht.say(feedback, ht.t('feedback.saving'));
    try {
      const result = await ht.request('/api/kindle/config', { method: 'PUT', body: JSON.stringify({ config, revision }) });
      revision = result.revision;
      preview.src = '/kindle?preview=1&_=' + Date.now();
      ht.say(feedback, ht.t('kindle.saved'), 'ok');
    } catch (error) { ht.say(feedback, error.message || ht.t('feedback.requestFailed'), 'bad'); }
    finally { save.disabled = false; }
  });
  render();
})();
`;

export function renderKindleSettingsPage({ ctx, settings, elements }: { ctx: PageContext; settings: KindleSettings; elements: readonly KindleElement[] }): string {
  const { t } = ctx.i18n;
  const { config } = settings;
  const inventory = elements.map(element => ({ ...element, key: kindleElementKey(element), modelTitle: element.source === "group" ? t("grouping.group") : element.modelTitle }));
  const numeric = (name: string, label: string, value: number, min: number, max: number) => `<label class="field"><span>${e(label)}</span><input name="${name}" type="number" min="${min}" max="${max}" value="${value}" required></label>`;
  return renderPage({
    ctx, title: t("kindle.settings"), nav: "kindle", wide: true,
    mainAttributes: `data-kindle-editor data-settings="${e(JSON.stringify(settings))}" data-devices="${e(JSON.stringify(inventory))}"`,
    body: `<div class="bar"><a class="btn" href="/kindle/designer">${e(t("designer.title"))}</a>${config.canvas ? `<span>${e(t("designer.canvasActive"))}</span>` : ""}</div><h1>${e(t("kindle.settings"))}</h1><p>${e(t("kindle.settingsIntro"))}</p>
      <div class="bar"><a class="btn" href="/kindle" target="_blank" rel="noopener">${e(t("kindle.open"))}</a><span class="muted">/kindle</span></div>
      <div class="kindle-workspace"><section><form id="kindle-config">
        <h2>${e(t("kindle.layout"))}</h2><div class="settings-fields">
        <label class="field"><span>${e(t("kindle.heading"))}</span><input name="title" value="${e(config.title)}" maxlength="80" required></label>
        ${numeric("refreshSeconds", t("kindle.refreshSeconds"), config.refreshSeconds, 15, 3600)}
        ${numeric("rowsPerPage", t("kindle.rowsPerPage"), config.rowsPerPage, 1, 8)}
        ${numeric("fontSize", t("kindle.fontSize"), config.fontSize, 18, 32)}
        <label class="field"><span>${e(t("kindle.selection"))}</span><select name="selection"><option value="all"${config.selection === "all" ? " selected" : ""}>${e(t("kindle.allDevices"))}</option><option value="custom"${config.selection === "custom" ? " selected" : ""}>${e(t("kindle.chooseItems"))}</option></select></label>
        </div><div id="kindle-custom"${config.selection === "all" ? " hidden" : ""}>
        <h2>${e(t("kindle.items"))}</h2><p class="muted">${e(t("kindle.itemsHelp"))}</p><div id="kindle-items"></div><p id="kindle-empty">${e(t("kindle.emptySelection"))}</p>
        <div class="bar"><label class="field"><span>${e(t("designer.element"))}</span><select id="kindle-add-device">${inventory.map((device) => `<option value="${e(device.key)}">${e(device.name)}${device.source === "group" ? ` · ${e(device.modelTitle)}` : ""}</option>`).join("")}</select></label><button id="kindle-add" class="btn" type="button"${inventory.length ? "" : " disabled"}>${e(t("kindle.addItem"))}</button></div></div>
        <div class="save-bar"><button id="kindle-save" class="btn btn-primary" type="submit">${e(t("kindle.save"))}</button><p id="settings-feedback" class="feedback" role="status" aria-live="polite"></p></div>
        <noscript><p>${e(t("kindle.javascript"))}</p></noscript></form></section>
        <section class="preview-section"><h2>${e(t("kindle.preview"))}</h2><p class="muted">${e(t("kindle.previewHelp"))}</p><div class="preview-scroll"><iframe id="kindle-preview" title="${e(t("kindle.preview"))}" src="/kindle?preview=1" width="758" height="1024"></iframe></div></section></div>`,
    css: `.kindle-workspace{display:grid;grid-template-columns:minmax(23rem,1fr) minmax(0,758px);gap:var(--s6);align-items:start;margin-block-start:var(--s5)}.kindle-workspace>section{min-width:0}.kindle-workspace>.preview-section{margin-block-start:0}.kindle-workspace select{max-width:100%}.kindle-workspace .bar .field{min-width:0;max-width:100%}.settings-fields,.item-fields{display:grid;grid-template-columns:1fr 1fr;gap:var(--s3)}.settings-fields .field:first-child{grid-column:1/-1}#kindle-items fieldset{border:0;border-block-start:var(--rule-w) solid var(--fg);padding:var(--s3) 0;margin-block:var(--s4)}.item-fields select,.item-fields input,.settings-fields input{min-width:0;width:100%}#kindle-items legend{max-width:100%;overflow-wrap:anywhere}.preview-scroll{width:100%;overflow:auto;border:var(--rule-w) solid var(--fg)}#kindle-preview{display:block;border:0;width:758px;height:1024px}.save-bar{margin-block-start:var(--s5);padding-block-start:var(--s4);border-block-start:var(--rule-w) solid var(--fg)}@media(max-width:72rem){.kindle-workspace{grid-template-columns:1fr}.preview-scroll{max-width:758px}}@media(max-width:35rem){.settings-fields,.item-fields{grid-template-columns:1fr}}`,
    script: SCRIPT, messages: ["kindle.", "cap.", "action.", "designer.element", "designer.wholeElement"],
  });
}
