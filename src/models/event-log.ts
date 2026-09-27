/**
 * A bounded in-memory ring buffer of structured events for one service.
 * Events name a catalogued type, an optional device subject and schema-checked
 * data. Messages provide display text; structured data supports filtering.
 * This buffer does not persist across restarts. Services that retain history
 * use explicit stores independently of this class.
 */
import type { Event } from "./event-schema";
import { eventType } from "./event-types";
import { describeValidationErrors, eventDataErrors, validateEventData, validators } from "../validation";
import { compileFilterCondition, type FilterCondition, type EventPredicate } from "./filter";

export type ServiceEventLevel = "info" | "warn" | "error";

export type EventData = Readonly<Record<string, unknown>>;

export type ServiceEvent = Readonly<Event>;

export interface RecordEventOptions {
  readonly level?: ServiceEventLevel;
  readonly subject?: string;
  readonly data?: EventData;
}

export type ServiceEventListener = (event: ServiceEvent) => void;

/** Which events to return or stream. An absent field means "no restriction". */
export interface EventFilter {
  /** A reusable Filter's condition, applied before limits and equally to live events. */
  readonly where?: FilterCondition;
  /** Any of these detection labels; an empty selection includes every label. */
  readonly labels?: readonly string[];
  /** Inclusive upper time bound used while browsing older label events. */
  readonly atOrBefore?: string;
  /** Only events about this device. */
  readonly subject?: string;
  /** Only events of these types. */
  readonly types?: readonly string[];
  readonly level?: ServiceEventLevel;
}

export function matchesFilter(event: ServiceEvent, filter: EventFilter): boolean {
  return compileEventFilter(filter)(event);
}

export function compileEventFilter(filter: EventFilter): EventPredicate {
  const conditions: FilterCondition[] = [];
  if (filter.where) conditions.push(filter.where);
  if (filter.labels?.length) conditions.push({ detectionLabels: filter.labels });
  if (filter.subject !== undefined) conditions.push({ path: "/subject", op: "eq", value: filter.subject });
  if (filter.types?.length) conditions.push({ path: "/type", op: "in", value: filter.types });
  if (filter.level !== undefined) conditions.push({ path: "/level", op: "eq", value: filter.level });
  const predicates = conditions.map(compileFilterCondition);
  return event => (filter.atOrBefore === undefined || event.at <= filter.atOrBefore) && predicates.every(matches => matches(event));
}

/** Keeps the most recent `capacity` events; older ones are dropped, oldest first. */
export class EventLog {
  private readonly events: ServiceEvent[] = [];
  private readonly listeners = new Set<ServiceEventListener>();

  constructor(private readonly capacity = 200, private readonly now: () => Date = () => new Date()) {}

  /**
   * Record one event. The type must be in the catalog and `data` must match
   * its schema: a service that records something unknown or malformed is a
   * bug at the emitter, and failing here is how it gets noticed.
   */
  record(type: string, message: string, options: RecordEventOptions = {}): ServiceEvent {
    const definition = eventType(type);
    if (!definition) {
      throw new Error(`Unknown event type "${type}"; add it to src/models/event-types.ts before recording it`);
    }
    if (!validateEventData(definition.id, options.data === undefined ? {} : options.data)) {
      throw new Error(`Invalid data for a "${type}" event: ${eventDataErrors(definition.id)}`);
    }
    const event: ServiceEvent = {
      at: this.now().toISOString(),
      level: options.level ?? definition.level,
      type,
      message,
      ...(options.subject ? { subject: options.subject } : {}),
      ...(options.data ? { data: options.data } : {}),
    };
    if (!validators.event(event)) throw new Error(`Invalid event: ${describeValidationErrors(validators.event.errors)}`);
    this.events.push(event);
    if (this.events.length > this.capacity) this.events.shift();
    for (const listener of this.listeners) listener(event);
    return event;
  }

  /** Newest first, at most `limit` (default: all kept), narrowed by `filter`. */
  recent(limit?: number, filter: EventFilter = {}): readonly ServiceEvent[] {
    const ordered = [...this.events].reverse().filter(compileEventFilter(filter));
    return limit === undefined ? ordered : ordered.slice(0, limit);
  }

  /** Every device any kept event is about, in first-seen order; the "filter by camera" menu. */
  subjects(): readonly string[] {
    const seen = new Set<string>();
    for (const event of this.events) if (event.subject) seen.add(event.subject);
    return [...seen];
  }

  /** Every event type present among the kept events, in catalog-independent first-seen order. */
  types(): readonly string[] {
    const seen = new Set<string>();
    for (const event of this.events) seen.add(event.type);
    return [...seen];
  }

  /** Calls `listener` with each event as it is recorded, from now on. Returns a function that stops it. */
  subscribe(listener: ServiceEventListener, filter: EventFilter = {}): () => void {
    const matches = compileEventFilter(filter);
    const wrapped: ServiceEventListener = (event) => {
      if (matches(event)) listener(event);
    };
    this.listeners.add(wrapped);
    return () => { this.listeners.delete(wrapped); };
  }

  clear(): void {
    this.events.length = 0;
  }
}
