import type { ServiceEvent } from "./models/event-log";

/** One HTTP generation's event forwarding; retire it before closing its broker. */
export class EventBusForwarder {
  private stopped = false;
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly broker: { publishEvent(event: ServiceEvent): Promise<void> } | undefined,
    private readonly onError: (error: unknown, event: ServiceEvent) => void,
  ) {}

  readonly publish = (event: ServiceEvent): void => {
    const broker = this.broker;
    if (this.stopped || !broker) return;
    const publication = Promise.resolve()
      .then(() => broker.publishEvent(event))
      .catch((error: unknown) => this.onError(error, event))
      .finally(() => this.pending.delete(publication));
    this.pending.add(publication);
  };

  async stop(): Promise<void> {
    // Old HTTP requests may finish even after a hot reload closes their broker.
    // Keep their local logs, but do not send new events to the retired broker.
    this.stopped = true;
    await Promise.all(this.pending);
  }
}
