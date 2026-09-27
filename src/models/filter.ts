import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { Event } from "./event-schema";
import { detectionLabel, detectionLabels } from "./detection-labels";
import { filterConditionSchema, filterSchema, type FilterCondition, type FilterDocument } from "./filter-schema";

export type { FilterCondition, FilterDocument } from "./filter-schema";
export class FilterValidationError extends Error {}
export type EventPredicate = (event: Event) => boolean;

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const validateCondition = ajv.compile<FilterCondition>(filterConditionSchema);
const validateDocument = ajv.compile<FilterDocument>(filterSchema);
const validateTimestamp = ajv.compile({ type: "string", format: "date-time" });

/** Bound recursion before handing a condition to the recursive schema validator. */
function checkSize(input: unknown): void {
  let count = 0;
  const ancestors = new Set<object>();
  const visit = (value: unknown, depth: number): void => {
    if (++count > 256 || depth > 16) throw new FilterValidationError("A Filter may contain at most 256 conditions and 16 levels");
    if (!value || typeof value !== "object") return;
    if (ancestors.has(value)) throw new FilterValidationError("A Filter cannot contain cycles");
    ancestors.add(value);
    const record = value as Record<string, unknown>;
    for (const key of ["all", "any"]) if (Array.isArray(record[key])) for (const child of record[key]) visit(child, depth + 1);
    if (Object.hasOwn(record, "not")) visit(record.not, depth + 1);
    ancestors.delete(value);
  };
  visit(input, 1);
}

/** JSON Pointer lookup uses own properties only; a missing value is distinct from null. */
function reader(path: string): (event: Event) => unknown {
  const parts = path.slice(1).split("/").map(part => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  return event => {
    let value: unknown = event;
    for (const part of parts) {
      if (value === null || typeof value !== "object" || !Object.hasOwn(value, part)) return undefined;
      if (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(part)) return undefined;
      value = (value as Record<string, unknown>)[part];
    }
    return value;
  };
}

function compile(condition: FilterCondition): EventPredicate {
  if ("all" in condition) { const predicates = condition.all.map(compile); return event => predicates.every(test => test(event)); }
  if ("any" in condition) { const predicates = condition.any.map(compile); return event => predicates.some(test => test(event)); }
  if ("not" in condition) { const test = compile(condition.not); return event => !test(event); }
  if ("detectionLabels" in condition) {
    const selected = new Set(condition.detectionLabels.map(label => detectionLabel(label)));
    if (selected.has(undefined)) throw new FilterValidationError("Detection labels must not be blank");
    return event => detectionLabels(event.data).some(label => selected.has(label));
  }
  if ("timeWindow" in condition) {
    const { start, end, timeZone, timestamp } = condition.timeWindow;
    if (start === end) throw new FilterValidationError("A time window must have different start and end times");
    // Intl also accepts fixed-offset zones on some runtimes; the contract requires a named zone.
    if (/^[+-]/.test(timeZone)) throw new FilterValidationError("A time window requires an IANA time zone");
    let formatter: Intl.DateTimeFormat;
    try { formatter = new Intl.DateTimeFormat("en-GB", { timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }); }
    catch { throw new FilterValidationError(`Unknown time zone: ${timeZone}`); }
    const read = reader(timestamp?.path ?? "/at");
    const format = timestamp?.format ?? "dateTime";
    return event => {
      const value = read(event);
      const milliseconds = format === "dateTime"
        ? typeof value === "string" && validateTimestamp(value) ? Date.parse(value) : NaN
        : typeof value === "number" ? value * (format === "unixSeconds" ? 1000 : 1) : NaN;
      const date = new Date(milliseconds);
      if (!Number.isFinite(date.getTime())) return false;
      const parts = formatter.formatToParts(date);
      const local = `${parts.find(part => part.type === "hour")!.value}:${parts.find(part => part.type === "minute")!.value}`;
      return start < end ? local >= start && local < end : local >= start || local < end;
    };
  }
  const read = reader(condition.path);
  return event => {
    const actual = read(event);
    if (condition.op === "exists") return (actual !== undefined) === condition.value;
    if (actual === undefined) return false;
    switch (condition.op) {
      case "eq": return actual === condition.value;
      case "ne": return (actual === null || ["string", "number", "boolean"].includes(typeof actual)) && actual !== condition.value;
      case "in": return condition.value.some(value => actual === value);
      case "contains": return Array.isArray(actual) && actual.some(value => value === condition.value);
      case "gt": return typeof actual === "number" && Number.isFinite(actual) && actual > condition.value;
      case "gte": return typeof actual === "number" && Number.isFinite(actual) && actual >= condition.value;
      case "lt": return typeof actual === "number" && Number.isFinite(actual) && actual < condition.value;
      case "lte": return typeof actual === "number" && Number.isFinite(actual) && actual <= condition.value;
    }
  };
}

/** Validate once, then reuse an immutable predicate for history and live events. */
export function compileFilterCondition(input: unknown): EventPredicate {
  checkSize(input);
  if (!validateCondition(input)) throw new FilterValidationError(`Invalid Filter condition: ${ajv.errorsText(validateCondition.errors)}`);
  return compile(structuredClone(input));
}

export class Filter {
  readonly schemaId = filterSchema.$id;
  private readonly document: FilterDocument;
  readonly matches: EventPredicate;

  constructor(input: unknown) {
    checkSize(input && typeof input === "object" ? (input as Record<string, unknown>).condition : undefined);
    if (!validateDocument(input)) throw new FilterValidationError(`Invalid Filter: ${ajv.errorsText(validateDocument.errors)}`);
    this.matches = compileFilterCondition(input.condition);
    this.document = structuredClone(input);
  }

  get id(): string { return this.document.id; }
  get name(): string { return this.document.name; }
  describe(): FilterDocument { return structuredClone(this.document); }
  /** Preserves input order and event identity; filtering never changes an event. */
  select<T extends Event>(events: readonly T[]): T[] { return events.filter(this.matches); }
}
