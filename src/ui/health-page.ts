import type { HealthReport } from "../health/store";
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
    const rank = { unhealthy: 0, degraded: 1, unknown: 2, healthy: 3, disabled: 4 };
    return rank[a.health.status] - rank[b.health.status] || a.name.localeCompare(b.name);
  });
  const statuses = ["healthy", "unhealthy", "degraded", "unknown", "disabled"] as const;
  const counts = Object.fromEntries(statuses.map(status => [status, rows.filter(row => row.health.status === status).length]));
  const content = `<h2>${h(t("health.current"))}</h2>
    <dl class="health-summary">${statuses.map(status => `<div><dt>${h(t(`health.${status}`))}</dt><dd data-health-status="${status}">${h(number(counts[status]!))}</dd></div>`).join("")}</dl>
    <p class="health-note">${h(t("health.asOf", { at: dateTime(report.until) }))}</p>
    <p class="health-note">${h(t("health.historyNote"))}</p>
    <div class="health-table"><table><thead><tr>${(["name", "status", "uptime", "upFor", "lastCheck"] as const).map(key => `<th scope="col">${h(t(`health.${key}`))}</th>`).join("")}</tr></thead>
    <tbody>${rows.map(row => `<tr><th scope="row">${nameLink(row)}<small>${h(t(`health.${row.kind}`))}</small></th>
      <td><span data-health-status="${row.health.status}">${h(t(`health.${row.health.status}`))}</span><small>${h(row.health.detail)}</small></td>
      <td>${row.uptimePercent === null ? "—" : h(number(row.uptimePercent, { maximumFractionDigits: 1 })) + "%"}<small>${h(t("health.observed", { duration: duration(row.observedMs) }))}</small></td>
      <td>${row.healthySince === null ? "—" : h(duration(Date.parse(report.until) - Date.parse(row.healthySince)))}</td>
      <td>${row.health.checkedAt === null ? "—" : `<time datetime="${h(row.health.checkedAt)}">${h(dateTime(row.health.checkedAt))}</time>`}</td></tr>`).join("")}</tbody></table></div>
    ${rows.length ? "" : `<p>${h(t("health.empty"))}</p>`}
    <h2>${h(t("health.problems"))}</h2>
    ${report.problems.length ? `<ul class="health-problems">${report.problems.map(problem => `<li>${nameLink(problem)} · ${h(problem.detail)}
      <small>${h(dateTime(problem.startedAt))} · ${problem.resolvedAt ? h(t("health.resolved", { at: dateTime(problem.resolvedAt) })) : h(t("health.ongoing"))} · ${h(t("health.reports", { count: problem.occurrences }))}</small></li>`).join("")}</ul>` : `<p>${h(t("health.noProblems"))}</p>`}`;
  return renderPage({ ctx, title: t("health.title"), nav: "health", messages: ["health."],
    body: `<h1>${h(t("health.title"))}</h1><nav class="health-period" aria-label="${h(t("health.period"))}">${(["24h", "7d", "30d"] as const).map(value => `<a href="/health?period=${value}"${value === period ? ' aria-current="page"' : ""}>${h(t(`health.period.${value}`))}</a>`).join("")}</nav>
      <p class="health-note">${h(t("health.explanation"))}</p><p id="health-refresh" role="status"></p><section data-health-content>${content}</section>`,
    css: `.health-period{display:flex;gap:1.2rem}.health-period [aria-current]{font-weight:bold}.health-note{max-width:70ch;color:var(--fg-2)}.health-summary{display:flex;flex-wrap:wrap;gap:1rem 2rem}.health-summary dt{color:var(--fg-2)}.health-summary dd{margin:0;font-size:1.7rem;font-variant-numeric:tabular-nums}.health-table{overflow:auto}table{width:100%;border-collapse:collapse;text-align:left}th,td{padding:.8rem .7rem;border-bottom:1px solid var(--hair);vertical-align:top}thead th{font-weight:normal}small{display:block;font-weight:normal;color:var(--fg-2);margin-top:.2rem}td:nth-child(n+3){white-space:nowrap;font-variant-numeric:tabular-nums}[data-health-status=unhealthy],[data-health-status=degraded]{font-weight:bold;color:var(--bad)}.health-problems{padding:0;list-style:none}.health-problems li{padding:.8rem 0;border-bottom:1px solid var(--hair)}`,
    script: String.raw`
      (() => {
        let pending = false, again = false, timer;
        const refresh = async () => {
          if (document.hidden) return;
          if (pending) { again = true; return; }
          pending = true;
          try {
            const response = await fetch(location.href, { cache: "no-store", signal: AbortSignal.timeout(10000) });
            if (!response.ok) throw new Error("refresh");
            const next = new DOMParser().parseFromString(await response.text(), "text/html").querySelector("[data-health-content]");
            if (!next) throw new Error("refresh");
            document.querySelector("[data-health-content]").replaceChildren(...next.childNodes);
            document.querySelector("#health-refresh").textContent = "";
          } catch { document.querySelector("#health-refresh").textContent = ht.t("health.stale"); }
          finally { pending = false; if (again) { again = false; schedule(); } }
        };
        const schedule = () => { clearTimeout(timer); timer = setTimeout(refresh, 750); };
        const stream = new EventSource("/api/services/health/stream");
        stream.addEventListener("service-event", schedule);
        stream.onerror = () => { document.querySelector("#health-refresh").textContent = ht.t("health.stale"); };
        const interval = setInterval(refresh, 60000);
        document.addEventListener("visibilitychange", () => { if (!document.hidden) schedule(); });
        window.addEventListener("pagehide", () => { stream.close(); clearTimeout(timer); clearInterval(interval); }, { once: true });
      })();`,
  });
}
