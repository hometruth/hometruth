import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { MODELS } from "../../src/registry";
import { schemaCatalogEntries } from "../../src/schema-catalog";
import { tagNameSchema } from "../../src/tags/model";
import { SCHEMA_BASE_URL, type PublicSchemaDocument } from "../../src/public-schemas/worker";

/** Build-time only: these imports declare types and models, without provisioning a site. */
export function publicSchemaDocuments(): PublicSchemaDocument[] {
  const documents = new Map<string, PublicSchemaDocument>();
  const declared = [
    ...schemaCatalogEntries.map(entry => entry.schema),
    tagNameSchema,
    ...MODELS.flatMap(model => model.secretsSchema ? [model.configSchema, model.secretsSchema] : [model.configSchema]),
  ];
  for (const schema of declared) {
    const document = { $schema: "https://json-schema.org/draft/2020-12/schema", ...schema };
    const path = document.$id.slice(SCHEMA_BASE_URL.length);
    if (!document.$id.startsWith(SCHEMA_BASE_URL) || !/^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(path)) {
      throw new Error(`Schema must have a canonical public ID: ${document.$id}`);
    }
    const prior = documents.get(document.$id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(document)) {
      throw new Error(`Conflicting schema definitions: ${document.$id}`);
    }
    documents.set(document.$id, document);
  }
  const result = [...documents.values()].sort((a, b) => a.$id.localeCompare(b.$id));
  // Compile the serialized documents together: unresolved references or invalid
  // schemas must fail the build before anything can be published.
  const registry = new Ajv2020({ strict: true, allErrors: true });
  addFormats(registry);
  for (const document of documents.values()) registry.addSchema(JSON.parse(JSON.stringify(document)));
  for (const document of result) registry.getSchema(document.$id);
  return result;
}
