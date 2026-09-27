import { isGroupSwitch, type GroupSnapshot } from "../models/device-group";
import type { GroupSchemaChoice } from "../models/automatic-group";
import type { AutomaticGroupCriteria, DeviceGroup } from "../schemas";
import type { RegisteredDevice } from "../site";
import { tagLabel, type Tag } from "../tags/model";
import { groupSwitchPage } from "../page-urls";
import { deviceNode, groupNode } from "../state/protocol";
import { renderRoomPicker, ROOM_PICKER_SCRIPT } from "./room-picker";
import { SWITCH_DEFINITION_CSS } from "./switch-definition";
import { GROUP_PROPERTIES_SCRIPT, SWITCH_GAP_CSS, SWITCH_GAP_SCRIPT } from "./switch-page";
import { escapeHtml, htElement, renderPage, type PageContext } from "./shell";

const CSS = String.raw`
  .group-choices { display: grid; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); gap: var(--s2); margin: var(--s3) 0; }
  .group-choice { display: flex; align-items: center; gap: var(--s2); border: var(--rule-w) solid var(--rule); padding: var(--s3); cursor: pointer; }
  .group-choice input { width: 1.2rem; height: 1.2rem; flex: none; }
  .group-choice:has(input:checked) { background: var(--panel); outline: 2px solid var(--rule); }
  .group-choice small { display: block; color: var(--muted); }
  .group-tag-choices { max-height: 16rem; overflow-y: auto; padding: var(--s1); }
  .group-tag-choices .group-choice { min-width: 0; overflow-wrap: anywhere; padding: var(--s2); }
  .group-choice[hidden], [data-manual-fields][hidden], [data-criteria-fields][hidden] { display: none; }
  .group-editor { margin-block: var(--s3); }
  .group-editor .group-choices { max-height: 24rem; overflow-y: auto; padding: var(--s1); }
  .group-editor .group-choice { min-width: 0; overflow-wrap: anywhere; }
  .group-controls { display: flex; flex-wrap: wrap; align-items: end; gap: var(--s3); }
  .group-controls form { margin: 0; max-width: 20rem; }
  .group-controls .field { margin-top: 0; }
  .group-action-list { display: flex; flex-wrap: wrap; gap: var(--s2) var(--s4); list-style: none; padding: 0; }
  .group-action-list li { padding-inline-start: var(--s2); border-inline-start: 2px solid var(--rule); }
  .group-switch-choice { display: flex; align-items: center; gap: var(--s2); margin-block: var(--s3); }
  .group-results { white-space: pre-line; }
  .group-members { list-style: none; padding: 0; }
  .group-members li { margin: var(--s3) 0; }
`;

