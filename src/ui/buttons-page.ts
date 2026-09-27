import type { RegisteredDevice } from "../site";
import type { WorkflowDefinition } from "../workflows/runner";
import { escapeHtml, renderPage, type PageContext } from "./shell";

export const DEFAULT_WORKFLOW: WorkflowDefinition = { start: "start", nodes: [{ id: "start", type: "end", label: "Complete" }] };

const SCRIPT = String.raw`
  (() => {
    const form = document.querySelector("[data-button-builder]");
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
      ht.say(feedback, ht.t("feedback.saving"));
      try {
        const data = new FormData(form);
        const body = { id: String(data.get("id") || ""), name: String(data.get("name") || ""), workflow: ${JSON.stringify(DEFAULT_WORKFLOW)} };
        const result = await ht.request("/api/buttons", { method: "POST", body: JSON.stringify(body) });
        window.location.assign(result.page);
      } catch (error) {
        ht.say(feedback, error instanceof Error ? error.message : ht.t("feedback.requestFailed"), "bad");
        if (submit instanceof HTMLButtonElement) submit.disabled = false;
      }
    });
  })();
`;

export function renderButtonsPage(ctx: PageContext, buttons: readonly RegisteredDevice[], canCreate: boolean): string {
  const { t } = ctx.i18n;
  const rows = buttons.map((button) => `<li><a class="row" href="${escapeHtml(button.page)}">
    <span class="row-name">${escapeHtml(button.name)}</span><span class="row-meta">${escapeHtml(button.modelTitle)}${button.room ? ` · ${escapeHtml(button.room)}` : ""}</span><span class="row-side">${escapeHtml(button.model === "workflow-button" ? "Workflow" : "Ready to press")}</span>
  </a></li>`).join("");
  const builder = canCreate ? `<section aria-labelledby="button-builder-title"><h2 id="button-builder-title">Create Workflow Button</h2>
    <p>A Workflow Button is a stateless press that starts a server-side sequence. Build its graph after creating it.</p>
    <form data-button-builder><div class="field-row"><label class="field"><span>Name</span><input name="name" required maxlength="200" autocomplete="off"></label><label class="field"><span>Id</span><input name="id" required maxlength="100" pattern="[A-Za-z0-9][A-Za-z0-9._:-]*" class="mono" autocomplete="off"></label></div>
      <div class="bar"><button type="submit" class="btn btn-primary">Create Button</button></div><output class="feedback" data-builder-feedback role="status" aria-live="polite"></output>
    </form></section>` : `<p class="note">This HomeTruth instance has no writable device configuration.</p>`;
  return renderPage({
    ctx, title: t("nav.buttons"), nav: "buttons", script: SCRIPT, messages: ["feedback."],
    body: `<h1>${escapeHtml(t("nav.buttons"))}</h1>${buttons.length ? `<ul class="rows" aria-label="${escapeHtml(t("nav.buttons"))}">${rows}</ul>` : `<p class="empty">No Buttons</p>`}${builder}`,
  });
}
