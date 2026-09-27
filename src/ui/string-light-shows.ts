import { escapeHtml, type PageContext } from "./shell";

export function renderLightShows(ctx: PageContext): string {
  const text = (key: Parameters<typeof ctx.i18n.t>[0]) => escapeHtml(ctx.i18n.t(key));
  return `<section data-light-scenes hidden>
    <h2>${text("stringLight.scenes")}</h2>
    <p class="note">${text("stringLight.scenesHelp")}</p>
    <div class="field"><label for="light-scene">${text("stringLight.chooseScene")}</label><select id="light-scene"></select></div>
    <p class="note">${text("stringLight.previewHelp")}</p>
    <ol id="scene-preview" class="scene-preview" aria-label="${text("stringLight.preview")}"></ol>
    <button type="button" class="btn btn-primary" id="scene-apply">${text("stringLight.applyScene")}</button>
    <p id="scene-status" role="status" aria-live="polite"></p>
    <p id="scene-feedback" class="feedback" role="status" aria-live="polite"></p>
  </section>
  <section data-light-shows hidden>
    <h2>${text("stringLight.shows")}</h2>
    <p class="note">${text("stringLight.showsHelp")}</p>
    <div class="field"><label for="light-show">${text("stringLight.chooseShow")}</label><select id="light-show"></select></div>
    <p id="show-steps" class="note"></p>
    <div class="field" id="show-duration-field" hidden><label for="show-duration">${text("stringLight.stepDuration")}</label><input id="show-duration" type="number" min="10" max="600" step="1" value="45"></div>
    <div class="bar"><button type="button" class="btn btn-primary" id="show-play">${text("stringLight.playShow")}</button><button type="button" class="btn" id="show-stop" disabled>${text("stringLight.stopShow")}</button></div>
    <p id="show-status" role="status" aria-live="polite"></p>
    <p class="note">${text("stringLight.stopHelp")}</p>
    <p id="show-feedback" class="feedback" role="status" aria-live="polite"></p>
  </section>
  <details data-govee-presets hidden>
    <summary>${text("stringLight.presets")}</summary>
    <p class="note">${text("stringLight.presetsHelp")}</p>
    <div class="field"><label for="govee-preset">${text("stringLight.choosePreset")}</label><select id="govee-preset"></select></div>
    <div class="bar"><button type="button" class="btn btn-primary" id="preset-apply">${text("stringLight.applyPreset")}</button><button type="button" class="btn" id="preset-stop" disabled>${text("stringLight.stopPreset")}</button></div>
    <p id="preset-status" role="status" aria-live="polite"></p>
    <p id="preset-feedback" class="feedback" role="status" aria-live="polite"></p>
  </details>`;
}

/**
 * Scenes, shows, and presets for a string light. The `<ht-light>` on the page
 * owns the live document: every frame it receives bubbles as `ht:frame`, and
 * this script paints the stringLight capability from that frame. Its own
 * commands go through the generic capability route and paint the response;
 * the server publishes the re-read document before it answers, so the
 * element's next frame (and the 5 s live cadence while a show runs) carries
 * the change without this script asking for a read of its own — neither
 * Light nor StringLight declares `getState`.
 */
