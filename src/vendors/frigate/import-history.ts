import { FileSecretStore } from "../../config/secrets";
import type { ServiceEvent } from "../../models/event-log";
import { FrigateEventHistory } from "./event-history";
import { frigateEventsConfig, normalizeFrigateObject, type FrigateEventsConfig } from "./events";
import { protectRecordingLink } from "./recordings";

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Frigate's REST history differs from MQTT: 0.17 stores scores inside `data`. */
export function normalizeFrigateHistory(value: unknown, config: FrigateEventsConfig): ServiceEvent | undefined {
  if (!object(value) || !object(value.data) || value.data.type !== "object" || value.false_positive === true) return;
  const data = normalizeFrigateObject({ type: value.end_time == null ? "update" : "end", after: {
    id: value.id, camera: value.camera, label: value.label, false_positive: false,
    top_score: value.data.top_score ?? value.top_score ?? value.data.score,
    // The history API does not supply the original MQTT frame time. Start playback at track start.
    start_time: value.start_time, frame_time: value.start_time, end_time: value.end_time,
    current_zones: [], entered_zones: value.zones,
    sub_label: typeof value.sub_label === "string" ? [value.sub_label] : value.sub_label,
  } });
  if (!data) return;
  const subject = Object.hasOwn(config.cameras, data.camera) ? config.cameras[data.camera]! : `frigate-${data.camera}`;
  return { at: new Date(data.startTime * 1000).toISOString(), type: "camera_object", level: "info", subject,
    message: `Previously detected · ${data.camera}: ${data.subLabel ?? data.label} (${Math.round(data.confidence * 100)}%) · ${data.objectId}`,
    data: { ...data, historical: true, ...protectRecordingLink(config.recordings, data.camera, data.frameTime) } };
}

/** Backfill only the UI archive; never re-publish old detections as live MQTT events. */
export function importFrigateHistory(history: FrigateEventHistory, values: unknown[], config: FrigateEventsConfig): number {
  let imported = 0;
  for (const value of values) {
    const event = normalizeFrigateHistory(value, config);
    if (!event || history.hasObject(event.data!.camera as string, event.data!.objectId as string)) continue;
    if (history.save(event)) imported++;
  }
  return imported;
}

if (import.meta.main) {
  try {
    const input = process.argv[2];
    if (!input || process.argv.length !== 3) throw new Error("Usage: bun src/vendors/frigate/import-history.ts <frigate-events.json>");
    const config = frigateEventsConfig((await new FileSecretStore(process.env.HOMETRUTH_SECRETS).load()).vendors?.frigateEvents);
    if (!config) throw new Error("Configure vendors.frigateEvents before importing history");
    const values: unknown = await Bun.file(input).json();
    if (!Array.isArray(values)) throw new Error("Expected a Frigate /api/events JSON array");
    const history = new FrigateEventHistory(process.env.HOMETRUTH_FRIGATE_HISTORY);
    try { console.log(JSON.stringify({ imported: importFrigateHistory(history, values, config) })); }
    finally { history.close(); }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Frigate history import failed");
    process.exitCode = 1;
  }
}
