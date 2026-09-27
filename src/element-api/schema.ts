import type { Json, OpenApiDocument } from "../openapi/document";

export type Schema = Record<string, Json>;
export const record = (value: unknown): Schema => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Schema : {};

export function resolveSchema(input: Schema, document: OpenApiDocument, seen = new Set<string>()): Schema {
  const ref = input.$ref;
  if (typeof ref !== "string" || seen.has(ref)) return input;
  const schemas = record(document.components.schemas);
  const target = ref.startsWith("#/components/schemas/") ? schemas[ref.slice(21)]
    : Object.values(schemas).find(value => record(value)["x-hometruth-schema-id"] === ref);
  if (!target) return input;
  const { $ref: _, ...siblings } = input;
  return { ...resolveSchema(record(target), document, new Set([...seen, ref])), ...siblings };
}

export function typeScript(input: Schema, document: OpenApiDocument, seen = new Set<string>(), named = false): string {
  if (named && typeof input.$ref === "string" && input.$ref.startsWith("#/components/schemas/")) return input.$ref.slice(21);
  if (typeof input.$ref === "string" && seen.has(input.$ref)) return "unknown";
  const next = new Set(seen); if (typeof input.$ref === "string") next.add(input.$ref);
  const schema = resolveSchema(input, document);
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum)) return schema.enum.map(value => JSON.stringify(value)).join(" | ") || "never";
  for (const branch of ["oneOf", "anyOf", "allOf"]) {
    if (!Array.isArray(schema[branch])) continue;
    const { [branch]: branches, ...base } = schema;
    const variants = (branches as Json[]).map(value => typeScript(record(value), document, next, named));
    const baseType = typeScript(base, document, next, named);
    const combined = variants.map(value => `(${value})`).join(branch === "allOf" ? " & " : " | ");
    return baseType === "unknown" ? combined : variants.every(value => value === "unknown") ? baseType : `(${baseType}) & (${combined})`;
  }
  if (Array.isArray(schema.type)) return schema.type.map(type => typeScript({ ...schema, type }, document, next, named)).join(" | ");
  if (schema.type === "array") return `Array<${typeScript(record(schema.items), document, next, named)}>`;
  if (schema.type === "object" || schema.properties) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    const fields = Object.entries(record(schema.properties)).map(([key, value]) => `${JSON.stringify(key)}${required.includes(key) ? "" : "?"}: ${typeScript(record(value), document, next, named)}`);
    if (schema.additionalProperties !== false) fields.push(`[key: string]: ${typeScript(record(schema.additionalProperties), document, next, named)}`);
    return `{ ${fields.join("; ")} }`;
  }
  if (schema.type === "integer" || schema.type === "number") return "number";
  if (["string", "boolean", "null"].includes(String(schema.type))) return String(schema.type);
  return "unknown";
}

export interface Property { path: string; type: string; required: boolean; description: string; schema: Schema }
export function properties(input: Schema, document: OpenApiDocument, prefix = "", seen = new Set<string>()): Property[] {
  if (typeof input.$ref === "string" && seen.has(input.$ref)) return [];
  const next = new Set(seen); if (typeof input.$ref === "string") next.add(input.$ref);
  const schema = resolveSchema(input, document);
  const result: Property[] = [];
  for (const branch of ["allOf", "oneOf", "anyOf"]) if (Array.isArray(schema[branch])) {
    for (const value of schema[branch] as Json[]) result.push(...properties(record(value), document, prefix, next));
  }
  for (const [name, value] of Object.entries(record(schema.properties))) {
    const child = resolveSchema(record(value), document);
    const path = prefix ? `${prefix}.${name}` : name;
    result.push({ path, type: child.type === "object" || child.properties ? "object" : child.type === "array" ? "array" : typeScript(record(value), document), required: Array.isArray(schema.required) && schema.required.includes(name), description: typeof child.description === "string" ? child.description : "", schema: child });
    result.push(...properties(record(value), document, path, next));
  }
  if (schema.items) result.push(...properties(record(schema.items), document, `${prefix}[]`, next));
  const merged = new Map<string, Property>();
  for (const property of result) {
    const prior = merged.get(property.path);
    merged.set(property.path, prior ? { ...property, type: [...new Set([prior.type, property.type])].join(" | "), required: prior.required && property.required } : property);
  }
  return [...merged.values()];
}

export function sample(input: Schema, document: OpenApiDocument, seen = new Set<string>()): Json {
  if (typeof input.$ref === "string" && seen.has(input.$ref)) return null;
  const next = new Set(seen); if (typeof input.$ref === "string") next.add(input.$ref);
  const schema = resolveSchema(input, document);
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0]!;
  if (schema.default !== undefined) return schema.default;
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0] ?? null;
  for (const branch of ["oneOf", "anyOf"]) if (Array.isArray(schema[branch])) return sample(record(schema[branch][0]), document, next);
  if (Array.isArray(schema.allOf)) return Object.assign({}, ...schema.allOf.map(value => record(sample(record(value), document, next)))) as Json;
  const type = Array.isArray(schema.type) ? schema.type.find(type => type !== "null") : schema.type;
  if (type === "object" || schema.properties) return Object.fromEntries(Object.entries(record(schema.properties)).filter(([name]) => Array.isArray(schema.required) && schema.required.includes(name)).map(([name, value]) => [name, sample(record(value), document, next)]));
  if (type === "array") return Array.from({ length: Number(schema.minItems ?? 0) }, () => sample(record(schema.items), document, next));
  if (type === "boolean") return false;
  if (type === "number" || type === "integer") return Number(schema.minimum ?? 0);
  if (type === "string") return schema.format === "date-time" ? "2026-01-01T00:00:00Z" : "example";
  return null;
}
