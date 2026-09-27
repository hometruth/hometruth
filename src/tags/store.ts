/**
 * Where the tag ontology lives.
 *
 * A tag is a `(name, value)` pair with a UUID, and assignments are UUID-only,
 * so renaming a tag never rewrites a link. That property is what rooms wanted
 * and never had: a room's identity used to *be* its name, so renaming one
 * orphaned every tag attached to it.
 *
 * This store stopped being a nicety when rooms moved into it: it is now the
 * only record of which room a device is in. Hence `synchronous=FULL` — these
 * are rare, human-scale writes, and full sync costs nothing at this rate while
 * closing the window where a power loss drops the last transactions.
 */
import { isTaggableKey } from "./identity";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import {
  BUILTIN_TAG_NAMES, DEFAULT_TAG_COLOR, ROOM, UNNAMED,
  tagCreateSchema, tagNameSchema, tagSlug,
  type Tag, type TagFields, type TagName,
} from "./model";

const ajv = new Ajv2020({ strict: true, allErrors: true });
const validateFields = ajv.compile<TagFields>(tagCreateSchema);
const validateName = ajv.compile<TagName>(tagNameSchema);

export class TagError extends Error {
  constructor(message: string, readonly code: "invalid" | "missing" | "conflict") { super(message); this.name = "TagError"; }
}

function validFields(value: TagFields): void {
  if (!validateFields(value)) {
    throw new TagError("Use a tag name of letters (A–Z, a–z), numbers (0–9), and dashes, a value of up to 200 characters, a six-digit hex color, and a description of up to 4000 characters", "invalid");
  }
}

/** What `attach` accepts: an exact tag, or the pair to find or create. */
export interface TagRef { tagId?: string; name?: string; value?: string }

/** The current database layout. Bumped when a migration is added below. */
const SCHEMA_VERSION = 2;

export class TagStore {
  private readonly db: Database;
  private cachedTags: Tag[] = [];
  private cachedNames: TagName[] = [];
  private cachedAssignments = new Map<string, string[]>();
  revision = 0;
  private readonly listeners = new Set<() => void>();
  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private fingerprint = "";

