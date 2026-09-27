import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TagStore } from "./store";
import { elementKey } from "./elements";
import { ROOM } from "./model";

const fields = { name: "", value: "foobar", color: "#AA3377", description: "A shared tag" };
const lamp = elementKey("device", "lamp");
const bath = elementKey("device", "bath-light");

describe("UUID tags", () => {
  test("renames metadata without changing any element association and rejects stale edits", () => {
    const store = new TagStore();
    try {
      const tag = store.create(fields);
      expect(tag.id).toMatch(/^[a-f0-9-]{36}$/);
      const sensor = elementKey("sensor", "lamp", "temperature");
      store.attach(lamp, { tagId: tag.id }); store.attach(sensor, { tagId: tag.id });
      const before = store.assignments();
      const next = store.update(tag.id, { ...fields, value: "Renamed2", color: "#009988", description: "New description" }, tag.revision);
      expect(next).toMatchObject({ id: tag.id, value: "Renamed2", color: "#009988", description: "New description", revision: 2 });
      expect(store.assignments()).toEqual(before);
      expect(store.tagsFor(lamp)).toEqual([next]);
      expect(store.byPair("foobar")).toBeUndefined();
      expect(() => store.update(tag.id, fields, 1)).toThrow("changed elsewhere");
      const duplicate = store.create({ ...fields, value: "other" });
      expect(() => store.update(tag.id, { ...fields, value: duplicate.value }, 2)).toThrow("already exists");
      expect(store.get(tag.id)).toEqual(next);
    } finally { store.close(); }
  });

  test("a value is a display string, a name is an identifier, and the pair is unique", () => {
    const store = new TagStore();
    try {
      for (const value of ["Kitchen2", "Master Bathroom", "Étage", "a", "foo-bar", "第二階", "Ann's room"]) {
        expect(store.create({ ...fields, value }).value).toBe(value);
      }
      // Control characters only: a space is what makes "Master Bathroom" possible.
      for (const value of ["", "a\tb", "a\nb", "a\u0000b"]) expect(() => store.create({ ...fields, value })).toThrow();
      // A name appears in URLs unescaped and is compared exactly, so it stays strict.
      expect(store.create({ ...fields, name: "floor", value: "2" }).name).toBe("floor");
      for (const name of ["two words", "foo_bar", "Étage", "foo/bar"]) expect(() => store.create({ ...fields, name, value: "x" })).toThrow();
      expect(() => store.create({ ...fields, color: "red;display:none" })).toThrow();
      // Uniqueness is on the pair: `room = Attic` and `#attic` are different tags.
      const plain = store.create({ ...fields, value: "Attic" });
      const room = store.create({ ...fields, name: ROOM, value: "Attic" });
      expect(room.id).not.toBe(plain.id);
      expect(() => store.create({ ...fields, name: ROOM, value: "Attic" })).toThrow("already exists");
      expect(store.byPair("Attic")).toMatchObject({ id: plain.id, name: "" });
      expect(store.byPair("Attic", ROOM)).toMatchObject({ id: room.id });
    } finally { store.close(); }
  });

  test("a slug resolves a tag, and survives the rename that changes it", () => {
    const store = new TagStore();
    try {
      const room = store.create({ ...fields, name: ROOM, value: "Master Bathroom" });
      expect(store.bySlug("master-bathroom", ROOM)!.id).toBe(room.id);
      expect(store.bySlug("master-bathroom")).toBeUndefined();
      const renamed = store.update(room.id, { ...fields, name: ROOM, value: "Main Bathroom" }, room.revision);
      expect(renamed.id).toBe(room.id);
      expect(store.bySlug("main-bathroom", ROOM)!.id).toBe(room.id);
    } finally { store.close(); }
  });

  test("a single-valued name replaces rather than accumulates, so nothing is in two rooms", () => {
    const store = new TagStore();
    try {
      store.attach(lamp, { name: ROOM, value: "Kitchen" });
      store.attach(lamp, { name: ROOM, value: "Master Bathroom" });
      expect(store.tagsFor(lamp).filter(tag => tag.name === ROOM).map(tag => tag.value)).toEqual(["Master Bathroom"]);
      expect(store.tagFor(lamp, ROOM)!.value).toBe("Master Bathroom");
      // Plain tags are always multi-valued, and the replace never touches them.
      store.attach(lamp, { value: "favourite" }); store.attach(lamp, { value: "downstairs" });
      store.attach(lamp, { name: ROOM, value: "Hall" });
      expect(store.tagsFor(lamp).filter(tag => !tag.name)).toHaveLength(2);
      expect(store.tagFor(lamp, ROOM)!.value).toBe("Hall");
      // A name nobody declared is multi-valued.
      store.attach(lamp, { name: "zone", value: "a" }); store.attach(lamp, { name: "zone", value: "b" });
      expect(store.tagsFor(lamp).filter(tag => tag.name === "zone")).toHaveLength(2);
      store.attach(bath, { name: ROOM, value: "Master Bathroom" });
      expect(store.elementsWith(store.byPair("Master Bathroom", ROOM)!.id)).toEqual([bath]);
      expect(store.detachName(bath, ROOM).filter(tag => tag.name === ROOM)).toHaveLength(0);
    } finally { store.close(); }
  });

  test("declared names carry their cardinality and label, and room ships declared", () => {
    const store = new TagStore();
    try {
      expect(store.nameOf(ROOM)).toEqual({ name: ROOM, label: "Room", cardinality: "single" });
      store.declareName({ name: "floor", label: "Floor", cardinality: "single" });
      store.declareName({ name: "floor", label: "Storey", cardinality: "multi" });
      expect(store.nameOf("floor")).toEqual({ name: "floor", label: "Storey", cardinality: "multi" });
      expect(store.names().map(entry => entry.name)).toEqual(["floor", ROOM]);
      expect(() => store.declareName({ name: "", label: "Nope", cardinality: "multi" })).toThrow();
    } finally { store.close(); }
  });

  test("incremental assignments are idempotent, many-to-many, and create tags atomically", () => {
    const store = new TagStore();
    try {
      const [first] = store.attach(lamp, { value: "newtag" });
      expect(first!.value).toBe("newtag");
      store.attach(lamp, { value: "newtag" });
      store.attach(lamp, { value: "secondtag" });
      expect(store.tagsFor(lamp)).toHaveLength(2);
      const sibling = elementKey("sensor", "other-device", "temperature");
      store.attach(sibling, { value: "newtag" });
      expect(store.tagsFor(sibling)[0]!.id).toBe(first!.id);
      expect(store.detach(lamp, first!.id)).toHaveLength(1);
      expect(store.tagsFor(sibling)).toHaveLength(1);
      expect(() => store.attach(lamp, { tagId: "missing" })).toThrow("Tag not found");
      expect(store.list()).toHaveLength(2);
      expect(() => store.attach(Buffer.from(JSON.stringify(["tag", first!.id])).toString("base64url"), { value: "nope" })).toThrow("cannot be tagged");
    } finally { store.close(); }
  });

  test("persists across restarts and coordinates independent writers", () => {
    const dir = mkdtempSync(join(tmpdir(), "hometruth-tags-"));
    const path = join(dir, "tags.sqlite");
    let store = new TagStore(path);
    try {
      const tag = store.create(fields); store.attach(lamp, { tagId: tag.id }); store.close();
      store = new TagStore(path);
      expect(store.tagsFor(lamp)[0]!.id).toBe(tag.id);
      const other = new TagStore(path);
      try {
        other.attach(lamp, { value: "secondtag" });
        store.attach(lamp, { value: "thirdtag" });
        expect(other.tagsFor(lamp)).toHaveLength(2); // Reads stay at the last explicit refresh.
        other.refresh();
        expect(other.tagsFor(lamp)).toHaveLength(3);
        other.update(tag.id, { ...fields, value: "changed" }, tag.revision);
        expect(() => store.update(tag.id, fields, tag.revision)).toThrow("changed elsewhere");
      } finally { other.close(); }
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  test("a version 1 database migrates its slugs to unnamed tags, keeping every assignment", () => {
    const dir = mkdtempSync(join(tmpdir(), "hometruth-tags-v1-"));
    const path = join(dir, "tags.sqlite");
    const legacy = new Database(path, { strict: true });
    legacy.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE tags (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, color TEXT NOT NULL, description TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE element_tags (element_key TEXT NOT NULL, tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY(element_key, tag_id));
      INSERT INTO tags (id, slug, color, description, revision) VALUES ('11111111-1111-4111-8111-111111111111', 'speakers', '#346b8e', 'Old tag', 3);
      INSERT INTO element_tags (element_key, tag_id) VALUES ('${lamp}', '11111111-1111-4111-8111-111111111111');`);
    legacy.close();
    const store = new TagStore(path);
    try {
      const migrated = store.get("11111111-1111-4111-8111-111111111111")!;
      expect(migrated).toMatchObject({ name: "", value: "speakers", description: "Old tag", revision: 3 });
      expect(store.tagsFor(lamp).map(tag => tag.id)).toEqual([migrated.id]);
      // Running again is a no-op, and the upgraded database takes named tags.
      store.create({ ...fields, name: ROOM, value: "Kitchen" });
      expect(store.byPair("speakers")!.id).toBe(migrated.id);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  test("the v1 migration leaves element_tags pointing at tags, not at the renamed table", () => {
    const dir = mkdtempSync(join(tmpdir(), "hometruth-tags-fk-"));
    const path = join(dir, "tags.sqlite");
    const legacy = new Database(path, { strict: true });
    legacy.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE tags (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, color TEXT NOT NULL, description TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE element_tags (element_key TEXT NOT NULL, tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY(element_key, tag_id));
      INSERT INTO tags (id, slug, color, description) VALUES ('11111111-1111-4111-8111-111111111111', 'speakers', '#346b8e', '');
      INSERT INTO element_tags (element_key, tag_id) VALUES ('${lamp}', '11111111-1111-4111-8111-111111111111');`);
    legacy.close();

    const store = new TagStore(path);
    try {
      // `RENAME TO` rewrites other tables' REFERENCES clauses unless it is told
      // not to, which would leave every later write failing on `tags_v1`.
      const sql = (new Database(path, { readonly: true, strict: true })
        .query("SELECT sql FROM sqlite_master WHERE name = 'element_tags'").get() as { sql: string }).sql;
      expect(sql).not.toContain("tags_v1");
      // The write that used to fail.
      expect(store.attach(bath, { name: ROOM, value: "Kitchen" })).toHaveLength(1);
      expect(store.tagsFor(lamp)).toHaveLength(1);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  test("a database already broken by the earlier migration is repaired on open", () => {
    const dir = mkdtempSync(join(tmpdir(), "hometruth-tags-broken-"));
    const path = join(dir, "tags.sqlite");
    // Exactly the state the earlier build left behind: migrated to v2, but with
    // element_tags referencing a tags_v1 that no longer exists.
    const broken = new Database(path, { strict: true });
    broken.exec(`PRAGMA user_version = 2;
      CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', value TEXT NOT NULL, color TEXT NOT NULL, description TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, UNIQUE(name, value));
      CREATE TABLE element_tags (element_key TEXT NOT NULL, tag_id TEXT NOT NULL REFERENCES "tags_v1"(id) ON DELETE CASCADE, PRIMARY KEY(element_key, tag_id));
      CREATE TABLE tag_names (name TEXT PRIMARY KEY, label TEXT NOT NULL, cardinality TEXT NOT NULL);
      INSERT INTO tags (id, name, value, color, description) VALUES ('22222222-2222-4222-8222-222222222222', '', 'speakers', '#346b8e', '');
      INSERT INTO element_tags (element_key, tag_id) VALUES ('${lamp}', '22222222-2222-4222-8222-222222222222');`);
    broken.close();

    const store = new TagStore(path);
    try {
      // The rows survive the rebuild, and writes work again.
      expect(store.tagsFor(lamp).map(tag => tag.value)).toEqual(["speakers"]);
      expect(store.attach(bath, { name: ROOM, value: "Master Bathroom" })).toHaveLength(1);
      expect(store.roomOf(bath)).toBe("Master Bathroom");
      // And the cascade is real again, not pointing at a table that is gone.
      const sql = (new Database(path, { readonly: true, strict: true })
        .query("SELECT sql FROM sqlite_master WHERE name = 'element_tags'").get() as { sql: string }).sql;
      expect(sql).not.toContain("tags_v1");
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
