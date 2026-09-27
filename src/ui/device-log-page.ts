import type { ServiceEvent } from "../models/event-log";
import type { RegisteredDevice } from "../site";
import { EVENT_LOG_MESSAGES, EVENT_LOG_SCRIPT, eventViewData, renderEventFilters, renderEventList, renderLiveIndicator, type EventTypeView } from "./services-page";
import { deviceNav, escapeHtml, renderDeviceHead, renderPage, type PageContext } from "./shell";

export interface DeviceLogPageOptions {
  ctx: PageContext;
  device: RegisteredDevice;
  types: readonly EventTypeView[];
  events?: readonly ServiceEvent[];
}

/** One device's aggregate, live event log. */
export function renderDeviceLogPage({ ctx, device, types, events = [] }: DeviceLogPageOptions): string {
  const { t } = ctx.i18n;
  const id = encodeURIComponent(device.id);
  return renderPage({
    ctx,
    title: `${t("log.title")} · ${device.name}`,
    nav: deviceNav(device),
    mainAttributes: `data-event-log data-device-id="${escapeHtml(device.id)}" data-events-path="/api/devices/${id}/events" data-stream-path="/api/devices/${id}/events/stream" data-subject="${escapeHtml(device.id)}" ${eventViewData([{ id: device.id, name: device.name, page: device.page }], types)}`,
    body: `${renderDeviceHead(ctx, device, "log")}
      <h2>${escapeHtml(t("log.title"))} ${renderLiveIndicator(ctx)}</h2>
      ${renderEventFilters(ctx, [], types, { omitSubject: true })}
      ${renderEventList(ctx, events, [{ id: device.id, name: device.name, page: device.page }], types)}`,
    script: EVENT_LOG_SCRIPT,
    messages: EVENT_LOG_MESSAGES,
  });
}
