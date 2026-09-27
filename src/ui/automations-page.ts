import { escapeHtml, renderPage, type PageContext } from "./shell";

export interface AutomationSummary {
  id: string;
  name: string;
  description: string;
  status: "Active" | "Paused" | "Starting" | "Needs attention";
}

const AVAILABILITY_OF: Record<AutomationSummary["status"], string> = { Active: "online", Paused: "unknown", Starting: "connecting", "Needs attention": "offline" };

export function renderAutomationsPage(ctx: PageContext, automations: readonly AutomationSummary[]): string {
  const { t } = ctx.i18n;
  const rows = automations.map((automation) => `<li><a class="row" href="/automations/${encodeURIComponent(automation.id)}">
      <span class="row-name">${escapeHtml(automation.name)}</span>
      <span class="row-meta">${escapeHtml(automation.description)}</span>
      <span class="row-side status" data-availability="${AVAILABILITY_OF[automation.status]}"><span class="mark" data-availability="${AVAILABILITY_OF[automation.status]}" aria-hidden="true"></span>${escapeHtml(t(`automations.status.${automation.status}`))}</span>
    </a></li>`).join("");
  return renderPage({
    ctx,
    title: t("automations.title"),
    nav: "automations",
    body: `<h1>${escapeHtml(t("automations.title"))}</h1>
      ${automations.length ? `<ul class="rows">${rows}</ul>` : `<p class="empty">${escapeHtml(t("automations.empty"))}</p>`}`,
  });
}
