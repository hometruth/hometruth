import type { ServiceEvent } from "../models/event-log";

/** Stored events retain model identities; their advertised media URL uses current public names. */
export function eventForApi(event: ServiceEvent, apiPath: (path: string) => string): ServiceEvent {
  const thumbnailUrl = event.data?.thumbnailUrl;
  if (typeof thumbnailUrl !== "string" || !thumbnailUrl.startsWith("/api/devices/")) return event;
  const publicUrl = apiPath(thumbnailUrl);
  return publicUrl === thumbnailUrl ? event : { ...event, data: { ...event.data, thumbnailUrl: publicUrl } };
}
