import type { RegisteredDevice } from "../site";
import { groupPage, groupSwitchPage } from "../page-urls";
import type { DeviceGroup } from "../schemas";
import { deviceNode, groupNode } from "../state/protocol";
import { escapeHtml, htElement, renderPage, type PageContext } from "./shell";

export interface SwitchesPageOptions {
  ctx: PageContext;
  switches: readonly RegisteredDevice[];
  buttons: readonly SwitchBuilderButton[];
  canCreate: boolean;
  groups?: readonly DeviceGroup[];
}

export interface SwitchBuilderButton {
  /** Opaque value returned to the create endpoint. */
  readonly reference: string;
  readonly name: string;
  readonly detail: string;
}

export const SWITCHES_COLLECTION_API = "/api/switches" as const;

const SWITCHES_CSS = String.raw`
  .switch-row .row-actions { align-self: center; align-items: center; }
  .builder-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 var(--s4); }
  @media (max-width: 38rem) { .builder-grid { grid-template-columns: 1fr; } }
`;

/** The builder form only: each row's state and power buttons are an `<ht-switch-row>` bound to the switch's node. */
const SWITCHES_SCRIPT = String.raw`
  (() => {
    const form = document.querySelector("[data-switch-builder]");
    if (!(form instanceof HTMLFormElement)) return;
    const name = form.elements.namedItem("name");
    const id = form.elements.namedItem("id");
    const feedback = form.querySelector("[data-builder-feedback]");
    let idEdited = false;
    if (id instanceof HTMLInputElement) id.addEventListener("input", () => { idEdited = id.value.length > 0; });
    if (name instanceof HTMLInputElement && id instanceof HTMLInputElement) name.addEventListener("input", () => {
      if (idEdited) return;
      id.value = name.value.trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100);
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submit = form.querySelector("button[type=submit]");
      if (submit instanceof HTMLButtonElement) submit.disabled = true;
      ht.say(feedback, ht.t("switches.builder.creating"));
      const data = new FormData(form);
      const initialState = String(data.get("initialState") || "");
      const body = {
        id: String(data.get("id") || ""), name: String(data.get("name") || ""),
        onButton: String(data.get("onButton") || ""), offButton: String(data.get("offButton") || ""),
        ...(initialState ? { initialState } : {}),
      };
      try {
        await ht.request(${JSON.stringify(SWITCHES_COLLECTION_API)}, { method: "POST", body: JSON.stringify(body) });
        window.location.assign("/switches");
      } catch (error) {
        ht.say(feedback, error instanceof Error ? error.message : ht.t("switches.builder.failed"), "bad");
        if (submit instanceof HTMLButtonElement) submit.disabled = false;
      }
    });
  })();
`;

export function renderSwitchesPage({ ctx, switches, buttons, canCreate, groups = [] }: SwitchesPageOptions): string {
  const { t } = ctx.i18n;
  const entries = [...switches.map(device => ({ ...device, sourcePage: "", node: deviceNode(device.id), settings: `${device.page}/settings#switch-definition` })),
    ...groups.filter(group => group.asSwitch).map(group => ({ ...group, sourcePage: groupPage(group), modelTitle: t("grouping.group"), page: groupSwitchPage(group), node: groupNode(group.id), settings: `${groupSwitchPage(group)}/settings` }))];
  const rows = entries.map((device) => `<li class="row switch-row" data-switch-id="${escapeHtml(device.id)}">
    <span class="row-name"><a href="${escapeHtml(device.page)}">${escapeHtml(device.name)}</a></span>
    <span class="row-meta">${device.sourcePage ? `<a href="${escapeHtml(device.sourcePage)}">${escapeHtml(t("relations.basedOnGroup"))}</a>` : escapeHtml(device.modelTitle)}${device.room ? ` · ${escapeHtml(device.room)}` : ""}</span>
    <span class="row-actions">
      ${htElement(ctx, "ht-switch-row", device.node)}
      <a class="btn btn-small" href="${escapeHtml(device.settings)}">${escapeHtml(t("settings.title"))}</a>
    </span>
  </li>`).join("");
  const options = buttons.map((button) => `<option value="${escapeHtml(button.reference)}">${escapeHtml(button.name)} — ${escapeHtml(button.detail)}</option>`).join("");
  const builder = !canCreate
    ? `<p class="note">${escapeHtml(t("switches.builder.readOnly"))}</p>`
    : buttons.length < 2
      ? `<p class="note">${escapeHtml(t("switches.builder.needButtons"))}</p>`
      : `<form data-switch-builder>
          <p class="note">${escapeHtml(t("switches.builder.intro"))}</p>
          <div class="builder-grid">
            <label class="field"><span>${escapeHtml(t("switches.builder.name"))}</span><input name="name" required maxlength="200" autocomplete="off"></label>
            <label class="field"><span>${escapeHtml(t("switches.builder.id"))}</span><input name="id" required maxlength="100" pattern="[A-Za-z0-9][A-Za-z0-9._:-]*" autocomplete="off" class="mono"></label>
            <label class="field"><span>${escapeHtml(t("switches.builder.onButton"))}</span><select name="onButton" required><option value="">${escapeHtml(t("switches.builder.choose"))}</option>${options}</select></label>
            <label class="field"><span>${escapeHtml(t("switches.builder.offButton"))}</span><select name="offButton" required><option value="">${escapeHtml(t("switches.builder.choose"))}</option>${options}</select></label>
            <label class="field"><span>${escapeHtml(t("switches.builder.initial"))}</span><select name="initialState"><option value="">${escapeHtml(t("status.unknown"))}</option><option value="off">${escapeHtml(t("action.off"))}</option><option value="on">${escapeHtml(t("action.on"))}</option></select></label>
          </div>
          <div class="bar"><button type="submit" class="btn btn-primary">${escapeHtml(t("switches.builder.create"))}</button></div>
          <output class="feedback" data-builder-feedback aria-live="polite"></output>
        </form>`;
  return renderPage({
    ctx,
    title: t("switches.title"),
    nav: "switches",
    css: SWITCHES_CSS,
    body: `<h1>${escapeHtml(t("switches.title"))}</h1>
      ${entries.length ? `<ul class="rows" aria-label="${escapeHtml(t("switches.title"))}">${rows}</ul>` : `<p class="empty">${escapeHtml(t("switches.empty"))}</p>`}
      <h2>${escapeHtml(t("switches.builder.title"))}</h2>
      ${builder}`,
    script: SWITCHES_SCRIPT,
    nodes: entries.map((device) => device.node),
    messages: ["switches.", "grouping.", "state.", "switch."],
  });
}
