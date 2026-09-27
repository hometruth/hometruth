/** The same vocabulary is used by SQL history filters and live subscriptions. */
export function detectionLabel(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\u0000-\u001f]/u.test(value)) return;
  const label = value.trim().toLowerCase().replaceAll("_", " ");
  return label === "human" ? "person" : label === "blank" ? "no detection" : label === "no cv result" ? "unclassified" : label;
}

export function detectionLabels(data: Readonly<Record<string, unknown>> = {}): string[] {
  const classification = data.classification as { label?: unknown } | undefined;
  const detections = Array.isArray(data.detections) ? data.detections as { label?: unknown }[] : [];
  const values = [data.label, data.subLabel, classification?.label, ...detections.map(d => d?.label)];
  const labels = [...new Set(values.map(detectionLabel).filter((label): label is string => !!label))].sort();
  return labels.length || !Array.isArray(data.detections) ? labels : ["no detection"];
}

/** Count label events, once per label per event (not individual objects in a frame). */
export function countDetectionLabels(events: readonly { data?: Readonly<Record<string, unknown>> }[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) for (const label of detectionLabels(event.data)) counts.set(label, (counts.get(label) ?? 0) + 1);
  return Object.fromEntries(counts);
}