/** One renderer for the creation preview and the saved group's live readings. */
const SCRIPT = String.raw`
document.querySelectorAll("[data-device-group]").forEach(root => {
  const preview = root.querySelector("[data-group-preview]");
  const feedback = root.querySelector("[data-group-feedback]");
  const controls = root.querySelector("[data-group-controls]");
  const properties = root.querySelector("[data-group-properties]");
  const members = root.querySelector("[data-group-members]");
  const actionList = root.querySelector("[data-group-action-list]");
  const switchForm = root.querySelector("[data-group-switch]");
  const savedAsSwitch = Boolean(switchForm && switchForm.elements.asSwitch.checked);
  let canSwitch = false;
  const label = (id) => {
    const key = id.split(".").pop();
    const text = ht.t("grouping.label." + key);
    return text.startsWith("grouping.label.") ? key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, value => value.toUpperCase()) : text;
  };
  const format = (value) => value === undefined ? ht.t("status.unknown") : typeof value === "boolean" ? ht.t(value ? "action.on" : "action.off") : typeof value === "object" ? JSON.stringify(value) : String(value);
  const el = (tag, text, parent) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (parent) parent.append(node); return node; };
  const cell = (tag, text, row) => el(tag, text, row);
  let actionSignature = "";
  let busy = false;
  let snapshotRevision = 0;
  const cacheKey = root.dataset.groupId ? "group-snapshot:" + root.dataset.groupId : undefined;
  const cachedSnapshot = () => { try { const raw = root.querySelector("[data-group-snapshot]")?.textContent || cacheKey && sessionStorage.getItem(cacheKey); return raw ? JSON.parse(raw) : undefined; } catch { return undefined; } };
  let snapshotSignature = "";
  const memberLink = (member, parent) => { const link = el("a", member.name, parent); link.href = member.page; return link; };
  // The reactive path (below) owns this table once it takes over; show() then skips it so the two updaters never fight.
  let propertiesReactive = false;
  let propertiesSignature = "";
  // A row per device, a column per property: a group of ten door sensors reads down the page,
  // not sideways, and each member keeps one name instead of one per property.
  const renderProperties = (tableMembers, propertyList) => {
    const signature = JSON.stringify([tableMembers, propertyList]);
    if (signature === propertiesSignature) return;
    propertiesSignature = signature;
    properties.replaceChildren();
    if (!propertyList.length) { el("p", ht.t("grouping.noProperties"), properties); return; }
    const table = el("table", undefined, properties); table.className = "table";
    const head = el("tr", undefined, el("thead", undefined, table));
    cell("th", ht.t("grouping.device"), head);
    for (const property of propertyList) cell("th", label(property.id), head);
    const body = el("tbody", undefined, table);
    for (const member of tableMembers) {
      const row = el("tr", undefined, body);
      memberLink(member, cell("th", undefined, row));
      for (const property of propertyList) {
        const value = cell("td", format(member.properties[property.id]), row);
        value.dataset.label = label(property.id);
        ht.live(value, member.observedAt);
      }
    }
  };
  const show = (snapshot) => {
    const signature = JSON.stringify(snapshot);
    if (signature === snapshotSignature) return;
    snapshotSignature = signature;
    try { if (cacheKey) sessionStorage.setItem(cacheKey, signature); } catch {}
    preview.hidden = false;
    if (!propertiesReactive) renderProperties(snapshot.members, snapshot.properties);
    members.replaceChildren();
    if (!snapshot.members.length) el("p", ht.t("grouping.noMatches"), members);
    const matchCount = root.querySelector("[data-match-count]");
    if (matchCount) matchCount.textContent = ht.t("grouping.matchCount", { count: snapshot.members.length });
    for (const member of snapshot.members) {
      const item = el("li", undefined, members);
      const link = el("a", member.name, item); link.href = member.page;
      item.append(" · " + ht.availability(member.availability));
      if (Array.isArray(member.missingForSwitch) && member.missingForSwitch.length) { item.append(" · "); el("span", switchGaps.lacks(member.missingForSwitch), item).className = "switch-gap"; }
      if (member.error) el("p", member.error, item);
      const list = el("dl", undefined, item);
      for (const [key, value] of Object.entries(member.properties)) { el("dt", label(key), list); el("dd", format(value), list); }
    }
    if (switchForm && typeof snapshot.canSwitch === "boolean") {
      canSwitch = snapshot.canSwitch;
      const section = switchForm.closest("#switch-settings");
      if (section) section.hidden = snapshot.switchEligible === false && !savedAsSwitch;
      const editable = root.dataset.writable === "true" && (canSwitch || savedAsSwitch);
      if (!switchForm.dataset.saving) switchForm.querySelectorAll("input, button").forEach(node => node.disabled = !editable);
      switchForm.querySelector("[data-group-switch-hint]").textContent = canSwitch ? ht.t("grouping.switchHint") : [ht.t("grouping.switchUnavailable"), switchGaps.summary(snapshot)].filter(Boolean).join(" ");
    }
    if (actionList) {
      actionList.replaceChildren();
      for (const action of snapshot.actions) {
        const bounds = Object.entries(action.bounds).filter(([key, value]) => typeof value === "number" && /^(minimum|maximum|minLease|maxLease)/.test(key)).map(([, value]) => value);
        el("li", label(action.control) + (bounds.length ? " (" + bounds.join("–") + ")" : ""), actionList);
      }
      if (!snapshot.actions.length) el("li", ht.t("grouping.noControls"), actionList);
    }
    if (!controls) return;
    const isSwitch = root.dataset.asSwitch === "true";
    const shownActions = isSwitch ? snapshot.actions.filter(action => !["turnOn", "turnOff", "toggle"].includes(action.control)) : snapshot.actions;
    if (JSON.stringify(shownActions) === actionSignature) return;
    actionSignature = JSON.stringify(shownActions);
    controls.replaceChildren();
    if (!shownActions.length) el("p", ht.t("grouping.noControls"), controls);
    for (const action of shownActions) {
      const form = el("form", undefined, controls);
      let input;
      if (action.input !== "none") {
        const field = el("label", undefined, form); field.className = "field";
        el("span", label(action.control), field);
        if (action.input === "boolean") {
          input = el("select", undefined, field);
          for (const value of [true, false]) { const option = el("option", format(value), input); option.value = String(value); }
        } else {
          input = el("input", undefined, field);
          input.type = action.input === "number" ? "number" : action.input === "color" ? "color" : "text";
          input.required = true;
          if (action.input === "json") input.placeholder = ht.t("grouping.value");
          for (const [key, value] of Object.entries(action.bounds)) {
            if (/^(minimum|minLease)/.test(key)) input.min = String(value);
            if (/^(maximum|maxLease)/.test(key)) input.max = String(value);
          }
          if (action.input === "number") input.step = String(action.bounds.step || 1);
          if (action.bounds.maxLength) input.maxLength = action.bounds.maxLength;
          const propertyId = { setBrightness: "light.brightnessPercent", setColorTemperature: "light.colorTemperatureKelvin", setColor: "light.color", setVolume: "speaker.volumePercent" }[action.control];
          const property = snapshot.properties.find(property => property.id === propertyId);
          if (property && property.status === "shared") input.value = String(property.value);
          else if (property && action.input === "number") input.placeholder = ht.t(property.status === "mixed" ? "grouping.mixed" : "status.unknown");
        }
      }
      const button = el("button", label(action.control), form); button.type = "submit"; button.className = "btn"; button.disabled = busy;
      form.addEventListener("submit", async event => {
        event.preventDefault(); if (busy) return;
        if (action.confirmation && !window.confirm(ht.t("grouping.confirm", { action: label(action.control), count: snapshot.members.length }))) return;
        let value;
        try {
          if (input) value = action.input === "number" ? Number(input.value) : action.input === "boolean" ? input.value === "true" : action.input === "json" ? JSON.parse(input.value) : input.value;
          busy = true; snapshotRevision++; controls.querySelectorAll("button, input, select").forEach(node => node.disabled = true);
          ht.say(feedback, ht.t("grouping.applying"));
          const result = await ht.request("/api/device-groups/" + encodeURIComponent(root.dataset.groupId) + "/controls/" + encodeURIComponent(action.id), { method: "POST", body: JSON.stringify({ ...(value !== undefined ? { value } : {}), ...(action.confirmation ? { confirmed: true } : {}) }) });
          show(result.group);
          ht.say(feedback, result.ok ? ht.t("grouping.applied") : result.results.map(member => member.name + ": " + (member.ok ? ht.t("grouping.succeeded") : member.error)).join("\n"), result.ok ? "ok" : "bad");
        } catch (error) { ht.say(feedback, error.message || ht.t("feedback.requestFailed"), "bad"); }
        finally { busy = false; controls.querySelectorAll("button, input, select").forEach(node => node.disabled = false); }
      });
    }
  };
  const builder = root.querySelector("[data-group-builder]");
  if (builder) {
    const submit = builder.querySelector("button[type=submit]");
    const editing = root.dataset.editMembers === "true" || root.dataset.editCriteria === "true";
    const mode = builder.elements.namedItem("membership");
    const automatic = () => root.dataset.editCriteria === "true" || mode?.value === "automatic";
    const criteria = () => {
      const room = builder.elements.namedItem("criteriaRoom").value;
      const schemaId = builder.elements.namedItem("schemaId").value;
      const tagIds = Array.from(builder.querySelectorAll('input[name="tagIds"]:checked')).map(input => input.value).sort();
      return { ...(room ? { room } : {}), ...(schemaId ? { schemaId } : {}), ...(tagIds.length ? { tagIds } : {}) };
    };
    const editor = editing ? root.closest("details") : null;
    const cancel = root.querySelector("[data-members-cancel]");
    const filter = root.querySelector("[data-member-search]");
    const count = root.querySelector("[data-member-count]");
    let revision = 0;
    let timer;
    let ready = false;
    const selected = () => Array.from(builder.querySelectorAll('input[name="members"]:checked')).map(input => input.value);
    const selection = () => automatic() ? { criteria: criteria() } : { members: selected() };
    const original = selection();
    const changed = () => !editing || JSON.stringify(selection()) !== JSON.stringify(original);
    let suggestedName = "";
    const syncMode = () => {
      const auto = automatic();
      const manualFields = root.querySelector("[data-manual-fields]");
      const criteriaFields = root.querySelector("[data-criteria-fields]");
      if (manualFields) { manualFields.hidden = auto; manualFields.disabled = auto || root.dataset.writable !== "true"; }
      if (criteriaFields) { criteriaFields.hidden = !auto; criteriaFields.disabled = !auto || root.dataset.writable !== "true"; }
      const name = builder.elements.namedItem("name");
      if (auto && name && (!name.value || name.value === suggestedName)) {
        const schema = builder.elements.namedItem("schemaId");
        const room = criteria().room;
        const title = schema.selectedOptions[0]?.dataset.groupName || ht.t("grouping.allDevices");
        const tags = Array.from(builder.querySelectorAll('input[name="tagIds"]:checked')).map(input => '#' + input.dataset.slug).join(', ');
        suggestedName = (title + (room ? ht.t("grouping.inRoom", { room }) : "") + (tags ? ht.t("grouping.withTags", { tags }) : "")).slice(0, 200);
        name.value = suggestedName;
      }
    };
    const filterChoices = () => {
      const query = filter.value.trim().toLocaleLowerCase(ht.locale);
      root.querySelectorAll(".group-choice").forEach(choice => choice.hidden = !choice.textContent.toLocaleLowerCase(ht.locale).includes(query));
    };
    ht.pageState.bind(filter, 'member-search', filterChoices);
    const tagSearch = builder.querySelector('[data-criteria-tag-search]');
    const filterTags = () => {
      if (!tagSearch) return;
      const query = tagSearch.value.replace(/^#/, '').toLocaleLowerCase(ht.locale);
      builder.querySelectorAll('[data-criteria-tag]').forEach(choice => {
        const input = choice.querySelector('input');
        choice.hidden = !input.checked && !input.dataset.slug.toLocaleLowerCase(ht.locale).includes(query);
      });
    };
    ht.pageState.bind(tagSearch, 'member-tag-search', filterTags);
    const reset = () => {
      revision++; clearTimeout(timer); ready = false; submit.disabled = true; preview.hidden = true;
      builder.reset(); syncMode(); if (filter) filterChoices(); filterTags();
      const matches = root.querySelector("[data-match-count]"); if (matches) matches.textContent = "";
      if (count) count.textContent = ht.t("grouping.selectedCount", { count: selected().length });
      ht.say(feedback, root.dataset.writable === "true" ? "" : ht.t("grouping.readOnly"));
    };
    if (editor) editor.addEventListener("toggle", () => {
      const live = document.querySelector("[data-live-group]");
      if (live) live.hidden = editor.open;
      if (!editor.open && !busy) reset();
    });
    if (cancel) cancel.addEventListener("click", () => { if (!busy) { reset(); editor.open = false; } });
    const update = async (version) => {
      const ids = selected();
      if (automatic() ? !Object.keys(criteria()).length : ids.length < 2) { ht.say(feedback, ht.t(automatic() ? "grouping.chooseCriteria" : "grouping.choose")); return; }
      ht.say(feedback, ht.t("grouping.checking"));
      try {
        const snapshot = await ht.request("/api/device-groups/preview", { method: "POST", body: JSON.stringify(selection()) });
        if (version !== revision) return;
        show(snapshot); ready = true; submit.disabled = root.dataset.writable !== "true" || !changed();
        const losesSwitch = editing && root.dataset.asSwitch === "true" && !snapshot.canSwitch;
        ht.say(feedback, root.dataset.writable !== "true" ? ht.t("grouping.readOnly") : losesSwitch ? [ht.t("grouping.losesSwitch"), switchGaps.summary(snapshot)].filter(Boolean).join(" ") : "");
      } catch (error) { if (version === revision) ht.say(feedback, error.message, "bad"); }
    };
    builder.addEventListener("change", event => {
      if (!["members", "membership", "criteriaRoom", "schemaId", "tagIds"].includes(event.target.name)) return;
      syncMode(); revision++; ready = false; submit.disabled = true; preview.hidden = true;
      if (count) count.textContent = ht.t("grouping.selectedCount", { count: selected().length });
      clearTimeout(timer); timer = setTimeout(() => update(revision), 150);
    });
    builder.addEventListener("submit", async event => {
      event.preventDefault(); if (!ready || busy || root.dataset.writable !== "true" || !changed()) return;
      const name = editing ? "" : builder.elements.namedItem("name").value.trim();
      if (!editing && !name) return;
      busy = true; submit.disabled = true;
      const selectedValue = selection();
      builder.querySelectorAll("input, select").forEach(input => input.disabled = true);
      if (cancel) cancel.disabled = true;
      ht.say(feedback, ht.t("feedback.saving"));
      try {
        if (editing) {
          await ht.request("/api/device-groups/" + encodeURIComponent(root.dataset.groupId) + "/settings", { method: "POST", body: JSON.stringify(selectedValue) });
          window.location.reload();
          return;
        }
        const suffix = Array.from(crypto.getRandomValues(new Uint8Array(4)), value => value.toString(16).padStart(2, "0")).join("");
        const id = (name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "group") + "-" + suffix;
        const result = await ht.request("/api/device-groups", { method: "POST", body: JSON.stringify({ id, name, ...selectedValue }) });
        window.location.assign(result.page);
      } catch (error) {
        ht.say(feedback, error.message, "bad"); busy = false; submit.disabled = false;
        builder.querySelectorAll("input, select").forEach(input => input.disabled = false);
        syncMode();
        if (cancel) cancel.disabled = false;
      }
    });
    syncMode();
    if (automatic() && !editing) update(++revision);
  } else {
    if (switchForm) switchForm.addEventListener("submit", async event => {
      event.preventDefault();
      const asSwitch = switchForm.elements.asSwitch.checked;
      if (switchForm.dataset.saving || root.dataset.writable !== "true" || asSwitch && !canSwitch) return;
      switchForm.dataset.saving = "true";
      switchForm.querySelectorAll("input, button").forEach(node => node.disabled = true);
      const status = switchForm.querySelector("[data-group-switch-feedback]");
      ht.say(status, ht.t("feedback.saving"));
      try {
        await ht.request("/api/device-groups/" + encodeURIComponent(root.dataset.groupId) + "/settings", { method: "POST", body: JSON.stringify({ asSwitch }) });
        window.location.reload();
      } catch (error) {
        delete switchForm.dataset.saving;
        switchForm.querySelectorAll("input, button").forEach(node => node.disabled = false);
        ht.say(status, error.message || ht.t("feedback.requestFailed"), "bad");
      }
    });
    let refreshing = false;
    const refresh = async () => {
      if (busy || refreshing) return;
      refreshing = true;
      const version = snapshotRevision;
      try { const snapshot = await ht.request("/api/device-groups/" + encodeURIComponent(root.dataset.groupId)); if (!busy && version === snapshotRevision) { show(snapshot); startReactiveProperties(snapshot.members); } }
      catch (error) { ht.say(feedback, error.message, "bad"); }
      finally { refreshing = false; }
    };
    root.querySelector("[data-group-refresh]").addEventListener("click", refresh);
    // A member's own device/<id> node already carries everything the properties table needs; subscribing to
    // every member keeps that one table live without polling. Skipped above STREAM_LIMITS.maxNodes' safe margin
    // (src/state/protocol.ts) so a large group can never push the page's one stream over its 200-node cap.
    let reactiveStarted = false;
    const startReactiveProperties = (snapshotMembers) => {
      if (reactiveStarted || snapshotMembers.length > 80) return;
      reactiveStarted = true;
      groupProperties.whenReady().then(state => {
        if (!state || reactiveStarted !== true) return;
        const readings = new Map();
        const recompute = () => {
          const tableMembers = snapshotMembers.map(member => {
            const reading = readings.get(member.id);
            return { name: member.name, page: member.page, properties: reading ? reading.properties : {}, observedAt: reading && reading.observedAt };
          });
          const computable = snapshotMembers.every(member => readings.has(member.id));
          if (!computable) return;
          propertiesReactive = true;
          renderProperties(tableMembers, groupProperties.computeSharedProperties([...readings.values()]));
        };
        for (const member of snapshotMembers) {
          state.subscribe("device/" + member.id, record => {
            const { availability, kinds, properties } = groupProperties.memberProperties(record && record.value);
            readings.set(member.id, { id: member.id, name: member.name, page: member.page, availability, kinds, properties, observedAt: record && record.observedAt });
            recompute();
          }, "glance");
        }
      });
    };
    const cached = cachedSnapshot();
    if (cached) { show(cached); startReactiveProperties(cached.members); }
    // No interval. The properties table is live from the per-member subscriptions above — one node
    // each, never the whole graph — and everything else in the snapshot (the member list, the
    // controls, switch eligibility) changes only when an action on this page changes it, each of
    // which already refreshes. Refresh on the tab becoming visible again, and by the button.
    document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  }
});
`;

