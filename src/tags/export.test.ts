import { describe, expect, test } from "bun:test";
import { TagStore } from "./store";
import { elementKey } from "./identity";
import { ROOM } from "./model";
import { exportTags, exportTagsYaml, importTags } from "./export";

const lamp = elementKey("device", "lamp");
const bath = elementKey("device", "bath-light");

describe("tag export", () => {
  test("round-trips the ontology into a database that lost everything", () => {
    const original = new TagStore();
    const restored = new TagStore();
    try {
      original.declareName({ name: "floor", label: "Floor", cardinality: "single" });
      original.attach(lamp, { name: ROOM, value: "Master Bathroom" });
      original.attach(bath, { name: ROOM, value: "Master Bathroom" });
      original.attach(lamp, { value: "favourite" });
      original.attach(lamp, { name: "floor", value: "2" });
      const room = original.byPair("Master Bathroom", ROOM)!;

      const result = importTags(restored, exportTags(original));
      expect(result.skipped).toBe(0);
      expect(result.assignments).toBe(4);

      // The identity survives, which is what makes a restore a restore: the
      // assignments in the file point at these ids.
      expect(restored.byPair("Master Bathroom", ROOM)!.id).toBe(room.id);
      expect(restored.roomOf(lamp)).toBe("Master Bathroom");
      expect(restored.roomOf(bath)).toBe("Master Bathroom");
      expect(restored.tagsFor(lamp).map(tag => `${tag.name}=${tag.value}`).sort())
        .toEqual(["=favourite", "floor=2", "room=Master Bathroom"]);
      expect(restored.nameOf("floor")).toEqual({ name: "floor", label: "Floor", cardinality: "single" });
    } finally { original.close(); restored.close(); }
  });

  test("importing twice changes nothing, and never deletes what the file predates", () => {
    const store = new TagStore();
    try {
      store.attach(lamp, { name: ROOM, value: "Kitchen" });
      const snapshot = exportTags(store);
      // Work done after the export was taken.
      store.attach(bath, { value: "newer" });

      importTags(store, snapshot);
      importTags(store, snapshot);
      expect(store.roomOf(lamp)).toBe("Kitchen");
      expect(store.tagsFor(bath).map(tag => tag.value)).toEqual(["newer"]);
      expect(store.listNamed(ROOM)).toHaveLength(1);
    } finally { store.close(); }
  });

  test("writes readable YAML and refuses anything that is not an export", () => {
    const store = new TagStore();
    try {
      store.attach(lamp, { name: ROOM, value: "Master Bathroom" });
      const yaml = exportTagsYaml(store);
      expect(yaml).toContain("version: 1");
      expect(yaml).toContain("Master Bathroom");
      expect(yaml).toContain(lamp);
      for (const bad of [null, 42, "text", {}, { version: 2, tags: [], names: [], assignments: {} }]) {
        expect(() => importTags(store, bad)).toThrow("not a HomeTruth tag export");
      }
    } finally { store.close(); }
  });

  test("skips assignments whose element could never carry a tag", () => {
    const store = new TagStore();
    const source = new TagStore();
    try {
      source.attach(lamp, { value: "keep" });
      const tagId = source.byPair("keep")!.id;
      const doctored = {
        ...exportTags(source),
        assignments: { [lamp]: [tagId], "not-a-key": [tagId], [elementKey("tag", "", "keep")]: [tagId] },
      };
      const result = importTags(store, doctored);
      expect(result.assignments).toBe(1);
      expect(result.skipped).toBe(2);
      expect(store.tagsFor(lamp).map(tag => tag.value)).toEqual(["keep"]);
    } finally { store.close(); source.close(); }
  });
});
