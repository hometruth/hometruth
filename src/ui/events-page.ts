import type { ServiceEvent } from "../models/event-log";
import { EVENT_LOG_MESSAGES, EVENT_LOG_SCRIPT, eventViewData, renderEventFilters, renderEventList, renderLiveIndicator, type EventSubjectView, type EventTypeView } from "./services-page";
import { escapeHtml, renderPage, type PageContext } from "./shell";

export interface EventsPageOptions {
  ctx: PageContext;
  /** Every device an event can be about; the device filter. */
  subjects: readonly EventSubjectView[];
  types: readonly EventTypeView[];
  events?: readonly ServiceEvent[];
}

/** Every event across HomeTruth, its devices, and its services, live, with saved filters. */
export function renderEventsPage({ ctx, subjects, types, events = [] }: EventsPageOptions): string {
  const { t } = ctx.i18n;
  return renderPage({
    ctx,
    title: t("nav.events"),
    nav: "events",
    mainAttributes: `data-event-log data-events-path="/api/events" data-stream-path="/api/events/stream" ${eventViewData(subjects, types)}`,
    body: `<h1>${escapeHtml(t("nav.events"))} ${renderLiveIndicator(ctx)}</h1>
      ${renderEventFilters(ctx, subjects, types)}
      ${renderEventList(ctx, events, subjects, types)}`,
    script: EVENT_LOG_SCRIPT,
    messages: EVENT_LOG_MESSAGES,
  });
}
