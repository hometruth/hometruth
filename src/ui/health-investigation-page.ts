import type { HealthAdvice, HealthInvestigation } from "../health/investigation";
import type { BudgetStatus } from "../health/advisor";
import { escapeHtml as h, renderPage, type PageContext } from "./shell";

export function renderHealthInvestigationPage(ctx: PageContext, value: HealthInvestigation, pageOf: (kind: "device" | "service", id: string) => string | undefined, budget?: BudgetStatus): string {
  const { t, dateTime } = ctx.i18n;
  const page = pageOf(value.entity.kind, value.entity.id);
  const content = `<p class="investigation-status" role="status"><strong>${h(t(`investigation.${value.status}`))}</strong> · ${h(value.progress)}</p>
    <p class="muted">${h(t("investigation.created", { at: dateTime(value.createdAt) }))}</p>
    <h2>${h(t("investigation.trigger"))}</h2><p>${h(value.trigger.detail)}</p>
    <p>${h(t("investigation.readOnly"))}</p>
    ${value.summary ? `<h2>${h(t("investigation.findings"))}</h2><h3>${h(value.summary)}</h3><p>${h(value.likelyCause)}</p>` : `<p>${h(t("investigation.waiting"))}</p>`}
    ${value.observations.length ? `<h2>${h(t("health.evidence"))}</h2><ul class="investigation-observations">${value.observations.map(({ entity, health }) => `<li><strong>${h(entity.name)}</strong> · ${h(t(`health.${health.status}`))}<p>${h(health.detail)}</p>${health.checkedAt ? `<small>${h(dateTime(health.checkedAt))}</small>` : ""}</li>`).join("")}</ul>` : ""}
    ${value.steps.length ? `<h2>${h(t("health.fix"))}</h2><ol>${value.steps.map(step => `<li>${h(step)}</li>`).join("")}</ol>` : ""}
    ${value.advice ? renderAdvice(ctx, value.advice, budget) : ""}
    ${page ? `<nav class="investigation-actions"><a href="${h(page)}">${h(t("health.open"))}</a><a href="${h(page)}/log">${h(t("health.log"))}</a></nav>` : ""}`;
  return renderPage({ ctx, nav: "health", title: value.title, messages: ["health.", "investigation."],
    body: `<a href="/health">${h(t("nav.health"))}</a><h1>${h(value.title)}</h1><p id="investigation-refresh" role="status"></p><section data-investigation-content data-investigation-id="${h(value.id)}">${content}</section>`,
    css: `.investigation-status{border-inline-start:var(--rule-w) solid var(--accent);padding:1rem;background:var(--panel)}.investigation-observations{padding-inline-start:1.3rem}.investigation-observations li,ol li{margin-block:.7rem}.investigation-proposals p{margin:.3rem 0}.investigation-observations p{margin:.3rem 0}.investigation-actions{display:flex;gap:1.5rem;margin-block:2rem}h1,li{overflow-wrap:anywhere}`,
    script: String.raw`
      (() => {
        const content = document.querySelector("[data-investigation-content]");
        let pending = false, again = false;
        const refresh = async () => {
          if (pending) { again = true; return; }
          pending = true;
          try {
            const response = await fetch(location.href, { cache: "no-store", signal: AbortSignal.timeout(10000) });
            if (!response.ok) throw new Error("refresh");
            const next = new DOMParser().parseFromString(await response.text(), "text/html").querySelector("[data-investigation-content]");
            if (!next) throw new Error("refresh");
            content.replaceChildren(...next.childNodes);
            document.querySelector("#investigation-refresh").textContent = "";
          } catch { document.querySelector("#investigation-refresh").textContent = ht.t("health.stale"); }
          finally { pending = false; if (again) { again = false; void refresh(); } }
        };
        document.addEventListener("health-investigations", event => {
          if (event.detail.some(item => item.id === content.dataset.investigationId)) void refresh();
        });
        const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 15000);
        window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
      })();`,
  });
}

function renderAdvice(ctx: PageContext, advice: HealthAdvice, budget: BudgetStatus | undefined): string {
  const { t, number } = ctx.i18n;
  const money = (value: number) => number(value, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
  const spend = t("investigation.adviceCost", { cost: number(advice.costUsd, { style: "currency", currency: "USD", maximumFractionDigits: 3 }), model: advice.model })
    + (budget ? ` · ${t("investigation.adviceBudget", { spent: money(budget.spentUsd), budget: money(budget.monthlyBudgetUsd) })}` : "");
  const proposals = advice.proposals ?? [];
  return `<h2>${h(t("investigation.advice"))}</h2>
    ${advice.summary ? `<h3>${h(advice.summary)}</h3><p>${h(advice.likelyCause ?? "")}</p>` : ""}
    ${advice.confidence ? `<p>${h(t(`investigation.confidence.${advice.confidence}`))}</p>` : ""}
    ${proposals.length ? `<ol class="investigation-proposals">${proposals.map(item => `<li><strong>${h(item.title)}</strong>${item.changesDevice ? ` · ${h(t("investigation.changesDevice"))}` : ""}<p>${h(item.rationale)}</p>${item.steps.length ? `<ol>${item.steps.map(step => `<li>${h(step)}</li>`).join("")}</ol>` : ""}</li>`).join("")}</ol>` : ""}
    <p class="muted">${h(advice.note)}</p><p class="muted">${h(spend)}</p>`;
}
