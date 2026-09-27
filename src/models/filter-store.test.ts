import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilterStore } from "./filter-store";
import { Filter, FilterValidationError } from "./filter";
import { eventSelectionCondition, readEventSelection } from "./event-selection";

const condition = eventSelectionCondition({ subjects: ["camera-4", "camera-5"], type: "", labels: ["person"], other: [
  { timeWindow: { start: "09:00", end: "12:00", timeZone: "UTC" } },
] });

test("saved Filters survive reopening and stale edits cannot overwrite or delete them", () => {
  const directory = mkdtempSync(join(tmpdir(), "hometruth-filters-"));
  let store = new FilterStore(join(directory, "filters.sqlite"));
  try {
    const saved = store.create({ name: "  Morning people  ", condition });
    expect(saved.filter.name).toBe("Morning people");
    const document = new Filter(saved.filter).describe();
    store.close(); store = new FilterStore(join(directory, "filters.sqlite"));
    expect(store.list()).toEqual([{ filter: document, revision: 1, slug: "morning-people" }]);
    const updated = store.update(document.id, { name: "Morning visitors", condition, revision: 1 });
    expect(updated.revision).toBe(2);
    expect(() => store.update(document.id, { name: "Stale", condition, revision: 1 })).toThrow("changed elsewhere");
    expect(() => store.delete(document.id, 1)).toThrow("changed elsewhere");
    expect(store.get(document.id)).toEqual(updated);
    store.delete(document.id, 2);
    expect(store.list()).toEqual([]);
    expect(() => store.get(document.id)).toThrow("not found");
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("invalid Filters never enter the registry and identity cannot be reassigned", () => {
  const store = new FilterStore();
  try {
    for (const input of [null, {}, { name: " ", condition }, { name: "x", condition: { unknown: true } },
      { id: "injected", name: "x", condition }, { name: "x", condition: { timeWindow: { start: "09:00", end: "12:00", timeZone: "Invalid/Zone" } } }]) {
      expect(() => store.create(input)).toThrow(FilterValidationError);
    }
    expect(store.list()).toEqual([]);
  } finally { store.close(); }
});

test("page slugs follow current names, normalize text and disambiguate collisions without ID aliases", () => {
  const store = new FilterStore();
  try {
    const first = store.create({ name: "  Café visitors!  ", condition });
    expect(first.slug).toBe("cafe-visitors");
    expect(store.getBySlug(first.slug)).toEqual(first);
    expect(() => store.getBySlug(first.filter.id)).toThrow("not found");
    const second = store.create({ name: "Cafe visitors", condition });
    const a = store.get(first.filter.id), b = store.get(second.filter.id);
    expect(a.slug).toMatch(/^cafe-visitors-[a-f0-9]{8}$/);
    expect(b.slug).toMatch(/^cafe-visitors-[a-f0-9]{8}$/);
    expect(a.slug).not.toBe(b.slug);
    expect(() => store.getBySlug(first.slug)).toThrow("not found");
    expect(store.getBySlug(a.slug).filter.id).toBe(first.filter.id);
    const renamed = store.update(first.filter.id, { name: "夜間", condition, revision: 1 });
    expect(renamed.slug).toBe("夜間");
    expect(renamed.filter.id).toBe(first.filter.id);
    expect(() => store.getBySlug(a.slug)).toThrow("not found");
    expect(store.getBySlug("cafe-visitors").filter.id).toBe(second.filter.id);
  } finally { store.close(); }
});

test("editing selections preserves additional predicates, including nested groups", () => {
  const before = structuredClone(condition);
  const selected = readEventSelection(condition);
  expect(eventSelectionCondition(selected)).toEqual(condition);
  expect(selected.subjects).toEqual(["camera-4", "camera-5"]);
  const next = eventSelectionCondition({ ...selected, subjects: ["camera-6"], labels: ["dog"] });
  expect(readEventSelection(next).other).toEqual(selected.other);
  expect(readEventSelection(next).timeWindow).toEqual({ start: "09:00", end: "12:00", timeZone: "UTC" });
  expect(condition).toEqual(before);
  const nested = { any: [condition, { path: "/level", op: "eq", value: "error" }] } as const;
  expect(eventSelectionCondition(readEventSelection(nested))).toEqual({ all: [nested] });
  expect(readEventSelection({ path: "/subject", op: "eq", value: "camera-4" }).subjects).toEqual(["camera-4"]);
  expect(eventSelectionCondition({ subjects: [], type: "", labels: [], other: [] })).toEqual({ all: [] });
});
