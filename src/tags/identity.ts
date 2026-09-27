/**
 * Tags are not elements: they have no capabilities, no state, and no place in
 * the site's structure, and nothing can tag one. They still need keys, because
 * they are nodes in the tag graph, so they are kinds here and excluded from
 * `TAGGABLE_KINDS`.
 */
export const TAG_KINDS = ["tag", "tag-name"] as const;

export const ELEMENT_KINDS = ["site", "catalog", "device", "group", "group-switch", "speaker-group", "service", "capability", "control", "property", "sensor", "scene", "show", "preset", "signal", "automation", "region", "room", "widget", "dashboard", "model", "schema", "event-type", "tag", "tag-name"] as const;
export type ElementKind = typeof ELEMENT_KINDS[number];

/** Every kind that may carry a tag: everything but the tag graph itself. */
export const TAGGABLE_KINDS: readonly ElementKind[] = ELEMENT_KINDS.filter(
  (kind): kind is ElementKind => !(TAG_KINDS as readonly string[]).includes(kind),
);
export function isTaggable(kind: ElementKind): boolean {
  return !(TAG_KINDS as readonly string[]).includes(kind);
}

/** The site is a singleton with a reserved public identity. */
export const ROOT_ELEMENT_KEY = "root";

/** Scoped, collision-free keys do not depend on an element's display name or URL. */
export function elementKey(kind: ElementKind, ...ids: string[]): string {
  if (kind === "site") return ROOT_ELEMENT_KEY;
  return Buffer.from(JSON.stringify([kind, ...ids])).toString("base64url");
}
export function isElementKey(key: string): boolean {
  if (key === ROOT_ELEMENT_KEY) return true;
  try {
    const parts: unknown = JSON.parse(Buffer.from(key, "base64url").toString("utf8"));
    return Array.isArray(parts) && parts.length >= 2 && parts.every(part => typeof part === "string" && part.length > 0)
      && (ELEMENT_KINDS as readonly string[]).includes(parts[0]) && elementKey(parts[0], ...parts.slice(1)) === key;
  } catch { return false; }
}

/** True for a key that names something a tag may be attached to. */
export function isTaggableKey(key: string): boolean {
  const parsed = parseElementKey(key);
  return parsed !== undefined && isTaggable(parsed.kind);
}

/** The kind and id parts a key encodes, or undefined when it is not a key. */
export function parseElementKey(key: string): { kind: ElementKind; ids: string[] } | undefined {
  if (key === ROOT_ELEMENT_KEY) return { kind: "site", ids: [ROOT_ELEMENT_KEY] };
  if (!isElementKey(key)) return undefined;
  const parts = JSON.parse(Buffer.from(key, "base64url").toString("utf8")) as string[];
  return { kind: parts[0] as ElementKind, ids: parts.slice(1) };
}