function preview(ctx: PageContext, saved: boolean, snapshot?: GroupSnapshot): string {
  const { t } = ctx.i18n;
  const format = (value: unknown) => escapeHtml(value === undefined ? t("status.unknown") : typeof value === "boolean" ? t(value ? "action.on" : "action.off") : typeof value === "object" ? JSON.stringify(value) : String(value));
  const label = (id: string) => ctx.i18n.lookup(`grouping.label.${id.split(".").pop()}`) ?? id;
  const properties = snapshot ? `<table class="table"><thead><tr><th>${escapeHtml(t("grouping.device"))}</th>${snapshot.properties.map(p => `<th>${escapeHtml(label(p.id))}</th>`).join("")}</tr></thead><tbody>${snapshot.members.map(member => `<tr><th>${escapeHtml(member.name)}</th>${snapshot.properties.map(p => `<td>${format(member.properties[p.id])}</td>`).join("")}</tr>`).join("")}</tbody></table>` : "";
  const members = snapshot?.members.map(member => `<li>${escapeHtml(member.name)} · ${escapeHtml(t(`status.${member.availability}`))}</li>`).join("") ?? "";
  return `<section data-group-preview${snapshot ? "" : " hidden"}>
    <h2>${escapeHtml(t("grouping.controls"))}</h2>${saved ? `<div class="group-controls" data-group-controls>${snapshot?.actions.map(action => `<button class="btn" disabled>${escapeHtml(label(action.control))}</button>`).join("") ?? ""}</div>` : `<ul class="group-action-list" data-group-action-list></ul>`}
    <h2>${escapeHtml(t("grouping.properties"))}</h2><div class="table-wrap" data-group-properties>${properties}</div>
    <h2>${escapeHtml(t("grouping.members"))}</h2><ul class="group-members" data-group-members>${members}</ul>
  </section>`;
}

