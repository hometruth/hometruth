import type { HealthReport, HealthRow } from "../health/store";
import { healthInvestigationPrompt } from "../health/diagnostics";
import { escapeHtml, renderPage, type PageContext } from "./shell";

export function renderHealthPage(ctx: PageContext, report: HealthReport, period: string, pageOf: (kind: "device" | "service", id: string) => string | undefined): string {
  const { t, number, dateTime } = ctx.i18n;
  const h = escapeHtml;
  const duration = (ms: number) => ms >= 3_600_000 ? t("health.hours", { count: number(ms / 3_600_000, { maximumFractionDigits: 1 }) }) : t("health.minutes", { count: number(Math.floor(ms / 60_000)) });
  const nameLink = (row: { kind: "device" | "service"; id: string; name: string }) => {
    const page = pageOf(row.kind, row.id);
    return page ? `<a href="${h(page)}">${h(row.name)}</a>` : h(row.name);
  };
  const rows = [...report.entities].sort((a, b) => {
    const rank = { unhealthy: 0, degraded: 1, unknown: 2, healthy: 3, expected_offline: 4, disabled: 5 };
    return rank[a.health.status] - rank[b.health.status] || a.name.localeCompare(b.name);
  });
  const statuses = ["healthy", "unhealthy", "degraded", "unknown", "expected_offline", "disabled"] as const;
  const counts = Object.fromEntries(statuses.map(status => [status, rows.filter(row => row.health.status === status).length]));
  const byKey = new Map(rows.map(row => [row.key, row]));
  const policy = (row: HealthRow) => ctx.features.admin
    ? `<label class="health-policy"><input type="checkbox" data-health-policy="${h(ctx.apiPath(`/api/${row.kind}s/${encodeURIComponent(row.id)}/health/policy`))}" data-health-name="${h(row.name)}" aria-label="${h(t("health.policyFor", { name: row.name }))}" aria-describedby="health-policy-help"${row.unreachableIsUnhealthy ? " checked" : ""}> ${h(t("health.policy"))}</label>`
    : h(t(row.unreachableIsUnhealthy ? "health.offlineFailure" : "health.offlineAllowed"));
  const cards = (unknown: boolean) => report.diagnoses.filter(diagnosis => (byKey.get(diagnosis.key)?.health.status === "unknown") === unknown).map(diagnosis => {
    const row = byKey.get(diagnosis.key)!;
    const page = pageOf(row.kind, row.id);
    const checkPath = ctx.apiPath(`/api/${row.kind}s/${encodeURIComponent(row.id)}/health/check`);
    const prompt = healthInvestigationPrompt(row, diagnosis, checkPath, page);
    return `<article class="health-issue" data-issue="${h(row.key)}">
      <header><h3>${nameLink(row)}</h3><span data-health-status="${row.health.status}">${h(t(`health.${row.health.status}`))}</span></header>
      <h4>${h(diagnosis.summary)}</h4><p>${h(diagnosis.likelyCause)}</p>
      <div class="health-evidence"><strong>${h(t("health.evidence"))}</strong><p>${h(diagnosis.evidence.detail)}</p>
        <small>${h(t("health.lastCheck"))}: ${diagnosis.evidence.checkedAt ? h(dateTime(diagnosis.evidence.checkedAt)) : "—"}${diagnosis.evidence.startedAt ? ` · ${h(t("health.since", { at: dateTime(diagnosis.evidence.startedAt) }))} · ${h(t("health.reports", { count: diagnosis.evidence.reports }))}` : ""}</small></div>
      ${diagnosis.relatedKeys.length ? `<p>${h(t("health.related"))}: ${diagnosis.relatedKeys.map(key => byKey.get(key)).filter(row => row !== undefined).map(nameLink).join(", ")}</p>` : ""}
      <h4>${h(t("health.fix"))}</h4><ol>${diagnosis.steps.map(step => `<li>${h(step)}</li>`).join("")}</ol>
      <div class="health-actions"><button type="button" class="btn" data-health-check="${h(checkPath)}" data-health-name="${h(row.name)}">${h(t("health.checkAgain"))}</button>${page ? `<a href="${h(page)}">${h(t("health.open"))}</a><a href="${h(page)}/log">${h(t("health.log"))}</a>` : ""}</div>
      <p>${policy(row)}</p>
      <details data-health-disclosure="${h(row.key)}"><summary>${h(t("health.investigate"))}</summary><p>${h(t("health.agentNote"))}</p>
        <textarea readonly aria-label="${h(t("health.agentPrompt"))}" data-health-prompt>${h(prompt)}</textarea>
        <button type="button" class="btn" data-health-copy>${h(t("health.copy"))}</button></details>
    </article>`;
  }).join("");
  const issues = cards(false);
  const investigations = ctx.healthInvestigations?.length ? `<h2>${h(t("investigation.title"))}</h2><ul>${ctx.healthInvestigations.map(item => `<li><a href="${h(item.href)}">${h(item.title)}</a> · ${h(t(`investigation.${item.status}`))}</li>`).join("")}</ul>` : "";
  const content = `${investigations}<h2>${h(t("health.current"))}</h2>
    <dl class="health-summary">${statuses.map(status => `<div><dt>${h(t(`health.${status}`))}</dt><dd data-health-status="${status}">${h(number(counts[status]!))}</dd></div>`).join("")}</dl>
    <p class="health-note">${h(t("health.asOf", { at: dateTime(report.until) }))}</p>
    <h2>${h(t("health.attention"))}</h2><p class="health-note">${h(t("health.guidanceNote"))}</p><p class="health-note" id="health-policy-help">${h(t("health.policyHint"))}</p>
    ${issues ? `<div class="health-issues">${issues}</div>` : `<p>${h(t("health.noActive"))}</p>`}
    ${counts.unknown ? `<details data-health-disclosure="unknown"><summary>${h(t("health.unconfirmed", { count: counts.unknown }))}</summary><div class="health-issues">${cards(true)}</div></details>` : ""}
    <h2>${h(t("health.all"))}</h2>
    <p class="health-note">${h(t("health.historyNote"))}</p>
    <div class="health-table"><table><thead><tr>${(["name", "status", "uptime", "upFor", "lastCheck", "policyTitle"] as const).map(key => `<th scope="col">${h(t(`health.${key}`))}</th>`).join("")}</tr></thead>
    <tbody>${rows.map(row => `<tr><th scope="row">${nameLink(row)}<small>${h(t(`health.${row.kind}`))}</small></th>
      <td><span data-health-status="${row.health.status}">${h(t(`health.${row.health.status}`))}</span><small>${h(row.health.detail)}</small></td>
      <td>${row.uptimePercent === null ? "—" : h(number(row.uptimePercent, { maximumFractionDigits: 1 })) + "%"}<small>${h(t("health.observed", { duration: duration(row.observedMs) }))}</small></td>
      <td>${row.healthySince === null ? "—" : h(duration(Date.parse(report.until) - Date.parse(row.healthySince)))}</td>
      <td>${row.health.checkedAt === null ? "—" : `<time datetime="${h(row.health.checkedAt)}">${h(dateTime(row.health.checkedAt))}</time>`}</td><td class="health-policy-cell">${policy(row)}</td></tr>`).join("")}</tbody></table></div>
    ${rows.length ? "" : `<p>${h(t("health.empty"))}</p>`}
    <h2>${h(t("health.problems"))}</h2>
    ${report.problems.length ? `<ul class="health-problems">${report.problems.map(problem => `<li>${nameLink(problem)} · ${h(problem.detail)}
      <small>${h(dateTime(problem.startedAt))} · ${problem.resolvedAt ? h(t("health.resolved", { at: dateTime(problem.resolvedAt) })) : h(t("health.ongoing"))} · ${h(t("health.reports", { count: problem.occurrences }))}</small></li>`).join("")}</ul>` : `<p>${h(t("health.noProblems"))}</p>`}`;
  return renderPage({ ctx, title: t("health.title"), nav: "health", messages: ["health."],
    body: `<h1>${h(t("health.title"))}</h1><nav class="health-period" aria-label="${h(t("health.period"))}">${(["24h", "7d", "30d"] as const).map(value => `<a href="/health?period=${value}"${value === period ? ' aria-current="page"' : ""}>${h(t(`health.period.${value}`))}</a>`).join("")}</nav>
      <p class="health-note">${h(t("health.explanation"))}</p><p id="health-refresh" role="status"></p><p id="health-action-status" role="status" aria-live="polite"></p><section data-health-content>${content}</section>`,
    css: `.health-policy{display:inline-flex;gap:.5rem;align-items:baseline;white-space:normal}.health-policy-cell{white-space:normal!important;min-width:13rem}.health-issues{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,30rem),1fr));gap:1rem;margin:1rem 0 2rem}.health-issue{border:1px solid var(--hair);padding:1.2rem;min-width:0;overflow-wrap:anywhere}.health-issue header{display:flex;align-items:baseline;justify-content:space-between;gap:1rem}.health-issue h3{margin:0}.health-issue h4{margin:1rem 0 .4rem}.health-issue p{margin:.5rem 0;max-width:70ch}.health-issue li{margin:.5rem 0}.health-evidence{border-left:3px solid var(--hair);padding-left:.8rem;margin:1rem 0}.health-actions{display:flex;flex-wrap:wrap;gap:1rem;align-items:center}.health-issue details{margin-top:1rem}.health-issue textarea{box-sizing:border-box;width:100%;min-height:12rem;margin:.7rem 0;font:.85rem/1.5 var(--font-mono)}.health-issue summary{cursor:pointer}.health-period{display:flex;gap:1.2rem}.health-period [aria-current]{font-weight:bold}.health-note{max-width:70ch;color:var(--fg-2)}.health-summary{display:flex;flex-wrap:wrap;gap:1rem 2rem}.health-summary dt{color:var(--fg-2)}.health-summary dd{margin:0;font-size:1.7rem;font-variant-numeric:tabular-nums}.health-table{overflow:auto}table{width:100%;border-collapse:collapse;text-align:left}th,td{padding:.8rem .7rem;border-bottom:1px solid var(--hair);vertical-align:top}thead th{font-weight:normal}small{display:block;font-weight:normal;color:var(--fg-2);margin-top:.2rem}td:nth-child(n+3){white-space:nowrap;font-variant-numeric:tabular-nums}[data-health-status=unhealthy],[data-health-status=degraded]{font-weight:bold;color:var(--bad)}.health-problems{padding:0;list-style:none}.health-problems li{padding:.8rem 0;border-bottom:1px solid var(--hair)}`,
    script: String.raw`
      (() => {
        let pending = false, again = false, timer, actionBusy = false;
        const actionStatus = document.querySelector("#health-action-status");
        const refresh = async () => {
          if (document.hidden) return;
          if (actionBusy || document.activeElement?.matches("[data-health-prompt]")) { again = true; return; }
          if (pending) { again = true; return; }
          pending = true;
          try {
            const response = await fetch(location.href, { cache: "no-store", signal: AbortSignal.timeout(10000) });
            if (!response.ok) throw new Error("refresh");
            const next = new DOMParser().parseFromString(await response.text(), "text/html").querySelector("[data-health-content]");
            if (!next) throw new Error("refresh");
            if (actionBusy || document.activeElement?.matches("[data-health-prompt]")) { again = true; return; }
            const content = document.querySelector("[data-health-content]");
            const open = new Set([...content.querySelectorAll("details[open]")].map(node => node.dataset.healthDisclosure));
            next.querySelectorAll("details").forEach(node => { node.open = open.has(node.dataset.healthDisclosure); });
            content.replaceChildren(...next.childNodes);
            document.querySelector("#health-refresh").textContent = "";
          } catch { document.querySelector("#health-refresh").textContent = ht.t("health.stale"); }
          finally { pending = false; if (again) { again = false; schedule(); } }
        };
        const schedule = () => { clearTimeout(timer); timer = setTimeout(refresh, 750); };
        const disableActions = value => document.querySelectorAll("[data-health-check], [data-health-policy]").forEach(control => { control.disabled = value; });
        document.addEventListener("change", async event => {
          const input = event.target;
          if (!input.matches("[data-health-policy]")) return;
          if (actionBusy) { input.checked = !input.checked; return; }
          const value = input.checked;
          actionBusy = true; disableActions(true);
          try {
            const response = await fetch(input.dataset.healthPolicy, { method: "PUT", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ unreachableIsUnhealthy: value }), signal: AbortSignal.timeout(10000) });
            if (!response.ok) throw new Error("policy");
            actionStatus.textContent = ht.t("health.policySaved", { name: input.dataset.healthName });
          } catch { input.checked = !value; actionStatus.textContent = ht.t("health.policyFailed"); }
          finally { actionBusy = false; disableActions(false); schedule(); }
        });
        document.addEventListener("click", async event => {
          const check = event.target.closest("[data-health-check]");
          if (check) {
            if (actionBusy) return;
            actionBusy = true;
            disableActions(true);
            actionStatus.textContent = ht.t("health.checking", { name: check.dataset.healthName });
            try {
              const response = await fetch(check.dataset.healthCheck, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: "{}", signal: AbortSignal.timeout(20000) });
              if (!response.ok) throw new Error("check");
              const result = await response.json();
              actionStatus.textContent = ht.t("health.checked", { name: check.dataset.healthName, status: ht.t("health." + result.status) });
            } catch { actionStatus.textContent = ht.t("health.checkFailed"); }
            finally {
              actionBusy = false;
              disableActions(false);
              schedule();
            }
          }
          const copy = event.target.closest("[data-health-copy]");
          if (copy) {
            const area = copy.closest("details").querySelector("[data-health-prompt]");
            const prefix = "HomeTruth installation: " + location.origin + "\nMCP endpoint: " + location.origin + "/mcp\n\n";
            if (!area.value.startsWith(prefix)) area.value = prefix + area.value;
            try { await navigator.clipboard.writeText(area.value); actionStatus.textContent = ht.t("health.copied"); }
            catch { area.focus(); area.select(); actionStatus.textContent = ht.t("health.copyFallback"); }
          }
        });
        document.addEventListener("focusout", event => { if (event.target.matches("[data-health-prompt]") && again) schedule(); });
        const stream = new EventSource(ht.apiPath("/api/services/health/stream"));
        stream.addEventListener("service-event", schedule);
        stream.onerror = () => { document.querySelector("#health-refresh").textContent = ht.t("health.stale"); };
        document.addEventListener("visibilitychange", () => { if (!document.hidden) schedule(); });
        window.addEventListener("pagehide", () => { stream.close(); clearTimeout(timer); }, { once: true });
      })();`,
  });
}
