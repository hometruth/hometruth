/**
 * What a token is allowed to do, and to which part of the house.
 *
 * Two independent axes:
 *
 *   permissions — read, write or admin; each level includes the ones below it.
 *   subject     — which devices that access reaches.
 *
 * A subject names a device, an existing group, or criteria written in
 * the syntax the group builder already uses. Criteria resolve through
 * `automaticGroupMembers` — the same code that decides what "All Cameras"
 * means on the Groups page. That equivalence is the point: a grant of
 * `room = Kitchen` keeps meaning the kitchen after a device moves into it,
 * without anyone editing the token.
 */
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { automaticGroupCriteriaSchema, type AutomaticGroupCriteria } from "../schemas";
import type { FromSchema } from "json-schema-to-ts";

/**
 * Access levels, from least to most authority, always within the subject.
 *
 * `read`  state, listings, media and events
 * `write` read plus normal controls: switches, PTZ, treats, IR/RF sends
 * `admin` write plus configuration and meta-actions, including enable/disable
 */
export const PERMISSIONS = ["read", "write", "admin"] as const;
export type Permission = typeof PERMISSIONS[number];

/** Higher levels include lower levels; they never widen a token's subject. */
export function permits(held: readonly Permission[], required: Permission): boolean {
  const requiredLevel = PERMISSIONS.indexOf(required);
  return requiredLevel >= 0 && held.some(permission => PERMISSIONS.indexOf(permission) >= requiredLevel);
}

export const subjectSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    /** Every device, and the site-level routes no group can name. */
    all: { const: true },
    /** One device, across its pages, capabilities and API routes. */
    device: { type: "string", minLength: 1, maxLength: 100 },
    /** A group id as the Groups page lists it, `automatic:cameras` included. */
    group: { type: "string", minLength: 1, maxLength: 100 },
    /** A new group definition, in the group builder's own syntax. */
    criteria: automaticGroupCriteriaSchema,
  },
  // Each branch restates its own property: Ajv's strict mode refuses a
  // `required` naming something the same subschema does not declare. Naming
  // exactly one also makes the branches mutually exclusive, which is the point.
  oneOf: [
    { properties: { all: {} }, required: ["all"] },
    { properties: { device: {} }, required: ["device"] },
    { properties: { group: {} }, required: ["group"] },
    { properties: { criteria: {} }, required: ["criteria"] },
  ],
} as const;
export type TokenSubject = FromSchema<typeof subjectSchema>;

export const tokenCreateSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    /** What this token is for, in the owner's words: "Kindle dashboard", "Matter bridge". */
    name: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" },
    permissions: { type: "array", minItems: 1, uniqueItems: true, items: { enum: PERMISSIONS } },
    subject: subjectSchema,
    /** Absent means it never expires; a dated token is the better habit. */
    expiresAt: { type: "string", format: "date-time" },
  },
  required: ["name", "permissions", "subject"],
} as const;
export type TokenCreate = FromSchema<typeof tokenCreateSchema>;

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
export const validateTokenCreate = ajv.compile<TokenCreate>(tokenCreateSchema);

export class AuthError extends Error {
  constructor(message: string, readonly code: "invalid" | "missing" | "unauthenticated" | "forbidden") {
    super(message);
    this.name = "AuthError";
  }
}

/** One line naming what a subject covers, for the token list and the CLI. */
export function describeSubject(subject: TokenSubject, groupName?: (id: string) => string | undefined): string {
  if ("all" in subject && subject.all) return "every device";
  if ("device" in subject && subject.device) return subject.device;
  if ("group" in subject && subject.group) return groupName?.(subject.group) ?? subject.group;
  const criteria = ("criteria" in subject ? subject.criteria : undefined) as AutomaticGroupCriteria | undefined;
  if (!criteria) return "nothing";
  const parts: string[] = [];
  if (criteria.room) parts.push(`room ${criteria.room}`);
  if (criteria.schemaId) parts.push(criteria.schemaId.split("/").pop() ?? criteria.schemaId);
  if (criteria.tagIds?.length) parts.push(`${criteria.tagIds.length} tag${criteria.tagIds.length === 1 ? "" : "s"}`);
  return parts.join(" · ") || "nothing";
}