function choices(devices: readonly RegisteredDevice[], selected: readonly string[] = [], disabled = false): string {
  return devices.map(device => `<label class="group-choice"><input type="checkbox" name="members" value="${escapeHtml(device.id)}"${selected.includes(device.id) ? " checked" : ""}${disabled ? " disabled" : ""}><span>${escapeHtml(device.name)}<small>${escapeHtml(device.modelTitle)}${device.room ? ` · ${escapeHtml(device.room)}` : ""} · ${escapeHtml(device.id)}</small></span></label>`).join("");
}

function memberEditor(ctx: PageContext, group: DeviceGroup, devices: readonly RegisteredDevice[], canEdit: boolean): string {
  if (group.criteria || !devices.length) return "";
  const { t } = ctx.i18n;
  const byId = new Map(devices.map(device => [device.id, device]));
  const sorted = [...group.members.flatMap(id => byId.has(id) ? [byId.get(id)!] : []), ...devices.filter(device => !group.members.includes(device.id))];
  return `<details class="group-editor"><summary>${escapeHtml(t("grouping.editMembers"))}</summary>
    <div data-device-group data-edit-members="true" data-group-id="${escapeHtml(group.id)}" data-as-switch="${Boolean(group.asSwitch)}" data-writable="${canEdit}">
      <form data-group-builder>
        <label class="field"><span>${escapeHtml(t("grouping.findDevices"))}</span><input type="search" data-member-search autocomplete="off"></label>
        <fieldset><legend>${escapeHtml(t("grouping.choose"))}</legend><div class="group-choices">${choices(sorted, group.members, !canEdit)}</div></fieldset>
        <p class="note" data-member-count>${escapeHtml(t("grouping.selectedCount", { count: group.members.length }))}</p>
        <div class="bar"><button type="submit" class="btn btn-primary" disabled>${escapeHtml(t("grouping.saveMembers"))}</button><button type="button" class="btn" data-members-cancel>${escapeHtml(t("grouping.cancel"))}</button></div>
      </form><p class="feedback" role="status" data-group-feedback>${canEdit ? "" : escapeHtml(t("grouping.readOnly"))}</p>
      ${preview(ctx, false)}
    </div></details>`;
}

