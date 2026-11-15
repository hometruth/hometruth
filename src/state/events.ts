/** Bounded event histories indexed at refresh/publication, never queried during rendering. */
import type { Service } from "../models/service";
import type { DeviceEventLogs } from "../models/device-event-log";
import type { ServiceEvent } from "../models/event-log";
import type { Site } from "../site";

export class StateEvents {
  readonly #services = new Map<string, readonly ServiceEvent[]>();
  readonly #devices = new Map<string, readonly ServiceEvent[]>();
  readonly #local = new Map<string, readonly ServiceEvent[]>();
  readonly #releases: (() => void)[] = [];
  readonly #listeners = new Set<(event: ServiceEvent, service?: string) => void>();
  constructor(private readonly site: Site, private readonly sources: readonly Service[], private readonly local?: DeviceEventLogs) {
    for (const service of sources) this.#releases.push(service.subscribe(event => {
      this.#services.set(service.id, [event, ...(this.#services.get(service.id) ?? [])].slice(0, 200));
      this.indexDevices();
      for (const listener of this.#listeners) listener(event, service.id);
    }));
    if (local) this.#releases.push(local.subscribeAll(event => {
      if (!event.subject) return;
      this.#local.set(event.subject, [event, ...(this.#local.get(event.subject) ?? [])].slice(0, 200));
      this.indexDevices();
      for (const listener of this.#listeners) listener(event);
    }));
  }
  service(id: string): readonly ServiceEvent[] { return this.#services.get(id) ?? []; }
  device(id: string): readonly ServiceEvent[] { return this.#devices.get(id) ?? []; }
  matching(matches: (event: ServiceEvent, service?: string) => boolean, limit = 200): readonly ServiceEvent[] {
    return [...this.#services].flatMap(([id, events]) => events.filter(event => matches(event, id)))
      .concat([...this.#local.values()].flatMap(events => events.filter(event => matches(event))))
      .sort((a, b) => b.at.localeCompare(a.at)).slice(0, Math.max(1, Math.min(200, limit)));
  }
  subscribe(listener: (event: ServiceEvent, service?: string) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }
  refresh(): void {
    for (const service of this.sources) {
      try { this.#services.set(service.id, service.events(200)); } catch { /* Retain last successful history. */ }
    }
    for (const subject of new Set(this.local?.recentAll().flatMap(event => event.subject ? [event.subject] : []) ?? [])) {
      this.#local.set(subject, this.local!.recent(subject, 200));
    }
    this.indexDevices();
  }
  private indexDevices(): void {
    const rows = new Map<string, ServiceEvent[]>();
    const seen = new Set<string>();
    const add = (event: ServiceEvent) => {
      if (!event.subject) return;
      const key = JSON.stringify([event.subject, event.at, event.type, event.message]);
      if (seen.has(key)) return;
      seen.add(key);
      const list = rows.get(event.subject);
      if (list) list.push(event); else rows.set(event.subject, [event]);
    };
    for (const [id, events] of this.#services) if (id !== "mqtt-broker") for (const event of events) add(event);
    for (const events of this.#local.values()) for (const event of events) add(event);
    this.#devices.clear();
    for (const [id, events] of rows) this.#devices.set(id, events.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 200));
  }
  close(): void { for (const release of this.#releases.splice(0)) release(); this.#listeners.clear(); }
}
