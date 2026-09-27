import { eventSelectionCondition, readEventSelection } from "../models/event-selection";
import { escapeHtml, type PageContext } from "./shell";

export function renderSavedFilterControls(ctx: PageContext): string {
  const label = (key: Parameters<typeof ctx.i18n.t>[0]) => escapeHtml(ctx.i18n.t(key));
  return `<form id="saved-filter-form">
    <fieldset id="filter-time" aria-describedby="filter-time-hint">
      <legend>${label("filters.time")}</legend>
      <div class="filters">
        <label><input type="checkbox" id="filter-time-enabled">${label("filters.timeEnabled")}</label>
        <label>${label("filters.timeStart")}<input type="time" id="filter-time-start" value="20:00" step="60" disabled required></label>
        <label>${label("filters.timeEnd")}<input type="time" id="filter-time-end" value="08:00" step="60" disabled required></label>
        <label>${label("filters.timeZone")}<input id="filter-time-zone" list="filter-time-zones" maxlength="100" autocomplete="off" disabled required></label>
        <datalist id="filter-time-zones"></datalist>
      </div>
      <p class="hint" id="filter-time-hint">${label("filters.timeHint")}</p>
    </fieldset>
    <div class="filters">
      <label>${label("filters.saved")}<select id="saved-filter"><option value="">${label("filters.new")}</option></select></label>
      <label>${label("filters.name")}<input id="filter-name" required maxlength="200" autocomplete="off"></label>
      <button type="submit" class="btn">${label("filters.saveNew")}</button>
      <button type="button" class="btn" id="filter-update" disabled>${label("filters.update")}</button>
      <button type="button" class="btn" id="filter-delete" disabled>${label("filters.delete")}</button>
    </div>
    <p class="feedback" id="filter-feedback" role="status" aria-live="polite"></p>
    <details><summary>${label("filters.definition")}</summary><pre id="filter-definition"></pre></details>
  </form>`;
}

