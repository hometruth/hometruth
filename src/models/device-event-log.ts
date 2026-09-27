/**
 * Per-device, in-memory events emitted by HomeTruth itself. Vendor/service
 * events stay in their owning service logs and are merged at read/stream time.
 */
import { compileEventFilter, EventLog, type EventFilter, type RecordEventOptions, type ServiceEvent, type ServiceEventListener } from "./event-log";

export type DeviceEventPublisher = (event: ServiceEvent) => void;

export class DeviceEventLogs {
  private readonly listeners = new Set<ServiceEventListener>();
  private readonly logs = new Map<string, EventLog>();

  constructor(
    private readonly capacity = 200,
    private readonly now: () => Date = () => new Date(),
    private readonly publish?: DeviceEventPublisher,
  ) {}

  private log(deviceId: string): EventLog {
    let log = this.logs.get(deviceId);
    if (!log) {
      log = new EventLog(this.capacity, this.now);
      this.logs.set(deviceId, log);
    }
    return log;
  }

  record(deviceId: string, type: string, message: string, options: Omit<RecordEventOptions, "subject"> = {}): ServiceEvent {
    const event = this.log(deviceId).record(type, message, { ...options, subject: deviceId });
    this.publish?.(event);
    for (const listener of this.listeners) listener(event);
    return event;
  }

  recent(deviceId: string, limit?: number, filter: EventFilter = {}): readonly ServiceEvent[] {
    return this.logs.get(deviceId)?.recent(limit, { ...filter, subject: deviceId }) ?? [];
  }

  /** Every device's events, newest first. */
  recentAll(limit?: number, filter: EventFilter = {}): readonly ServiceEvent[] {
    const events = [...this.logs.values()].flatMap(log => log.recent(undefined, filter)).sort((a, b) => b.at.localeCompare(a.at));
    return limit === undefined ? events : events.slice(0, limit);
  }

  subscribeAll(listener: ServiceEventListener, filter: EventFilter = {}): () => void {
    const matches = compileEventFilter(filter);
    const filtered: ServiceEventListener = event => { if (matches(event)) listener(event); };
    this.listeners.add(filtered);
    return () => { this.listeners.delete(filtered); };
  }

  subscribe(deviceId: string, listener: ServiceEventListener, filter: EventFilter = {}): () => void {
    return this.log(deviceId).subscribe(listener, { ...filter, subject: deviceId });
  }
}
