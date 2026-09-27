/**
 * The ontology as YAML, and back.
 *
 * `.hometruth/` is git-ignored and nothing backs it up. Room assignments used
 * to live in `devices.yml`, which is also git-ignored — so moving them
 * into SQLite loses no version control, but it does lose the ability to read
 * and diff them. This is that ability: a plain file a person can open, keep in
 * a backup, and restore from.
 *
 * The export carries UUIDs. That is the point: restoring it puts every tag back
 * with the identity its assignments already reference, so a restore is a
 * restore rather than a re-tagging.
 */
import { stringify } from "yaml";
import { isTaggableKey } from "./identity";
import { DEFAULT_TAG_COLOR, UNNAMED, type Tag, type TagName } from "./model";
import { TagError, type TagStore } from "./store";

export interface TagExport {
  readonly version: 1;
  readonly exportedAt: string;
  readonly names: readonly TagName[];
  readonly tags: readonly Tag[];
  /** Element key to the tag ids on it. */
  readonly assignments: Readonly<Record<string, readonly string[]>>;
}

export function exportTags(store: TagStore, now = () => new Date()): TagExport {
  const assignments: Record<string, readonly string[]> = {};
  for (const [element, ids] of [...store.assignments()].sort(([a], [b]) => a.localeCompare(b))) {
    assignments[element] = [...ids].sort();
  }
  return { version: 1, exportedAt: now().toISOString(), names: store.names(), tags: store.list(), assignments };
}

export function exportTagsYaml(store: TagStore, now = () => new Date()): string {
  return stringify(exportTags(store, now), { lineWidth: 0 });
}

export interface ImportResult {
  readonly names: number;
  readonly tags: number;
  readonly assignments: number;
  /** Assignments skipped because their element key is not one a tag may go on. */
  readonly skipped: number;
}

function isExport(value: unknown): value is TagExport {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<TagExport>;
  return candidate.version === 1 && Array.isArray(candidate.tags) && Array.isArray(candidate.names)
    && typeof candidate.assignments === "object" && candidate.assignments !== null;
}

/**
 * Restore an export. Additive and idempotent: a tag already present keeps its
 * id and takes the exported metadata, and an assignment already there is a
 * no-op. Nothing is deleted, so importing never destroys work the file predates.
 */
export function importTags(store: TagStore, document: unknown): ImportResult {
  if (!isExport(document)) throw new TagError("This is not a HomeTruth tag export", "invalid");
  const exported = document;

  return store.transaction(() => {
    for (const name of exported.names) store.declareName(name);

    let tags = 0;
    const remapped = new Map<string, string>();
    for (const tag of exported.tags) {
      const name = tag.name || UNNAMED;
      const existing = store.get(tag.id) ?? store.byPair(tag.value, name);
      if (existing) {
        // Keep whichever id is already here: assignments point at it.
        remapped.set(tag.id, existing.id);
        store.update(existing.id, { name, value: tag.value, color: tag.color, description: tag.description }, existing.revision);
      } else {
        store.restore({ ...tag, name, color: tag.color || DEFAULT_TAG_COLOR });
        remapped.set(tag.id, tag.id);
      }
      tags += 1;
    }

    let assignments = 0;
    let skipped = 0;
    for (const [element, ids] of Object.entries(exported.assignments)) {
      if (!isTaggableKey(element)) { skipped += ids.length; continue; }
      for (const id of ids) {
        const target = remapped.get(id) ?? id;
        if (!store.get(target)) { skipped += 1; continue; }
        store.attach(element, { tagId: target });
        assignments += 1;
      }
    }
    return { names: exported.names.length, tags, assignments, skipped };
  });
}
