/** Shared editor for all element types, including primitives without their own control page. */
import { escapeHtml, type PageContext } from "./shell";
import { tagLabel } from "../tags/model";
import type { TagPageData } from "../server/page-catalog";

export function renderTagEditor(ctx: PageContext, data: TagPageData): string {
  if (!data.elements.length) return "";
  const t = ctx.i18n.t;
  const current = data.elements[0]!;
  const assigned = data.tags.filter(tag => current.tagIds.includes(tag.id));
  return `<section class="element-tag-panel" data-tag-editor>
    <script type="application/json" nonce="${escapeHtml(ctx.nonce)}" data-tag-editor-data>${JSON.stringify(data).replaceAll("<", "\\u003c")}</script>
    <h2>${escapeHtml(t("tags.title"))}</h2>
    <div class="tag-element-choice"${data.elements.length === 1 ? " hidden" : ""}>
      <label class="field"><span>${escapeHtml(t("tags.findElement"))}</span><input data-tag-element-search type="search" autocomplete="off"></label>
      <label class="field"><span>${escapeHtml(t("tags.element"))}</span><select data-tag-element aria-label="${escapeHtml(t("tags.element"))}">${data.elements.map(element => `<option value="${escapeHtml(element.key)}">${escapeHtml(element.name)} · ${escapeHtml(t(`tags.kind.${element.kind}`))}${element.context ? ` · ${escapeHtml(element.context)}` : ""}</option>`).join("")}</select></label>
    </div>
    <div class="tag-chips" data-tag-chips>${assigned.length ? assigned.map(tag => `<span class="tag-chip" style="--tag-color:${escapeHtml(tag.color)}"><a href="${escapeHtml(tag.page)}" title="${escapeHtml(tag.description)}">${escapeHtml(tagLabel(tag))}</a><button type="button" data-remove-tag="${escapeHtml(tag.id)}" aria-label="${escapeHtml(t("tags.remove", { slug: tagLabel(tag) }))}">×</button></span>`).join("") : `<span class="muted small">${escapeHtml(t("tags.none"))}</span>`}</div>
    <div class="tag-composer"><label class="field"><span>${escapeHtml(t("tags.add"))}</span><input data-tag-input autocomplete="off" maxlength="200" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="tag-options" aria-describedby="tag-hint"></label><ul class="tag-options" id="tag-options" role="listbox" hidden></ul></div>
    <p class="note" id="tag-hint">${escapeHtml(t("tags.hint"))}</p><p class="feedback" role="status" data-tag-feedback></p><button type="button" class="btn" data-tag-refresh>${escapeHtml(t("tags.refresh"))}</button>
  </section>`;
}
export const TAG_CSS = String.raw`
.element-tag-panel { margin-block: var(--s5); border-top: var(--rule-w) solid var(--rule); padding-top: var(--s3); }
.tag-chips { display: flex; flex-wrap: wrap; gap: var(--s2); margin-block: var(--s3); }
.tag-chip { display: inline-flex; align-items: center; gap: .4rem; border: 1px solid var(--tag-color, var(--rule)); border-inline-start: .45rem solid var(--tag-color, var(--rule)); padding: .25rem .5rem; max-width: 100%; overflow-wrap: anywhere; }
.tag-chip a { color: inherit; text-decoration: none; }
.tag-chip button { border: 0; background: transparent; color: inherit; cursor: pointer; padding: .15rem .35rem; font-size: 1rem; }
.tag-composer { position: relative; max-width: 38rem; }
.tag-options { position: absolute; z-index: 10; top: 100%; left: 0; right: 0; margin: 0; padding: .3rem; list-style: none; max-height: 18rem; overflow-y: auto; border: 1px solid var(--rule); background: var(--bg); box-shadow: 0 4px 12px #0002; }
.tag-options [role=option] { padding: .6rem; cursor: pointer; overflow-wrap: anywhere; }
.tag-options [aria-selected=true], .tag-options [role=option]:hover { background: var(--panel); outline: 1px solid var(--rule); }
.tag-element-choice[hidden], .tag-options[hidden], [data-tag-editor][hidden] { display: none; }
.tag-manager h1 { overflow-wrap: anywhere; }
.tag-manager form { max-width: 42rem; }
.tag-manager .tag-description { white-space: pre-wrap; overflow-wrap: anywhere; }
.tag-manager .row-name, .tag-manager .row-meta { overflow-wrap: anywhere; min-width: 0; }
.tag-manager input[type=color] { width: 5rem; height: 2.7rem; padding: .2rem; }
.tag-element-choice { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr)); gap: var(--s3); }
`;

