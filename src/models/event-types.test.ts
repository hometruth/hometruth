import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { EVENT_TYPES, eventType, eventTypeIds } from "./event-types";
import { eventSchema } from "./event-schema";

describe("the event type catalog", () => {
  test("every type has a unique snake_case id and a compilable schema", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    ajv.addSchema(eventSchema);
    const ids = new Set<string>();
    for (const definition of EVENT_TYPES) {
      expect(definition.id).toMatch(/^[a-z][a-z0-9_]*$/u);
      expect(ids.has(definition.id)).toBe(false);
      ids.add(definition.id);
      expect(definition.label.length).toBeGreaterThan(0);
      expect(definition.description.endsWith(".")).toBe(true);
      expect(() => ajv.compile(definition.payloadSchema)).not.toThrow();
    }
    expect(eventTypeIds()).toEqual([...ids]);
  });

  test("looks a type up by id, and does not invent one", () => {
    expect(eventType("motion")?.view).toBe("thumbnail");
    expect(eventType("settings")?.view).toBe("properties");
    expect(eventType("not_a_type")).toBeUndefined();
  });

  test("a thumbnail view declares where its image comes from, so the renderer can rely on it", () => {
    for (const definition of EVENT_TYPES.filter((candidate) => candidate.view === "thumbnail")) {
      expect(Object.keys(definition.payloadSchema.properties ?? {})).toContain("thumbnailUrl");
    }
  });
});
