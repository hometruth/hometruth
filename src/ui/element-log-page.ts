import type { GraphNode } from "../graph/types";
import type { ServiceEvent } from "../models/event-log";
import { EVENT_TYPES } from "../models/event-types";
import { EVENT_LOG_MESSAGES, EVENT_LOG_SCRIPT, eventViewData, renderEventFilters, renderEventList, renderLiveIndicator, type EventSubjectView } from "./services-page";
import { escapeHtml as e, renderPage, type PageContext } from "./shell";

export function renderElementLogPage(ctx: PageContext, node: GraphNode, events: readonly ServiceEvent[], subjects: readonly EventSubjectView[]): string {
  const { t } = ctx.i18n;
  const api = `/api/elements/${encodeURIComponent(node.id)}/events`;
  return renderPage({
    ctx, title: `${t("log.title")} · ${node.name}`, nav: "events",
    mainAttributes: `data-event-log data-events-path="${e(api)}" data-stream-path="${e(api)}/stream" ${eventViewData(subjects, EVENT_TYPES)}`,
    body: `<h1>${e(node.name)}</h1><nav class="tabs" aria-label="${e(t("device.tabs.label"))}"><a href="${e(node.page || ctx.apiPath(`/elements/${encodeURIComponent(node.id)}`))}">${e(t("device.tabs.controls"))}</a><a href="${e(ctx.path.split("?")[0]!)}" aria-current="page">${e(t("device.tabs.log"))}</a></nav>
      <h2>${e(t("log.title"))} ${renderLiveIndicator(ctx)}</h2>
      ${renderEventFilters(ctx, subjects, EVENT_TYPES)}${renderEventList(ctx, events, subjects, EVENT_TYPES)}`,
    script: EVENT_LOG_SCRIPT, messages: EVENT_LOG_MESSAGES,
  });
}
