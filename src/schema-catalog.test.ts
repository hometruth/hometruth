import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { schemaCatalogEntries, buildSchemaCatalogResponse } from "./schema-catalog";
import * as schemaExports from "./schemas";
import * as stateSchemaExports from "./state/schemas";
import * as graphSchemaExports from "./graph/schemas";
import { validators } from "./validation";
import { EVENT_TYPES } from "./models/event-types";

function exportedSchemaIds(): string[] {
  return ([...Object.values(schemaExports), ...Object.values(stateSchemaExports), ...Object.values(graphSchemaExports)] as unknown[])
    .filter((value): value is { $id: string } => (
      typeof value === "object" && value !== null && "$id" in value && typeof value.$id === "string"
    ))
    .map((schema) => schema.$id)
    .sort();
}

describe("schema catalog", () => {
  test("inventories every exported JSON Schema exactly once", () => {
    const catalogIds: string[] = schemaCatalogEntries.map((entry) => entry.schema.$id).sort();
    expect(new Set(catalogIds).size).toBe(catalogIds.length);
    expect(catalogIds).toEqual([...exportedSchemaIds(), ...EVENT_TYPES.map(event => event.payloadSchema.$id)].sort());
  });

  test("keeps business models first-class and returns a valid response", () => {
    const response: unknown = buildSchemaCatalogResponse();
    expect(validators.schemaCatalogResponse(response)).toBe(true);
    expect(schemaCatalogEntries.filter((entry) => entry.category === "business").length).toBeGreaterThan(0);
    expect(schemaCatalogEntries.every((entry) => entry.typeName.length > 0)).toBe(true);
  });

  test("loads the serialized catalog as one JSON Schema registry", () => {
    const registry = new Ajv2020({ allErrors: true, strict: true });
    addFormats(registry);

    for (const entry of schemaCatalogEntries) registry.addSchema(entry.schema);
    for (const entry of schemaCatalogEntries) {
      expect(registry.getSchema(entry.schema.$id), entry.schema.$id).toBeDefined();
    }
  });
});