  /** Storage is read at bootstrap/refresh and after writes, never during rendering. */
  refresh(): void {
    this.cachedTags = this.db.query("SELECT * FROM tags ORDER BY name, value COLLATE NOCASE, id").all() as Tag[];
    this.cachedNames = this.db.query("SELECT * FROM tag_names ORDER BY name").all() as TagName[];
    const assignments = new Map<string, string[]>();
    for (const row of this.db.query("SELECT element_key, tag_id FROM element_tags ORDER BY tag_id").all() as { element_key: string; tag_id: string }[]) {
      assignments.set(row.element_key, [...(assignments.get(row.element_key) ?? []), row.tag_id]);
    }
    this.cachedAssignments = assignments;
    const fingerprint = JSON.stringify([this.cachedTags, this.cachedNames, [...assignments]]);
    if (fingerprint !== this.fingerprint) { this.fingerprint = fingerprint; this.revision++; for (const listener of this.listeners) listener(); }
  }


  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { strict: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tag_names (
        name TEXT PRIMARY KEY, label TEXT NOT NULL, cardinality TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tags (
        id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', value TEXT NOT NULL, color TEXT NOT NULL,
        description TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
        UNIQUE(name, value)
      );
      CREATE TABLE IF NOT EXISTS element_tags (
        element_key TEXT NOT NULL, tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY(element_key, tag_id)
      );
      CREATE INDEX IF NOT EXISTS tags_by_element ON element_tags(tag_id, element_key);`);
    this.migrate();
    this.refresh();
    for (const builtin of BUILTIN_TAG_NAMES) this.declareName(builtin);
  }

  /**
   * Version 1 stored a single `slug` column and had no names. Every such tag is
   * a plain tag, so it migrates by becoming `('', slug)` — no assignment moves,
   * because assignments were always by UUID.
   */
  private migrate(): void {
    const version = (this.db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    // The repair runs whatever the version says: the databases that need it are
    // already stamped v2, because the migration that broke them completed.
    if (version >= SCHEMA_VERSION) { this.repairDanglingReference(); return; }
    const columns = (this.db.query("PRAGMA table_info(tags)").all() as { name: string }[]).map(column => column.name);
    if (columns.includes("slug")) {
      // Two SQLite behaviours have to be suspended for this swap, and both bite
      // `element_tags`, which references `tags` with `ON DELETE CASCADE`:
      //
      //  - `foreign_keys=OFF`, or dropping the old table takes every assignment
      //    with it through the cascade.
      //  - `legacy_alter_table=ON`, or `RENAME TO` helpfully rewrites
      //    `element_tags`'s REFERENCES clause to point at `tags_v1`. Dropping
      //    `tags_v1` then leaves it referencing a table that does not exist,
      //    and every later write fails with "no such table: main.tags_v1" —
      //    long after the migration looked like it had succeeded.
      this.db.exec("PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON");
      this.db.transaction(() => {
        this.db.exec(`
          ALTER TABLE tags RENAME TO tags_v1;
          CREATE TABLE tags (
            id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', value TEXT NOT NULL, color TEXT NOT NULL,
            description TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
            UNIQUE(name, value)
          );
          INSERT INTO tags (id, name, value, color, description, revision)
            SELECT id, '', slug, color, description, revision FROM tags_v1;
          DROP TABLE tags_v1;`);
      }).immediate();
      this.db.exec("PRAGMA legacy_alter_table=OFF");
      const orphans = this.db.query("PRAGMA foreign_key_check").all();
      this.db.exec("PRAGMA foreign_keys=ON");
      if (orphans.length > 0) throw new TagError("The tag database could not be upgraded without losing assignments", "conflict");
    }
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    this.repairDanglingReference();
  }

  /**
   * Repair an `element_tags` left pointing at `tags_v1`.
   *
   * An earlier build of the v1 migration renamed `tags` without
   * `legacy_alter_table`, so SQLite rewrote this table's REFERENCES clause to
   * follow the rename, and the subsequent `DROP` left it referencing nothing.
   * The damage is invisible until the first write, which fails with "no such
   * table: main.tags_v1" on a database that otherwise looks migrated.
   *
   * Rebuilding the table is the only way to change a REFERENCES clause, and the
   * rows themselves are fine, so they are carried across unchanged.
   */
  private repairDanglingReference(): void {
    const row = this.db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'element_tags'")
      .get() as { sql: string } | null;
    if (!row || !/REFERENCES\s+"?tags_v1"?/u.test(row.sql)) return;

    this.db.exec("PRAGMA foreign_keys=OFF; PRAGMA legacy_alter_table=ON");
    this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE element_tags_fixed (
          element_key TEXT NOT NULL, tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
          PRIMARY KEY(element_key, tag_id)
        );
        INSERT OR IGNORE INTO element_tags_fixed (element_key, tag_id)
          SELECT element_key, tag_id FROM element_tags WHERE tag_id IN (SELECT id FROM tags);
        DROP TABLE element_tags;
        ALTER TABLE element_tags_fixed RENAME TO element_tags;
        CREATE INDEX IF NOT EXISTS tags_by_element ON element_tags(tag_id, element_key);`);
    }).immediate();
    this.db.exec("PRAGMA legacy_alter_table=OFF; PRAGMA foreign_keys=ON");
  }

  // --- Names -------------------------------------------------------------

  /** Every declared name, the unnamed root excluded: it needs no record. */
  names(): TagName[] {
    return [...this.cachedNames];
  }

  nameOf(name: string): TagName | undefined {
    return this.cachedNames.find(entry => entry.name === name);
  }

  /** Idempotent: re-declaring a name updates its label and cardinality. */
  declareName(declaration: TagName): TagName {
    if (!validateName(declaration) || declaration.name === UNNAMED) {
      throw new TagError("Use a tag name of letters (A–Z, a–z), numbers (0–9), and dashes, a label, and a cardinality of single or multi", "invalid");
    }
    this.db.query("INSERT INTO tag_names (name, label, cardinality) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET label = excluded.label, cardinality = excluded.cardinality")
      .run(declaration.name, declaration.label, declaration.cardinality);
    this.refresh();
    return this.nameOf(declaration.name)!;
  }

  /** A name nobody declared is multi-valued, like a plain tag. */
  private isSingleValued(name: string): boolean {
    return name !== UNNAMED && this.nameOf(name)?.cardinality === "single";
  }

  // --- Tags --------------------------------------------------------------

  list(): Tag[] {
    return [...this.cachedTags];
  }

  /** Every tag under one name — every room, for `room`. */
  listNamed(name: string): Tag[] {
    return this.cachedTags.filter(tag => tag.name === name);
  }

  get(id: string): Tag | undefined {
    return this.cachedTags.find(tag => tag.id === id);
  }

  /** The exact pair. `name` defaults to the unnamed root. */
  byPair(value: string, name = UNNAMED): Tag | undefined {
    return this.cachedTags.find(tag => tag.name === name && tag.value === value);
  }

  /**
   * By URL slug, which is what a `/tags/...` route has. The slug is derived
   * rather than stored, so this resolves against the derived form; an exact
   * value match wins over a slug match, because a value may legitimately look
   * like another value's slug.
   */
  bySlug(slug: string, name = UNNAMED): Tag | undefined {
    const exact = this.byPair(slug, name);
    if (exact) return exact;
    return this.listNamed(name).find(tag => tagSlug(tag.value) === slug);
  }

  create(fields: TagFields): Tag {
    const name = fields.name ?? UNNAMED;
    validFields({ ...fields, name });
    return this.transaction(() => {
      if (this.byPair(fields.value, name)) throw new TagError("A tag with that name and value already exists", "conflict");
      const tag: Tag = { id: randomUUID(), ...fields, name, color: fields.color.toLowerCase(), revision: 1 };
      this.db.query("INSERT INTO tags (id, name, value, color, description) VALUES (?, ?, ?, ?, ?)")
        .run(tag.id, tag.name, tag.value, tag.color, tag.description);
      this.refresh();
      return tag;
    });
  }


  /**
   * Insert a tag keeping the id it already has. Only for restoring an export:
   * the id is what every assignment in that file points at, so generating a new
   * one would silently detach all of them.
   */
  restore(tag: Tag): Tag {
    const name = tag.name || UNNAMED;
    // Only the editable fields: `validFields` checks the create schema, which
    // does not admit `id` or `revision`.
    validFields({ name, value: tag.value, color: tag.color, description: tag.description });
    return this.transaction(() => {
      if (this.get(tag.id)) throw new TagError("A tag with that id already exists", "conflict");
      if (this.byPair(tag.value, name)) throw new TagError("A tag with that name and value already exists", "conflict");
      this.db.query("INSERT INTO tags (id, name, value, color, description, revision) VALUES (?, ?, ?, ?, ?, ?)")
        .run(tag.id, name, tag.value, tag.color.toLowerCase(), tag.description, Math.max(1, tag.revision));
      this.refresh();
      return this.get(tag.id)!;
    });
  }

  /**
   * Rename and re-describe. This is how a room is renamed: the UUID does not
   * move, so every assignment survives and only the display name and the URL
   * it derives change.
   */
  update(id: string, fields: TagFields, revision: number): Tag {
    const name = fields.name ?? UNNAMED;
    validFields({ ...fields, name });
    return this.transaction(() => {
      const current = this.get(id);
      if (!current) throw new TagError("Tag not found", "missing");
      if (current.revision !== revision) throw new TagError("This tag changed elsewhere. Reload before saving", "conflict");
      const duplicate = this.byPair(fields.value, name);
      if (duplicate && duplicate.id !== id) throw new TagError("A tag with that name and value already exists", "conflict");
      this.db.query("UPDATE tags SET name = ?, value = ?, color = ?, description = ?, revision = revision + 1 WHERE id = ?")
        .run(name, fields.value, fields.color.toLowerCase(), fields.description, id);
      this.refresh();
      return this.get(id)!;
    });
  }

  // --- Assignments -------------------------------------------------------

  tagsFor(elementKey: string): Tag[] {
    const ids = this.cachedAssignments.get(elementKey) ?? [];
    return this.cachedTags.filter(tag => ids.includes(tag.id));
  }

  tagFor(elementKey: string, name: string): Tag | undefined {
    return this.tagsFor(elementKey).find(tag => tag.name === name);
  }

  elementsWith(tagId: string): string[] {
    return [...this.cachedAssignments].filter(([, ids]) => ids.includes(tagId)).map(([key]) => key).sort();
  }

  assignments(): Map<string, string[]> {
    return new Map([...this.cachedAssignments].map(([key, ids]) => [key, [...ids]]));
  }

  /**
   * Incremental and idempotent, so independent editors do not lose each other's
   * work. Under a single-valued name the attach *replaces* in the same
   * transaction, rather than leaving a device in two rooms.
   */
  attach(elementKey: string, input: TagRef): Tag[] {
    if (!isTaggableKey(elementKey)) throw new TagError("Invalid element; tags cannot be tagged", "invalid");
    return this.transaction(() => {
      let tag: Tag | undefined;
      if (input.tagId) tag = this.get(input.tagId);
      else if (input.value !== undefined) {
        const name = input.name ?? UNNAMED;
        tag = this.byPair(input.value, name) ?? this.create({ name, value: input.value, color: DEFAULT_TAG_COLOR, description: "" });
      }
      if (!tag) throw new TagError("Tag not found", "missing");
      if (this.isSingleValued(tag.name)) {
        this.db.query("DELETE FROM element_tags WHERE element_key = ? AND tag_id IN (SELECT id FROM tags WHERE name = ?)").run(elementKey, tag.name);
      }
      this.db.query("INSERT OR IGNORE INTO element_tags (element_key, tag_id) VALUES (?, ?)").run(elementKey, tag.id);
      this.refresh();
      return this.tagsFor(elementKey);
    });
  }

  detach(elementKey: string, tagId: string): Tag[] {
    this.db.query("DELETE FROM element_tags WHERE element_key = ? AND tag_id = ?").run(elementKey, tagId);
    this.refresh();
    return this.tagsFor(elementKey);
  }

  /** Remove an element's tag under a name, whichever value it holds. */
  detachName(elementKey: string, name: string): Tag[] {
    this.db.query("DELETE FROM element_tags WHERE element_key = ? AND tag_id IN (SELECT id FROM tags WHERE name = ?)").run(elementKey, name);
    this.refresh();
    return this.tagsFor(elementKey);
  }

  // --- Rooms -------------------------------------------------------------
  //
  // A room is the tag `room = <name>`, so these are thin reads over the pair.
  // They exist because `Site` consumes rooms through one narrow interface, and
  // keeping the shape it already expects is what let rooms move into tags
  // without rewriting every page that shows one.

  /** Every room the ontology knows, in display order. */
  rooms(): readonly string[] {
    return this.listNamed(ROOM).map(tag => tag.value);
  }

  /** The room an element is in. `room` is single-valued, so there is at most one. */
  roomOf(elementKey: string): string | undefined {
    return this.tagFor(elementKey, ROOM)?.value;
  }

  /** True once the room migration has run, so it runs exactly once. */
  migrated(key: string): boolean {
    this.db.exec("CREATE TABLE IF NOT EXISTS migrations (key TEXT PRIMARY KEY, at TEXT NOT NULL)");
    return this.db.query("SELECT key FROM migrations WHERE key = ?").get(key) !== null;
  }

  markMigrated(key: string): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS migrations (key TEXT PRIMARY KEY, at TEXT NOT NULL)");
    this.db.query("INSERT OR IGNORE INTO migrations (key, at) VALUES (?, ?)").run(key, new Date().toISOString());
  }

  /** One transaction around a caller's work, for the room migration. */
  transaction<T>(work: () => T): T {
    try { return this.db.transaction(() => { this.refresh(); return work(); }).immediate(); }
    finally { this.refresh(); }
  }

  close(): void { this.db.close(); }
}

export { ROOM };