/** Shared selection functions are also used by the API and exercised without a browser. */
export const EVENT_FILTER_CONTROLS_SCRIPT = String.raw`
const readEventSelection = ${readEventSelection.toString()};
const eventSelectionCondition = ${eventSelectionCondition.toString()};
const mountEventFilterControls = ({ root, subjectFilter, typeFilter, detectionFilter, addDetectionOptions, apply, clear }) => {
  const form = document.querySelector('#saved-filter-form');
  const menu = document.querySelector('#saved-filter');
  const name = document.querySelector('#filter-name');
  const update = document.querySelector('#filter-update');
  const remove = document.querySelector('#filter-delete');
  const feedback = document.querySelector('#filter-feedback');
  const definition = document.querySelector('#filter-definition');
  const timeEnabled = document.querySelector('#filter-time-enabled');
  const timeStart = document.querySelector('#filter-time-start');
  const timeEnd = document.querySelector('#filter-time-end');
  const timeZone = document.querySelector('#filter-time-zone');
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zones = document.querySelector('#filter-time-zones');
  if (zones) for (const zone of new Set(['UTC', localZone, ...(Intl.supportedValuesOf?.('timeZone') || [])])) {
    const item = document.createElement('option'); item.value = zone; zones.append(item);
  }
  let condition = { all: [] }, saved = null, catalog = null, valid = false, timeValid = true, busy = false, generation = 0;
  const blank = () => eventSelectionCondition({ subjects: root.dataset.subject ? [root.dataset.subject] : [], type: '', labels: [], other: [] });
  const subjectInputs = () => subjectFilter ? [...subjectFilter.querySelectorAll('input[name=event-subject]')] : [];
  const showSubjects = (subjects) => {
    if (!subjectFilter) return;
    const options = subjectFilter.querySelector('.subject-options');
    for (const value of subjects) {
      if (subjectInputs().some(input => input.value === value)) continue;
      const label = document.createElement('label'), input = document.createElement('input'), text = document.createElement('span');
      input.type = 'checkbox'; input.setAttribute('name', 'event-subject'); input.value = value; text.textContent = value;
      label.append(input, text); options.append(label);
    }
    const selected = [];
    for (const input of subjectInputs()) {
      input.checked = subjects.includes(input.value);
      if (input.checked) selected.push(input.closest('label').querySelector('span').textContent);
    }
    subjectFilter.querySelector('.subject-selection').textContent = selected.length ? selected.join(', ') : ht.t('services.filter.all');
    subjectFilter.querySelector('button').disabled = !selected.length;
  };
  const buttons = () => {
    if (!form) return;
    form.querySelector('button[type=submit]').disabled = busy || !valid || !timeValid;
    update.disabled = busy || !valid || !timeValid || !saved;
    remove.disabled = busy || !valid || !saved;
    menu.disabled = busy;
  };
  const option = (record) => {
    if (!menu) return;
    let item = [...menu.options].find(item => item.dataset.id === record.filter.id);
    if (!item) { item = document.createElement('option'); item.dataset.id = record.filter.id; menu.append(item); }
    item.value = record.slug;
    item.textContent = record.filter.name;
  };
  const refresh = async () => (await ht.request('/api/filters')).filters;
  const showMenu = (records) => {
    catalog = records;
    if (!menu) return;
    const selected = menu.value;
    for (const item of [...menu.options].slice(1)) item.remove();
    for (const record of records) option(record);
    menu.value = selected;
  };
  const show = (next) => {
    const selection = readEventSelection(next);
    condition = next;
    showSubjects(selection.subjects);
    for (const [control, value] of [[typeFilter, selection.type]]) {
      if (!control) continue;
      if (value && ![...control.options].some(item => item.value === value)) {
        const item = document.createElement('option'); item.value = value; item.textContent = value; control.append(item);
      }
      control.value = value;
    }
    addDetectionOptions(selection.labels);
    if (detectionFilter) for (const input of detectionFilter.querySelectorAll('input')) input.checked = selection.labels.includes(input.value);
    if (timeEnabled) {
      timeEnabled.checked = !!selection.timeWindow;
      timeStart.value = selection.timeWindow?.start || '20:00';
      timeEnd.value = selection.timeWindow?.end || '08:00';
      timeZone.value = selection.timeWindow?.timeZone || localZone;
      for (const input of [timeStart, timeEnd, timeZone]) input.disabled = !timeEnabled.checked;
    }
    if (definition) definition.textContent = JSON.stringify(condition, null, 2);
    valid = true; timeValid = true; buttons(); apply(condition);
  };
  const edit = () => {
    if (!valid) return;
    const selection = readEventSelection(condition);
    let timeWindow = selection.timeWindow;
    const recovering = !timeValid;
    timeValid = true;
    if (timeEnabled) {
      for (const input of [timeStart, timeEnd, timeZone]) input.disabled = !timeEnabled.checked;
      timeWindow = undefined;
      if (timeEnabled.checked) {
        const start = timeStart.value, end = timeEnd.value, zone = timeZone.value.trim();
        const clock = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;
        let problem = '';
        if (!clock.test(start) || !clock.test(end)) problem = ht.t('filters.timeRequired');
        else if (start === end) problem = ht.t('filters.timeDifferent');
        else {
          try {
            if (!zone || /^[+-]/.test(zone)) throw new Error();
            new Intl.DateTimeFormat('en', { timeZone: zone });
          } catch { problem = ht.t('filters.timeZoneInvalid'); }
        }
        if (problem) { timeValid = false; clear(); buttons(); ht.say(feedback, problem, 'bad'); return; }
        timeWindow = { ...selection.timeWindow, start, end, timeZone: zone };
      }
    }
    buttons();
    const next = eventSelectionCondition({
      subjects: subjectFilter ? subjectInputs().filter(input => input.checked).map(input => input.value) : selection.subjects.length ? selection.subjects : root.dataset.subject ? [root.dataset.subject] : [],
      type: typeFilter ? typeFilter.value : selection.type,
      labels: detectionFilter ? [...detectionFilter.querySelectorAll('input:checked')].map(input => input.value).sort() : selection.labels,
      timeWindow,
      other: selection.other,
    });
    // Reapply even if correcting an invalid input returns to the same URL.
    if (recovering) show(next);
    ht.say(feedback, ht.t('filters.unsaved'));
    ht.pageState.update({ filter: null, where: JSON.stringify(next), 'editing-filter': saved?.slug });
  };
  for (const control of [subjectFilter, typeFilter]) control?.addEventListener('change', edit);
  for (const control of [timeEnabled, timeStart, timeEnd, timeZone]) control?.addEventListener('change', edit);
  if (subjectFilter) {
    subjectFilter.querySelector('button').addEventListener('click', () => { showSubjects([]); edit(); });
    subjectFilter.addEventListener('keydown', event => {
      if (event.key === 'Escape') { subjectFilter.open = false; subjectFilter.querySelector('summary').focus(); }
    });
    document.addEventListener('click', event => { if (!subjectFilter.contains(event.target)) subjectFilter.open = false; });
    subjectFilter.addEventListener('focusout', event => { if (event.relatedTarget && !subjectFilter.contains(event.relatedTarget)) subjectFilter.open = false; });
  }
  if (detectionFilter) {
    detectionFilter.addEventListener('change', edit);
    detectionFilter.querySelector('button').addEventListener('click', () => {
      for (const input of detectionFilter.querySelectorAll('input')) input.checked = false;
      edit();
    });
  }
  menu?.addEventListener('change', () => ht.pageState.update({ filter: menu.value || null, where: null, 'editing-filter': null }));
  name?.addEventListener('input', () => ht.say(feedback, ht.t('filters.unsaved')));
  const save = async (replace) => {
    if (busy || !valid || !timeValid || !form.reportValidity()) return;
    if (!name.value.trim()) { name.setCustomValidity(ht.t('filters.nameRequired')); name.reportValidity(); name.setCustomValidity(''); return; }
    const current = saved, at = generation;
    if (replace && !current) return;
    const input = { name: name.value.trim(), condition,
      ...(current?.filter.description === undefined ? {} : { description: current.filter.description }),
      ...(replace ? { revision: current.revision } : {}) };
    busy = true; buttons(); ht.say(feedback, '');
    try {
      const record = await ht.request('/api/filters' + (replace ? '/' + encodeURIComponent(current.filter.id) : ''),
        { method: replace ? 'PUT' : 'POST', body: JSON.stringify(input) });
      const records = await refresh();
      if (at !== generation) return;
      showMenu(records);
      saved = record; menu.value = record.slug;
      // Updating a saved Filter may keep the URL unchanged, so also apply the returned definition.
      show(record.filter.condition);
      ht.pageState.update({ filter: record.slug, where: null, 'editing-filter': null });
      ht.say(feedback, ht.t('filters.savedNotice'), 'ok');
    } catch (error) { ht.say(feedback, error.message, 'bad'); }
    finally { busy = false; buttons(); }
  };
  form?.addEventListener('submit', event => { event.preventDefault(); void save(false); });
  update?.addEventListener('click', () => void save(true));
  remove?.addEventListener('click', async () => {
    if (busy || !saved) return;
    const current = saved, at = generation;
    busy = true; buttons();
    try {
      await ht.request('/api/filters/' + encodeURIComponent(current.filter.id) + '?revision=' + current.revision, { method: 'DELETE', body: '{}' });
      const records = await refresh();
      if (at !== generation) return;
      showMenu(records);
      saved = null;
      ht.pageState.update({ filter: null, where: JSON.stringify(condition), 'editing-filter': null });
      ht.say(feedback, ht.t('filters.deletedNotice'), 'ok');
    } catch (error) { ht.say(feedback, error.message, 'bad'); }
    finally { busy = false; buttons(); }
  });
  ht.pageState.watch(['filter', 'where', 'editing-filter'], async params => {
    const at = ++generation;
    valid = false; clear(); buttons();
    const slug = params.get('filter') ?? params.get('editing-filter');
    try {
      // Local edits retain the revision being edited and do not wait on another catalog read.
      const records = params.has('where') && catalog && (slug === null || saved?.slug === slug)
        ? catalog : await refresh().catch(error => { if (slug !== null) throw error; return []; });
      if (at !== generation) return;
      showMenu(records);
      const current = slug === null ? null : records.find(record => record.slug === slug);
      if (slug !== null && !current) throw new Error(ht.t('filters.notFound'));
      const record = current && saved?.filter.id === current.filter.id && params.has('editing-filter') ? saved : current;
      const preserveName = params.has('editing-filter') && saved?.filter.id === record?.filter.id;
      saved = record;
      if (name && !preserveName) name.value = record?.filter.name || '';
      if (menu) menu.value = current?.slug || '';
      const draft = params.has('where') ? JSON.parse(params.get('where')) : null;
      show(params.has('where') ? record && params.has('filter') ? { all: [record.filter.condition, draft] } : draft : record?.filter.condition || blank());
      ht.say(feedback, params.has('where') ? ht.t('filters.unsaved') : '');
    } catch (error) {
      if (at !== generation) return;
      valid = false; saved = null; buttons(); ht.say(feedback, error.message, 'bad');
    }
  });
};
`;
