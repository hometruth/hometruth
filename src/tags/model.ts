/**
 * The tag ontology: every tag is a name and a value.
 *
 * A plain `#tag` is the special case where the name is null — written here as
 * the empty string, because SQLite treats `NULL` as distinct in a `UNIQUE`
 * constraint and the pair has to stay enforceable. A room is the tag
 * `room = Master Bathroom`. Floors, zones and circuits are the same shape with
 * a different name, so they are data rather than new code.
 *
 * Uniqueness is on the pair: `room = Attic` and `#attic` are different tags and
 * both may exist.
 */
import type { FromSchema } from "json-schema-to-ts";
import { nameSlug } from "../page-urls";

/**
 * A tag name is an identifier — it appears in URLs unescaped and is compared
 * exactly — so it keeps the strict charset plain tags have always had. The
 * empty string is the unnamed root, which is why `minLength` is 0 here.
 */
export const TAG_NAME_PATTERN = "^$|^[A-Za-z0-9-]+$";
/**
 * A value is a display string: `Master Bathroom` has a space in it, and a room
 * that cannot be called what people call it is not worth the merge. Control
 * characters are excluded so a value cannot break a line of output; the URL
 * form comes from `nameSlug`, never from the raw value.
 */
export const TAG_VALUE_PATTERN = "^[^\\p{C}]+$";

export const tagFields = {
  name: { type: "string", maxLength: 200, pattern: TAG_NAME_PATTERN },
  value: { type: "string", minLength: 1, maxLength: 200, pattern: TAG_VALUE_PATTERN },
  color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
  description: { type: "string", maxLength: 4000 },
} as const;

export const tagSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://hometruth.ai/schemas/tag", title: "Tag",
  type: "object", additionalProperties: false,
  properties: { id: { type: "string", format: "uuid" }, ...tagFields, revision: { type: "integer", minimum: 1 } },
  required: ["id", "name", "value", "color", "description", "revision"],
} as const;
export type Tag = FromSchema<typeof tagSchema>;
/**
 * What a caller supplies. `name` is optional and defaults to the unnamed root,
 * so a plain tag is still `{ value, color, description }` and every existing
 * caller reads the way it always did.
 */
export type TagFields = Pick<Tag, "value" | "color" | "description"> & { name?: string };

/**
 * A tag name's own record. Cardinality is a property of the *name*, and it is
 * what makes a room behave the way people expect: an element has at most one
 * `room`, so attaching a second replaces the first. Plain tags (the unnamed
 * root) are always multi-valued.
 */
export const tagNameFields = {
  name: tagFields.name,
  label: { type: "string", minLength: 1, maxLength: 200 },
  cardinality: { type: "string", enum: ["single", "multi"] },
} as const;
export const tagNameSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://hometruth.ai/schemas/tag-name", title: "Tag name",
  type: "object", additionalProperties: false,
  properties: tagNameFields,
  required: ["name", "label", "cardinality"],
} as const;
export type TagName = FromSchema<typeof tagNameSchema>;

/** The unnamed root every plain `#tag` hangs off. */
export const UNNAMED = "";
/** The name rooms are stored under, and the one name HomeTruth ships knowing. */
export const ROOM = "room";
/** Names that exist before anyone declares one, and their cardinality. */
export const BUILTIN_TAG_NAMES: readonly TagName[] = [
  { name: ROOM, label: "Room", cardinality: "single" },
];

export const tagCreateSchema = {
  type: "object", additionalProperties: false, properties: tagFields, required: ["value", "color", "description"],
} as const;
export const tagUpdateSchema = {
  type: "object", additionalProperties: false,
  properties: { ...tagFields, revision: tagSchema.properties.revision },
  required: ["value", "color", "description", "revision"],
} as const;

/**
 * What a caller may point at when attaching. `tagId` is exact; `name`/`value`
 * names the pair and creates it when it is new, which is what the tag editor's
 * type-to-add does.
 */
export const tagAssignmentSchema = {
  type: "object", additionalProperties: false,
  properties: { tagId: tagSchema.properties.id, name: tagFields.name, value: tagFields.value },
  oneOf: [
    { properties: { tagId: {} }, required: ["tagId"] },
    { properties: { name: {}, value: {} }, required: ["value"] },
  ],
} as const;

/** The URL form of a value. Derived, never stored: a rename changes it. */
export const tagSlug = (value: string): string => nameSlug(value);

/**
 * A tag's page. Plain tags keep `/tags/<value>`; a named tag is `/tags/<name>/<value>`,
 * so `room = Master Bathroom` reads `/tags/room/master-bathroom`.
 */
export function tagPage(tag: Pick<Tag, "name" | "value">): string {
  const slug = encodeURIComponent(tagSlug(tag.value));
  return tag.name ? `/tags/${encodeURIComponent(tag.name)}/${slug}` : `/tags/${slug}`;
}

/** How a tag reads in one string: `room = Master Bathroom`, or `kitchen`. */
export function tagLabel(tag: Pick<Tag, "name" | "value">): string {
  return tag.name ? `${tag.name} = ${tag.value}` : tag.value;
}

export const DEFAULT_TAG_COLOR = "#346b8e";
