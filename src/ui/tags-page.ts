import { DEFAULT_TAG_COLOR, tagPage, tagLabel, type Tag, type TagName } from "../tags/model";
import type { Element } from "../tags/elements";
import { isTaggable } from "../tags/identity";
import { escapeHtml, renderPage, type PageContext } from "./shell";

export const TAG_MANAGER_SCRIPT = String.raw`
(() => {
  const root = document.querySelector('[data-tag-manager]');
  if (!root) return;
  const t = (key, params) => ht.t('tags.' + key, params);
  const el = (tag, text, parent) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (parent) parent.append(node); return node; };
  const form = root.querySelector('[data-tag-form]');
  const feedback = root.querySelector('[data-tag-manager-feedback]');
  const rows = root.querySelector('[data-tag-rows]');
  const search = root.querySelector('[data-tag-search]');
  const kind = root.querySelector('[data-element-kind]');
  const more = root.querySelector('[data-tag-more]');
  const count = root.querySelector('[data-tag-count]');
  const elementsView = root.dataset.view === 'elements';
  const data = JSON.parse(root.querySelector('[data-tag-data]').textContent);
  const tags = data.tags, tagsById = new Map(tags.map(tag => [tag.id, tag]));
  let limit = 100;
  const label = tag => tag.name ? tag.name + ' = ' + tag.value : tag.value;
  const chip = (tag, parent) => { const node = el('span', undefined, parent); node.className = 'tag-chip'; node.style.setProperty('--tag-color', tag.color); const link = el('a', label(tag), node); link.href = tag.page; link.title = tag.description; };
  const paint = () => {
    const requested = Number(ht.pageState.get('limit', '100'));
    limit = Number.isSafeInteger(requested) && requested >= 100 ? Math.min(requested, Math.max(100, data.elements.length)) : 100;
    const query = search.value.toLocaleLowerCase(ht.locale);
    rows.replaceChildren();
    if (!elementsView) {
      for (const tag of tags.filter(tag => (label(tag) + ' ' + tag.description).toLocaleLowerCase(ht.locale).includes(query))) {
        const row = el('li', undefined, rows); const link = el('a', undefined, row); link.className = 'row'; link.href = tag.page;
        const name = el('span', label(tag), link); name.className = 'row-name'; name.style.borderInlineStart = '.45rem solid ' + tag.color; name.style.paddingInlineStart = '.6rem';
        el('span', tag.description, link).className = 'row-meta'; el('span', t('elementCount', { count: data.counts[tag.id] || 0 }), link).className = 'row-side small';
      }
      count.textContent = t('tagCount', { count: rows.children.length });
    } else {
      const matches = data.elements.filter(element => (!kind.value || element.kind === kind.value) && (element.name + ' ' + element.context + ' ' + element.kind).toLocaleLowerCase(ht.locale).includes(query));
      for (const element of matches.slice(0, limit)) {
        const row = el('li', undefined, rows); const line = el('div', undefined, row); line.className = 'row';
        const link = el('a', element.name, line); link.className = 'row-name'; link.href = element.page;
        el('span', t('kind.' + element.kind) + (element.context ? ' · ' + element.context : ''), line).className = 'row-meta';
        const pills = el('span', undefined, line); pills.className = 'tag-chips';
        for (const id of element.tagIds) { const tag = tagsById.get(id); if (tag) chip(tag, pills); }
      }
      count.textContent = t('elementCount', { count: matches.length });
      more.hidden = limit >= matches.length;
    }
  };
  if (form) form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('button[type=submit]'); if (button.disabled) return;
    const name = form.elements.name.value.trim();
    const value = form.elements.value.value.trim();
    if (!value || value.length > 200) { ht.say(feedback, t('invalidSlug'), 'bad'); return; }
    if (name && (name.length > 200 || /[^A-Za-z0-9-]/.test(name))) { ht.say(feedback, t('invalidSlug'), 'bad'); return; }
    button.disabled = true; ht.say(feedback, ht.t('feedback.saving'));
    const tagId = root.dataset.tagId;
    const body = { name, value, color: form.elements.color.value, description: form.elements.description.value, ...(tagId ? { revision: Number(root.dataset.revision) } : {}) };
    try {
      const result = await ht.request('/api/tags' + (tagId ? '/' + tagId : ''), { method: tagId ? 'PATCH' : 'POST', body: JSON.stringify(body) });
      location.assign(result.page);
    } catch (error) { ht.say(feedback, error.message, 'bad'); button.disabled = false; }
  });
  search.addEventListener('input', () => ht.pageState.update({ q: search.value, limit: null }, { replace: true }));
  kind?.addEventListener('change', () => ht.pageState.update({ kind: kind.value, limit: null }));
  more?.addEventListener('click', () => ht.pageState.update({ limit: limit + 100 }));
  let initialized = false;
  ht.pageState.watch(['q', 'kind', 'limit'], query => {
    search.value = query.get('q') ?? '';
    if (kind) kind.value = [...kind.options].some(option => option.value === query.get('kind')) ? query.get('kind') : '';
    if (initialized || ['q', 'kind', 'limit'].some(key => query.has(key))) paint();
    initialized = true;
  });

})();
`;