export type GroupTagChoice = Pick<Tag, "id" | "name" | "value" | "color">;
/** The room / schema / tag fields of the group builder. A token's subject reuses them verbatim. */
export function criteriaFields(ctx: PageContext, rooms: readonly string[], schemas: readonly GroupSchemaChoice[], tags: readonly GroupTagChoice[], criteria: AutomaticGroupCriteria = {}, disabled = false): string {
  const { t } = ctx.i18n;
  const choices = [...new Set([...rooms, ...(criteria.room ? [criteria.room] : [])])];
  const tagChoices = [...tags, ...(criteria.tagIds ?? []).filter(id => !tags.some(tag => tag.id === id)).map(id => ({ id, name: "", value: t("grouping.unavailableTag"), color: "#777777" }))];
  return `<fieldset data-criteria-fields${disabled ? " disabled" : ""}><legend>${escapeHtml(t("grouping.criteria"))}</legend>
    <p class="note">${escapeHtml(t("grouping.automaticHint"))}</p>
    <label class="field"><span>${escapeHtml(t("grouping.matchRoom"))}</span><select name="criteriaRoom"><option value="">${escapeHtml(t("grouping.anyRoom"))}</option>${choices.map(room => `<option value="${escapeHtml(room)}"${room === criteria.room ? " selected" : ""}>${escapeHtml(room)}</option>`).join("")}</select></label>
    <label class="field"><span>${escapeHtml(t("grouping.schema"))}</span><select name="schemaId"><option value="">${escapeHtml(t("grouping.anySchema"))}</option>${schemas.map(schema => `<option value="${escapeHtml(schema.id)}" data-group-name="${escapeHtml(schema.groupName ?? t("grouping.schemaGroupName", { schema: schema.title }))}"${schema.id === criteria.schemaId ? " selected" : ""}>${escapeHtml(schema.title)}</option>`).join("")}</select></label>
    <fieldset><legend>${escapeHtml(t("grouping.matchTags"))}</legend><p class="note">${escapeHtml(t("grouping.tagsHint"))}</p>
      ${tagChoices.length ? `<label class="field"><span>${escapeHtml(t("grouping.findTags"))}</span><input type="search" data-criteria-tag-search autocomplete="off"></label>
      <div class="group-choices group-tag-choices">${tagChoices.map(tag => `<label class="group-choice" data-criteria-tag style="border-inline-start-color:${escapeHtml(tag.color)}"><input type="checkbox" name="tagIds" value="${escapeHtml(tag.id)}" data-slug="${escapeHtml(tagLabel(tag))}"${criteria.tagIds?.includes(tag.id) ? " checked" : ""}><span>${escapeHtml(tag.name ? tagLabel(tag) : `#${tag.value}`)}</span></label>`).join("")}</div>` : `<p class="note">${escapeHtml(t("grouping.noTags"))} <a href="/tags">${escapeHtml(t("nav.tags"))}</a></p>`}
    </fieldset>
    <p class="note" data-match-count></p></fieldset>`;
}

function criteriaEditor(ctx: PageContext, group: DeviceGroup, rooms: readonly string[], schemas: readonly GroupSchemaChoice[], tags: readonly GroupTagChoice[], canEdit: boolean): string {
  if (!group.criteria) return "";
  const { t } = ctx.i18n;
  const summary = [group.criteria.schemaId ? schemas.find(schema => schema.id === group.criteria!.schemaId)?.title ?? group.criteria.schemaId : t("grouping.anySchema"), group.criteria.room ?? t("grouping.anyRoom"), ...(group.criteria.tagIds ?? []).map(id => { const tag = tags.find(tag => tag.id === id); return tag ? (tag.name ? tagLabel(tag) : `#${tag.value}`) : t("grouping.unavailableTag"); })].join(" · ");
  const intro = `<p><strong>${escapeHtml(t("grouping.automatic"))}</strong> · ${escapeHtml(summary)}</p><p class="note">${escapeHtml(t(group.builtIn ? "grouping.builtInHint" : "grouping.automaticHint"))}</p>`;
  if (group.builtIn) return intro;
  return `${intro}<details class="group-editor"><summary>${escapeHtml(t("grouping.editCriteria"))}</summary>
    <div data-device-group data-edit-criteria="true" data-group-id="${escapeHtml(group.id)}" data-as-switch="${Boolean(group.asSwitch)}" data-writable="${canEdit}">
      <form data-group-builder>${criteriaFields(ctx, rooms, schemas, tags, group.criteria, !canEdit)}
        <div class="bar"><button type="submit" class="btn btn-primary" disabled>${escapeHtml(t("grouping.saveCriteria"))}</button><button type="button" class="btn" data-members-cancel>${escapeHtml(t("grouping.cancel"))}</button></div>
      </form><p class="feedback" role="status" data-group-feedback>${canEdit ? "" : escapeHtml(t("grouping.readOnly"))}</p>${preview(ctx, false)}
    </div></details>`;
}

export function renderDeviceGroupBuilder({ ctx, devices, canCreate, rooms = [], schemas = [], tags = [], automatic = false }: { ctx: PageContext; devices: readonly RegisteredDevice[]; canCreate: boolean; rooms?: readonly string[]; schemas?: readonly GroupSchemaChoice[]; tags?: readonly GroupTagChoice[]; automatic?: boolean }): string {
  const { t } = ctx.i18n;
  return renderPage({ ctx, title: t("grouping.create"), nav: "groups", css: CSS + SWITCH_GAP_CSS, messages: ["grouping.", "switch."], script: SWITCH_GAP_SCRIPT + SCRIPT,
    body: `<div data-device-group data-writable="${canCreate}"><h1>${escapeHtml(t("grouping.create"))}</h1><p class="note">${escapeHtml(t("grouping.intro"))}</p>
    <form data-group-builder><label class="field"><span>${escapeHtml(t("grouping.name"))}</span><input name="name" required maxlength="200" autocomplete="off"${canCreate ? "" : " disabled"}></label>
    <label class="field"><span>${escapeHtml(t("grouping.membership"))}</span><select name="membership"${canCreate ? "" : " disabled"}><option value="manual">${escapeHtml(t("grouping.manual"))}</option><option value="automatic"${automatic ? " selected" : ""}>${escapeHtml(t("grouping.automatic"))}</option></select></label>
    ${criteriaFields(ctx, rooms, schemas, tags)}
    <fieldset data-manual-fields><legend>${escapeHtml(t("grouping.choose"))}</legend><div class="group-choices">${choices(devices)}</div></fieldset>
    <button type="submit" class="btn btn-primary" disabled>${escapeHtml(t("grouping.create"))}</button></form>
    <p class="feedback" role="status" data-group-feedback>${escapeHtml(t(canCreate ? automatic ? "grouping.chooseCriteria" : "grouping.choose" : "grouping.readOnly"))}</p>${preview(ctx, false)}</div>` });
}

export function renderSelectedGroupPage({ ctx, group, snapshot, canEdit = false, switchDefinition = "", devices = [], rooms = [], schemas = [], tags = [] }: { ctx: PageContext; group: DeviceGroup; snapshot?: GroupSnapshot; canEdit?: boolean; switchDefinition?: string; devices?: readonly RegisteredDevice[]; rooms?: readonly string[]; schemas?: readonly GroupSchemaChoice[]; tags?: readonly GroupTagChoice[] }): string {
  const { t } = ctx.i18n;
  return renderPage({ ctx, title: group.name, nav: "groups", css: CSS + SWITCH_DEFINITION_CSS + SWITCH_GAP_CSS, messages: ["grouping.", "room.", "switch."], script: SWITCH_GAP_SCRIPT + GROUP_PROPERTIES_SCRIPT + SCRIPT + ROOM_PICKER_SCRIPT,
    // Seeding every member's device node lets the first subscribe (below the STREAM_LIMITS.maxNodes
    // margin the client-side script also checks) deliver a cached record synchronously, no flash.
    nodes: [...(group.asSwitch ? [groupNode(group.id)] : []), ...(group.members.length <= 80 ? group.members.map(deviceNode) : [])],
    body: `<h1>${escapeHtml(group.name)}</h1>${group.asSwitch ? `<p>${escapeHtml(t("relations.groupSwitch"))}: <a href="${escapeHtml(groupSwitchPage(group))}">${escapeHtml(group.name)}</a></p>` : ""}
    ${devices.length && !group.criteria ? `<p class="small">${escapeHtml(t("relations.members"))}: ${group.members.map(id => { const member = devices.find(device => device.id === id); return member ? `<a href="${escapeHtml(member.page)}">${escapeHtml(member.name)}</a>` : escapeHtml(id); }).join(" · ")}</p>` : ""}${criteriaEditor(ctx, group, rooms, schemas, tags, canEdit)}${memberEditor(ctx, group, devices, canEdit)}
    <div data-device-group data-live-group data-group-id="${escapeHtml(group.id)}" data-writable="${canEdit}" data-as-switch="${Boolean(group.asSwitch)}">
    ${group.asSwitch ? htElement(ctx, "ht-switch", groupNode(group.id)) : ""}
    <button class="btn" type="button" data-group-refresh>${escapeHtml(t("grouping.refresh"))}</button><p class="feedback group-results" role="status" data-group-feedback></p>${preview(ctx, true, snapshot)}${snapshot ? `<script type="application/json" data-group-snapshot nonce="${escapeHtml(ctx.nonce)}">${JSON.stringify({ ...snapshot, canSwitch: isGroupSwitch(snapshot), members: snapshot.members.map(member => ({ ...member, page: devices.find(device => device.id === member.id)?.page })) }).replaceAll("<", "\\u003c")}</script>` : ""}
    ${group.builtIn ? "" : `<section><h2>${escapeHtml(t("room.label"))}</h2>${renderRoomPicker(ctx, group, { endpoint: `/api/device-groups/${encodeURIComponent(group.id)}/settings`, writable: canEdit })}</section>
    <section id="switch-settings"><h2>${escapeHtml(t("grouping.switchTitle"))}</h2><form data-group-switch>
      <label class="group-switch-choice"><input type="checkbox" name="asSwitch"${group.asSwitch ? " checked" : ""} disabled>${escapeHtml(t("grouping.asSwitch"))}</label>
      <p class="note" data-group-switch-hint>${escapeHtml(t(snapshot && isGroupSwitch(snapshot) ? "grouping.switchHint" : "grouping.switchUnavailable"))}</p>
      <button type="submit" class="btn" disabled>${escapeHtml(t("grouping.saveSwitch"))}</button>
      <output class="feedback" role="status" data-group-switch-feedback>${canEdit ? "" : escapeHtml(t("grouping.readOnly"))}</output>
    </form></section>${switchDefinition}`}</div>` });
}
