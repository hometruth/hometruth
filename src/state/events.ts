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
  constructor(private readonly site: Site, private readonly sources: readonly Service[], private readonly local?: DeviceEventLogs) {
    for (const service of sources) this.#releases.push(service.subscribe(event => {
      this.#services.set(service.id, [event, ...(this.#services.get(service.id) ?? [])].slice(0, 200));
      this.indexDevices();
    }));
    if (local) this.#releases.push(local.subscribeAll(event => {
      if (!event.subject) return;
      this.#local.set(event.subject, [event, ...(this.#local.get(event.subject) ?? [])].slice(0, 200));
      this.indexDevices();
    }));
  }
  service(id: string): readonly ServiceEvent[] { return this.#services.get(id) ?? []; }
  device(id: string): readonly ServiceEvent[] { return this.#devices.get(id) ?? []; }
  refresh(): void {
    for (const service of this.sources) {
      try { this.#services.set(service.id, service.events(200)); } catch { /* Retain last successful history. */ }
    }
    for (const device of this.site.devices) this.#local.set(device.id, this.local?.recent(device.id, 200) ?? []);
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
  close(): void { for (const release of this.#releases.splice(0)) release(); }
}
