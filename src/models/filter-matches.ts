import { EventLog, type EventFilter, type ServiceEvent, type ServiceEventListener } from "./event-log";
import { Filter } from "./filter";
import type { FilterStore } from "./filter-store";
import { Service } from "./service";

declare module "./device" {
  interface SiteServices { filterMatches?: FilterMatches }
}

/** Live evaluation is separate from the pure Filter predicate and from history reads. */
export class FilterMatches extends Service {
  private readonly log: EventLog;
  private generation = -1;
  private compiled: { filter: Filter; revision: number }[] = [];
  private readonly seen = new WeakSet<ServiceEvent>();
  // Photo outbox retries recreate the envelope but retain the label result's stable event ID.
  private readonly photoEvents = new Set<string>();
  private readonly unsubscribers: (() => void)[] = [];
  private readonly sources = new Set<Pick<Service, "subscribe">>();
  private stopped = false;

  constructor(private readonly store: FilterStore, now: () => Date = () => new Date()) {
    super("filter-matches", "Filter matches");
    this.log = new EventLog(1000, now);
  }

  private filters() {
    if (this.generation !== this.store.generation) {
      this.compiled = this.store.list().map(record => ({ filter: new Filter(record.filter), revision: record.revision }));
      this.generation = this.store.generation;
    }
    return this.compiled;
  }

  /** Attach only authoritative live sources, never broker mirrors or historical snapshots. */
  connect(sources: readonly Pick<Service, "subscribe">[]): void {
    if (this.stopped) return;
    for (const source of sources) {
      if (source === this || this.sources.has(source)) continue;
      this.sources.add(source);
      this.unsubscribers.push(source.subscribe(this.accept));
    }
  }

  readonly accept = (event: ServiceEvent): void => {
    if (this.stopped || event.type === "filter_matched" || this.seen.has(event)) return;
    const photoId = event.type === "photo_labeled" && typeof event.data?.eventId === "string"
      ? JSON.stringify([event.subject, event.data.eventId]) : undefined;
    if (photoId && this.photoEvents.has(photoId)) return;
    const filters = this.filters();
    this.seen.add(event);
    if (photoId) {
      this.photoEvents.add(photoId);
      if (this.photoEvents.size > 10_000) this.photoEvents.delete(this.photoEvents.values().next().value!);
    }
    // Snapshot before notifying listeners, which may edit a Filter or publish another event.
    const matches = filters.filter(({ filter }) => filter.matches(event));
    const original = structuredClone(event);
    for (const { filter, revision } of matches) {
      this.log.record("filter_matched", `Filter “${filter.name}” matched: ${original.message}`.slice(0, 1000), {
        ...(original.subject ? { subject: original.subject } : {}),
        data: { filterId: filter.id, filterName: filter.name, filterRevision: revision, event: structuredClone(original) },
      });
    }
  };

  override status() {
    return { availability: this.stopped ? "offline" as const : "online" as const,
      detail: this.stopped ? "Stopped" : `Evaluating ${this.filters().length} saved filters on new events` };
  }
  override events(limit?: number, filter?: EventFilter) { return this.log.recent(limit, filter); }
  override subjects() { return this.log.subjects(); }
  override subscribe(listener: ServiceEventListener, filter?: EventFilter) { return this.log.subscribe(listener, filter); }
  override async stop(): Promise<void> {
    this.stopped = true;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.sources.clear();
    this.photoEvents.clear();
  }
}