export const LIGHT_SHOWS_SCRIPT = String.raw`
(() => {
  const light = document.querySelector('ht-light[node^="device/"]');
  const section = document.querySelector('[data-light-shows]');
  if (!light || !section) return;
  const sceneSection = document.querySelector('[data-light-scenes]');
  const presetSection = document.querySelector('[data-govee-presets]');
  const select = document.querySelector('#light-show');
  const sceneSelect = document.querySelector('#light-scene');
  const presetSelect = document.querySelector('#govee-preset');
  const preview = document.querySelector('#scene-preview');
  const duration = document.querySelector('#show-duration');
  const durationField = document.querySelector('#show-duration-field');
  const description = document.querySelector('#show-steps');
  const play = document.querySelector('#show-play');
  const stop = document.querySelector('#show-stop');
  const applyScene = document.querySelector('#scene-apply');
  const applyPreset = document.querySelector('#preset-apply');
  const stopPreset = document.querySelector('#preset-stop');
  const status = document.querySelector('#show-status');
  const sceneStatus = document.querySelector('#scene-status');
  const presetStatus = document.querySelector('#preset-status');
  const feedback = document.querySelector('#show-feedback');
  const sceneFeedback = document.querySelector('#scene-feedback');
  const presetFeedback = document.querySelector('#preset-feedback');
  const endpoint = '/api/devices/' + encodeURIComponent(light.getAttribute('node').slice('device/'.length));
  let shows = [], scenes = [], presets = [];
  const defaultSelections = {};
  let current = { status: 'idle' };
  let busy = false;
  let actions = {};
  let lightCount = 0;
  const chosen = () => shows.find(show => show.id === select.value);
  const nameOf = id => [...shows, ...scenes, ...presets].find(item => item.id === id)?.name || id;
  const selection = () => {
    const show = chosen();
    durationField.hidden = show?.kind !== 'sequence';
    description.textContent = show?.steps?.map(nameOf).join(' → ') || ht.t('stringLight.singleAnimation');
  };
  const previewScene = () => {
    const scene = scenes.find(item => item.id === sceneSelect.value);
    preview.replaceChildren();
    if (!scene?.colors?.length) return;
    for (let i = 0; i < lightCount; i++) {
      const color = scene.colors[i % scene.colors.length];
      const bulb = document.createElement('li');
      bulb.textContent = i + 1;
      bulb.style.backgroundColor = color;
      const rgb = color.match(/[0-9a-f]{2}/gi)?.map(part => parseInt(part, 16)) || [0, 0, 0];
      bulb.style.color = (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000 > 145 ? '#111111' : '#ffffff';
      const label = ht.t('stringLight.position', { position: i + 1 }) + ': ' + color;
      bulb.title = label; bulb.setAttribute('aria-label', label);
      preview.append(bulb);
    }
  };
  const controls = () => {
    play.disabled = busy || !actions.playShow || !chosen();
    stop.disabled = busy || !actions.stopShow || !current.showId || current.status === 'idle';
    applyScene.disabled = busy || !actions.applyScene || !sceneSelect.value;
    applyPreset.disabled = busy || !actions.applyPreset || !presetSelect.value;
    stopPreset.disabled = busy || !actions.stopShow || !current.presetId || current.status === 'idle';
    for (const input of [select, duration, sceneSelect, presetSelect]) input.disabled = busy;
  };
  const options = (input, next, previous, active) => {
    if (JSON.stringify(next) === JSON.stringify(previous)) return next;
    const key = input === select ? 'show' : input === sceneSelect ? 'scene' : 'preset';
    defaultSelections[key] = next.some(item => item.id === active) ? active : next[0]?.id || '';
    const selected = ht.pageState.get(key) || input.value || defaultSelections[key];
    input.replaceChildren();
    for (const category of [...new Set(next.map(item => item.category || ''))]) {
      const group = category ? document.createElement('optgroup') : input;
      if (category) group.label = category;
      for (const item of next.filter(item => (item.category || '') === category)) {
        const option = document.createElement('option');
        option.value = item.id; option.textContent = item.name; group.append(option);
      }
      if (category) input.append(group);
    }
    if (next.some(item => item.id === selected)) input.value = selected;
    return next;
  };
  const paint = doc => {
    if (doc?.object) doc = doc.object.capabilities.stringLight;
    if (!doc) return;
    actions = doc.actions || {};
    const state = doc.state || {};
    section.hidden = !actions.playShow;
    sceneSection.hidden = !actions.applyScene;
    presetSection.hidden = !actions.applyPreset || !state.presets?.length;
    current = state.show || { status: 'idle' };
    const currentScene = state.scene || { status: 'idle' };
    shows = options(select, state.shows || [], shows, current.showId);
    scenes = options(sceneSelect, state.scenes || [], scenes, currentScene.sceneId);
    presets = options(presetSelect, state.presets || [], presets, current.presetId);
    lightCount = state.lightCount || 0;
    if (current.showId && current.status === 'running') status.textContent = ht.t('stringLight.running', { show: nameOf(current.showId), step: nameOf(current.effectId) });
    else if (current.showId && current.status === 'submitted') status.textContent = ht.t('stringLight.submitted', { show: nameOf(current.showId) });
    else if (current.status === 'error' && !current.presetId) status.textContent = current.detail || ht.t('feedback.noResponse');
    else status.textContent = ht.t('stringLight.idle');
    if (currentScene.status === 'submitted') sceneStatus.textContent = ht.t('stringLight.sceneSubmitted', { scene: nameOf(currentScene.sceneId) });
    else if (currentScene.status === 'error') sceneStatus.textContent = currentScene.detail || ht.t('feedback.noResponse');
    else sceneStatus.textContent = ht.t('stringLight.sceneIdle');
    presetStatus.textContent = !current.presetId ? '' : current.status === 'error' ? current.detail || ht.t('feedback.noResponse') : ht.t('stringLight.submitted', { show: nameOf(current.presetId) });
    selection(); previewScene(); controls();
  };
  const capabilityOf = frame => frame?.value?.capabilities?.stringLight;
  light.addEventListener('ht:frame', event => paint(capabilityOf(event.detail)));
  paint(capabilityOf(light.frame));
  for (const [input, key] of [[select, 'show'], [sceneSelect, 'scene'], [presetSelect, 'preset']]) {
    input.addEventListener('change', () => ht.pageState.update({ [key]: input.value }));
    ht.pageState.watch([key], query => {
      const value = query.get(key) ?? defaultSelections[key] ?? '';
      if ([...input.options].some(option => option.value === value)) input.value = value;
      selection(); previewScene(); controls();
    });
  }
  const run = async (command, value, output = feedback) => {
    if (busy) return;
    if (command === 'playShow' && chosen()?.kind === 'sequence' && !duration.reportValidity()) return;
    busy = true; controls();
    for (const field of [feedback, sceneFeedback, presetFeedback]) ht.say(field, '');
    try {
      paint(await ht.request(endpoint + '/capabilities/stringLight/controls/' + command, { method: 'POST', body: JSON.stringify({ value }) }));
    } catch (error) { ht.say(output, error.message || ht.t('feedback.noResponse'), 'bad'); }
    finally { busy = false; controls(); }
  };
  play.addEventListener('click', () => run('playShow', { id: select.value, ...(chosen()?.kind === 'sequence' ? { stepSeconds: Number(duration.value) } : {}) }));
  stop.addEventListener('click', () => run('stopShow'));
  applyScene.addEventListener('click', () => run('applyScene', sceneSelect.value, sceneFeedback));
  applyPreset.addEventListener('click', () => run('applyPreset', presetSelect.value, presetFeedback));
  stopPreset.addEventListener('click', () => run('stopShow', undefined, presetFeedback));
})();
`;