function tagForm(ctx: PageContext, tag?: Tag): string {
  const { t } = ctx.i18n;
  return `<form data-tag-form>
    <label class="field"><span>${escapeHtml(t("tags.name"))}</span><input name="name" value="${escapeHtml(tag?.name ?? "")}" maxlength="200" autocomplete="off" spellcheck="false" placeholder="room"></label>
    <p class="note">${escapeHtml(t("tags.nameHint"))}</p>
    <label class="field"><span>${escapeHtml(t("tags.value"))}</span><input name="value" value="${escapeHtml(tag?.value ?? "")}" required maxlength="200" autocomplete="off" placeholder="Master Bathroom"></label>
    <label class="field"><span>${escapeHtml(t("tags.color"))}</span><input type="color" name="color" value="${escapeHtml(tag?.color ?? DEFAULT_TAG_COLOR)}"></label>
    <label class="field"><span>${escapeHtml(t("tags.description"))}</span><textarea name="description" aria-label="${escapeHtml(t("tags.description"))}" rows="3" maxlength="4000">${escapeHtml(tag?.description ?? "")}</textarea></label>
    <button class="btn btn-primary" type="submit">${escapeHtml(t(tag ? "tags.save" : "tags.create"))}</button>
  </form>`;
}

export function renderTagsPage(ctx: PageContext, view: "tags" | "elements", tag?: Tag, data: { tags: readonly Tag[]; elements: readonly (Element & { tagIds: string[] })[] } = { tags: [], elements: [] }): string {
  const { t } = ctx.i18n;
  const elements = view === "elements";
  const title = tag ? tag.value : t(elements ? "tags.elements" : "tags.title");
  const selection = data.elements.filter(element => !tag || element.tagIds.includes(tag.id));
  const counts = new Map<string, number>();
  for (const element of data.elements) for (const id of element.tagIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  const tagsById = new Map(data.tags.map(tag => [tag.id, tag]));
  const rows = elements ? selection.slice(0, 100).map(element => `<li><div class="row"><a class="row-name" href="${escapeHtml(element.page)}">${escapeHtml(element.name)}</a><span class="row-meta">${escapeHtml(t(`tags.kind.${element.kind}`))}${element.context ? ` · ${escapeHtml(element.context)}` : ""}</span><span class="tag-chips">${element.tagIds.flatMap(id => { const tag = tagsById.get(id); return tag ? [`<a class="tag-chip" href="${escapeHtml(tagPage(tag))}">${escapeHtml(tagLabel(tag))}</a>`] : []; }).join("")}</span></div></li>`).join("")
    : data.tags.map(tag => `<li><a class="row" href="${escapeHtml(tagPage(tag))}"><span class="row-name">${escapeHtml(tagLabel(tag))}</span><span class="row-meta">${escapeHtml(tag.description)}</span><span class="row-side small">${escapeHtml(t("tags.elementCount", { count: counts.get(tag.id) ?? 0 }))}</span></a></li>`).join("");
  const seed = JSON.stringify({ tags: data.tags.map(tag => ({ ...tag, page: tagPage(tag) })), elements: elements ? selection : [], counts: Object.fromEntries(counts) }).replaceAll("<", "\\u003c");
  const kinds = [...new Set(data.elements.map(element => element.kind))].sort();
  return renderPage({ ctx, title, nav: "tags", messages: ["tags."], script: TAG_MANAGER_SCRIPT,
    body: `<div class="tag-manager" data-tag-manager data-view="${view}"${tag ? ` data-tag-id="${escapeHtml(tag.id)}" data-revision="${tag.revision}"` : ""}>
      <script type="application/json" nonce="${escapeHtml(ctx.nonce)}" data-tag-data>${seed}</script>
      <h1>${escapeHtml(title)}</h1>
      <nav class="tabs" aria-label="${escapeHtml(t("tags.title"))}"><a href="/tags"${!elements && !tag ? ' aria-current="page"' : ""}>${escapeHtml(t("tags.title"))}</a><a href="/tags?view=elements"${elements && !tag ? ' aria-current="page"' : ""}>${escapeHtml(t("tags.elements"))}</a></nav>
      ${tag ? `<p class="note">${escapeHtml(t("tags.renameHint"))}</p>${tagForm(ctx, tag)}` : !elements ? `<details><summary>${escapeHtml(t("tags.create"))}</summary>${tagForm(ctx)}</details>` : `<p class="note">${escapeHtml(t("tags.elementsHint"))}</p>`}
      <p class="feedback" role="status" data-tag-manager-feedback></p>
      ${tag ? `<h2>${escapeHtml(t("tags.taggedElements"))}</h2>` : ""}
      <label class="field"><span>${escapeHtml(t(elements ? "tags.findElement" : "tags.search"))}</span><input type="search" data-tag-search autocomplete="off"></label>
      ${elements ? `<label class="field"><span>${escapeHtml(t("tags.kind"))}</span><select data-element-kind aria-label="${escapeHtml(t("tags.kind"))}"><option value="">${escapeHtml(t("tags.allKinds"))}</option>${kinds.map(kind => `<option value="${escapeHtml(kind)}">${escapeHtml(t(`tags.kind.${kind}`))}</option>`).join("")}</select></label>` : ""}
      <p class="note" data-tag-count>${escapeHtml(t(elements ? "tags.elementCount" : "tags.tagCount", { count: elements ? selection.length : data.tags.length }))}</p><ul class="rows" data-tag-rows aria-busy="false">${rows}</ul>
      ${elements ? `<button class="btn" data-tag-more${selection.length <= 100 ? " hidden" : ""}>${escapeHtml(t("tags.more"))}</button>` : ""}
    </div>` });
}

export function renderElementTagsPage(ctx: PageContext, element: Element): string {
  const { t } = ctx.i18n;
  // Tags are not elements: nothing here can carry a tag, so the editor is not
  // rendered at all rather than shown and refused by the API.
  const taggable = isTaggable(element.kind);
  return renderPage({ ctx, title: element.name, nav: "tags", messages: ["tags."],
    body: `<h1>${escapeHtml(element.name)}</h1><p>${escapeHtml(t(`tags.kind.${element.kind}`))}${element.context ? ` · ${escapeHtml(element.context)}` : ""}</p>
      <div class="bar"><a class="btn" href="/tags?view=elements">${escapeHtml(t("tags.elements"))}</a><a class="btn" href="/elements/${escapeHtml(element.key)}/graph">${escapeHtml(t("device.tabs.graph"))}</a>${element.sourcePage ? `<a class="btn" href="${escapeHtml(element.sourcePage)}">${escapeHtml(t("tags.open"))}</a>` : ""}</div>
      ${taggable
        ? `${ctx.tagEditor?.(element.key) ?? ""}`
        : `<p class="note">${escapeHtml(t("tags.cannotTag"))}</p>`}` });
}

/**
 * One tag name and every value under it: `/tags/room` is every room. A name is
 * not a tag, so there is nothing to tag here and no editor — just the values,
 * each linking to its own page where it can be renamed.
 */
export function renderTagNamePage(ctx: PageContext, name: TagName, tags: readonly (Tag & { page: string })[]): string {
  const { t } = ctx.i18n;
  const rows = tags.map(tag => `<li><a class="row" href="${escapeHtml(tag.page)}">
    <span class="row-name" style="border-inline-start:.45rem solid ${escapeHtml(tag.color)};padding-inline-start:.6rem">${escapeHtml(tag.value)}</span>
    <span class="row-meta">${escapeHtml(tag.description)}</span></a></li>`).join("");
  return renderPage({ ctx, title: name.label, nav: "tags", messages: ["tags."],
    body: `<h1>${escapeHtml(name.label)}</h1>
      <nav class="tabs" aria-label="${escapeHtml(t("tags.title"))}"><a href="/tags">${escapeHtml(t("tags.title"))}</a><a href="/tags?view=elements">${escapeHtml(t("tags.elements"))}</a></nav>
      <p class="note">${escapeHtml(t("tags.cannotTag"))}</p>
      <p class="note">${escapeHtml(t("tags.tagCount", { count: tags.length }))}</p>
      <ul class="rows">${rows}</ul>` });
}
