/** Only observations returned by the current read, never Matter's persisted cache. */
export interface MatterAttribute {
  endpoint: number;
  cluster: number;
  attribute: number;
  value?: unknown;
}
export interface MatterSnapshot { observedAt: string; attributes: MatterAttribute[] }

export function parseMatterSnapshot(value: unknown): MatterSnapshot {
  const s = value as Partial<MatterSnapshot> | null;
  if (!s || typeof s.observedAt !== "string" || !Number.isFinite(Date.parse(s.observedAt))
    || !Array.isArray(s.attributes) || !s.attributes.length || s.attributes.length > 4000) throw new Error("Invalid Matter snapshot");
  const paths = new Set<string>();
  for (const a of s.attributes) {
    if (!a || ![a.endpoint, a.cluster, a.attribute].every(v => Number.isInteger(v) && v >= 0)) throw new Error("Invalid Matter attribute");
    const path = `${a.endpoint}/${a.cluster}/${a.attribute}`;
    if (paths.has(path)) throw new Error("Duplicate Matter attribute");
    paths.add(path);
  }
  return s as MatterSnapshot;
}

/** The path an attribute is unique by; `parseMatterSnapshot` rejects a snapshot that repeats one. */
function attributePath(attribute: MatterAttribute): string {
  return `${attribute.endpoint}/${attribute.cluster}/${attribute.attribute}`;
}

/**
 * Fold a report's attributes into the picture built so far, newer winning per path.
 *
 * A subscription's DataReports are deltas — each carries only the paths that changed — while
 * everything that reads a `MatterSnapshot` treats it as the complete picture of the hub. Merging
 * is what turns the one into the other, so a door opening updates that door and leaves the other
 * eight sensors, and the hub's own identity, exactly as they were.
 */
export function mergeAttributes(base: readonly MatterAttribute[], incoming: readonly MatterAttribute[]): MatterAttribute[] {
  const merged = new Map(base.map(attribute => [attributePath(attribute), attribute]));
  // A status where a value used to be replaces it: the path is still there, its reading is not.
  for (const attribute of incoming) merged.set(attributePath(attribute), attribute);
  return [...merged.values()];
}

export function matterValue(snapshot: MatterSnapshot, endpoint: number, cluster: number, attribute: number): unknown {
  return snapshot.attributes.find(a => a.endpoint === endpoint && a.cluster === cluster && a.attribute === attribute)?.value;
}

export function matterAccessories(snapshot: MatterSnapshot) {
  const endpoints = [...new Set(snapshot.attributes.filter(a => a.cluster === 0x39).map(a => a.endpoint))];
  return endpoints.map(endpoint => {
    const value = (attribute: number) => matterValue(snapshot, endpoint, 0x39, attribute);
    const text = (attribute: number) => typeof value(attribute) === "string" ? value(attribute) as string : undefined;
    const name = text(5) ?? text(3) ?? `Accessory ${endpoint}`;
    const model = text(12) ?? text(3);
    const serialNumber = text(15);
    return { id: String(endpoint), name, ...(model ? { model } : {}), ...(serialNumber ? { serialNumber } : {}) };
  });
}