export const TAG_EDITOR_SCRIPT = String.raw`
(() => {
  const root = document.querySelector('[data-tag-editor]');
  if (!root) return;
  const el = (tag, text, parent) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (parent) parent.append(node); return node; };
  const t = (key, params) => ht.t('tags.' + key, params);
  const data = JSON.parse(root.querySelector('[data-tag-editor-data]').textContent);
  const elements = data.elements;
  let tags = data.tags, assigned = [], current = elements[0], busy = false, options = [], active = -1;
  const labelOf = tag => tag.name ? tag.name + ' = ' + tag.value : tag.value;
  const uuid = 'editor';
  const search = root.querySelector('[data-tag-element-search]');
  const select = root.querySelector('[data-tag-element]');
  const chips = root.querySelector('[data-tag-chips]');
  const input = root.querySelector('[data-tag-input]');
  const list = root.querySelector('[role=listbox]');
  const feedback = root.querySelector('[data-tag-feedback]');
  const refresh = root.querySelector('[data-tag-refresh]');
  assigned = tags.filter(tag => current.tagIds.includes(tag.id));
  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1; };
  const valid = value => value.trim().length > 0 && value.length <= 200 && !/\p{C}/u.test(value);
  const paint = () => {
    chips.replaceChildren();
    if (!assigned.length) { el('span', t('none'), chips).className = 'muted small'; }
    for (const tag of assigned) {
      const chip = el('span', undefined, chips); chip.className = 'tag-chip'; chip.style.setProperty('--tag-color', tag.color);
      const link = el('a', labelOf(tag), chip); link.href = tag.page; link.title = tag.description;
      const remove = el('button', '×', chip); remove.type = 'button'; remove.disabled = busy;
      remove.setAttribute('aria-label', t('remove', { slug: labelOf(tag) }));
      remove.dataset.removeTag = tag.id;
    }
  };
  const controls = () => { input.disabled = select.disabled = search.disabled = refresh.disabled = busy; paint(); };
  const loadTags = async () => { tags = (await ht.request('/api/tags')).tags; };
  const loadCurrent = () => {
    current = elements.find(element => element.key === select.value);
    close(); input.value = '';
    assigned = tags.filter(tag => current?.tagIds.includes(tag.id));
    input.disabled = !current; paint();
  };
  chips.addEventListener('click', event => {
    const button = event.target.closest('[data-remove-tag]');
    if (button) change('DELETE', undefined, button.dataset.removeTag);
  });
  const chooseElements = () => {
    const previous = ht.pageState.get('tag-element', elements[0]?.key || '');
    const query = search.value.toLocaleLowerCase(ht.locale);
    select.replaceChildren();
    for (const element of elements.filter(element => (element.name + ' ' + element.context + ' ' + element.kind).toLocaleLowerCase(ht.locale).includes(query))) {
      const option = el('option', element.name + ' · ' + t('kind.' + element.kind) + (element.context ? ' · ' + element.context : ''), select); option.value = element.key;
    }
    if ([...select.options].some(option => option.value === previous)) select.value = previous;
    loadCurrent();
  };
  const change = async (method, body, tagId) => {
    if (!current || busy) return;
    busy = true; close(); controls(); ht.say(feedback, ht.t('feedback.saving'));
    try {
      const result = await ht.request('/api/elements/' + current.key + '/tags' + (tagId ? '/' + tagId : ''), { method, ...(body ? { body: JSON.stringify(body) } : { body: '{}' }) });
      assigned = result.tags; current.tagIds = assigned.map(tag => tag.id);
      for (const tag of assigned) if (!tags.some(item => item.id === tag.id)) tags.push(tag);
      input.value = ''; ht.say(feedback, ht.t('feedback.saved'), 'ok');
      window.dispatchEvent(new CustomEvent('tags-changed'));
    } catch (error) { ht.say(feedback, error.message, 'bad'); }
    finally { busy = false; controls(); input.focus(); }
  };
  const add = option => {
    if (option?.tag) change('POST', { tagId: option.tag.id });
    else if (valid(input.value)) change('POST', { value: input.value });
    else ht.say(feedback, t('invalidSlug'), 'bad');
  };
  const suggestions = () => {
    options = []; active = -1; list.replaceChildren();
    const query = input.value.toLocaleLowerCase(ht.locale);
    for (const tag of tags.filter(tag => !assigned.some(item => item.id === tag.id) && labelOf(tag).toLocaleLowerCase(ht.locale).includes(query)).slice(0, 12)) options.push({ tag, label: labelOf(tag) });
    if (valid(input.value) && !tags.some(tag => labelOf(tag) === input.value)) options.push({ label: t('createSuggestion', { value: input.value }) });
    options.forEach((option, index) => {
      const item = el('li', option.label, list); item.id = 'tag-option-' + uuid + '-' + index; item.setAttribute('role', 'option'); item.setAttribute('aria-selected', 'false');
      item.addEventListener('pointerdown', event => event.preventDefault());
      item.addEventListener('click', () => add(option));
    });
    list.hidden = !options.length; input.setAttribute('aria-expanded', String(!list.hidden)); input.removeAttribute('aria-activedescendant');
  };
  input.addEventListener('input', suggestions);
  input.addEventListener('focus', () => { if (!busy && current) suggestions(); });
  input.addEventListener('blur', close);
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape') { close(); return; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); if (list.hidden) suggestions(); if (!options.length) return;
      active = (active + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
      [...list.children].forEach((child, index) => child.setAttribute('aria-selected', String(index === active)));
      input.setAttribute('aria-activedescendant', list.children[active].id); list.children[active].scrollIntoView({ block: 'nearest' });
    }
    if (event.key === 'Enter') { event.preventDefault(); add(active >= 0 ? options[active] : options.find(option => option.tag && labelOf(option.tag) === input.value)); }
  });
  search.addEventListener('input', () => ht.pageState.update({ 'tag-search': search.value }, { replace: true }));
  select.addEventListener('change', () => ht.pageState.update({ 'tag-element': select.value }));
  let initialized = false;
  ht.pageState.watch(['tag-search', 'tag-element'], query => {
    search.value = query.get('tag-search') ?? '';
    if (initialized || query.has('tag-search') || query.has('tag-element')) chooseElements();
    initialized = true;
  });
  refresh.addEventListener('click', async () => {
    try {
      const key = current?.key;
      const result = await ht.request('/api/elements/' + key + '/tags');
      await loadTags();
      const element = elements.find(element => element.key === key);
      if (element) element.tagIds = result.tags.map(tag => tag.id);
      loadCurrent();
    } catch (error) { ht.say(feedback, error.message, 'bad'); }
  });

})();
`;
