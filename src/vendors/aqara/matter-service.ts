/**
 * The site-wide Matter connection as a HomeTruth `Service`: one continuous
 * subscription per configured peer, opened the moment the live server
 * starts — not the first time a device happens to be read — and held open
 * for the process's life. `application.ts` builds exactly one of these for
 * the live site (never for the short-lived preview site that precedes it
 * across a restart), scanning `devicesConfig` for every `aqara-hub-m2`
 * entry's `matterPeerId` before any device is constructed.
 *
 * A device (`AqaraHubM2`, and anything reading through its hub) never opens
 * its own Matter connection: it asks this service for a read-only view of
 * its peer's state via `connectionFor()`. Two Matter controllers cannot hold
 * the same peer's paired storage directory open at once (the SDK locks it
 * exclusively), so there is exactly one `AqaraMatterConnection` per peer,
 * owned here.
 */
import { Availability, combinedAvailability } from "../../models/capability";
import { EventLog, type EventFilter, type ServiceEvent, type ServiceEventListener } from "../../models/event-log";
import { Service, type ServiceStatus } from "../../models/service";
import type { AqaraSource, ConnectionState } from "./connection";
import { AqaraMatterConnection } from "./matter";

export type SubscribeMatter = NonNullable<ConstructorParameters<typeof AqaraMatterConnection>[1]>;

export class MatterService extends Service {
  private readonly log = new EventLog(200);
  private readonly connections = new Map<string, AqaraMatterConnection>();
  private readonly latest = new Map<string, Availability>();
  private readonly releases: (() => void)[] = [];
  private stopped = false;

  /**
   * Opens one subscription per peer immediately: this constructor running is
   * what "connected to Matter at startup" means. `onChange` fires with the
   * peer id and its new state on every report, so the caller (which knows
   * how HomeTruth device ids map onto a peer, something this service does
   * not) can push a fresh read into the state graph.
   */
  constructor(peerIds: readonly string[], onChange: (peerId: string, state: ConnectionState) => void, subscribeDevice?: SubscribeMatter) {
    super("matter", "Matter connection");
    for (const peerId of [...new Set(peerIds)]) {
      const connection = subscribeDevice ? new AqaraMatterConnection(peerId, subscribeDevice) : new AqaraMatterConnection(peerId);
      this.connections.set(peerId, connection);
      this.latest.set(peerId, "unknown");
      this.releases.push(connection.subscribe(state => {
        this.latest.set(peerId, state.availability);
        if (state.availability === "online") this.log.record("matter_state_changed", `${peerId} reported a state change`, { subject: peerId, data: { source: "matter" } });
        else this.log.record("matter_connection_degraded", `${peerId}: ${state.detail}`, { subject: peerId });
        onChange(peerId, state);
      }));
    }
  }

  /** A read-only view of one peer's connection, or `undefined` for a peer this service was never given. */
  connectionFor(peerId: string): AqaraSource | undefined {
    return this.connections.get(peerId);
  }

  override status(): ServiceStatus {
    if (this.stopped) return { availability: "offline", detail: "Stopped" };
    if (!this.connections.size) return { availability: "unknown", detail: "No Matter peers configured" };
    const availability = combinedAvailability([...this.latest.values()]);
    return { availability, detail: `${this.connections.size} Matter peer${this.connections.size === 1 ? "" : "s"} configured` };
  }

  override events(limit?: number, filter?: EventFilter): readonly ServiceEvent[] {
    return this.log.recent(limit, filter);
  }

  override subjects(): readonly string[] {
    return [...this.connections.keys()];
  }

  override subscribe(listener: ServiceEventListener, filter?: EventFilter): () => void {
    return this.log.subscribe(listener, filter);
  }

  override async stop(): Promise<void> {
    this.stopped = true;
    for (const release of this.releases) release();
    for (const connection of this.connections.values()) connection.stop();
    this.connections.clear();
  }
}
