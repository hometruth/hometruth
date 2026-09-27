/**
 * The state hub as a service.
 *
 * It already matched this repository's own definition of one — "a shared,
 * site-wide backing thing running inside this process, not tied to one device,
 * that devices depend on … enumerable, inspectable, and it keeps its own event
 * log so 'what just happened' is visible without reading server console
 * output" — and "what just happened" is exactly the question you ask of the
 * thing that decides when every device is read. It simply was not one, so it
 * had no page, no status, no log, and no place in the graph.
 *
 * Being a service is also what lets a node say what maintains it. Every
 * observable node gets a `sourcedBy` edge to this service, labelled `push` when
 * the device reports its own changes and `poll` when the hub has to ask.
 */
import { Service, type ServiceStatus } from "../models/service";
import { EventLog, type EventFilter, type ServiceEvent, type ServiceEventListener } from "../models/event-log";
import { parseNode, type NodeId, type Tier } from "./protocol";
import type { StateHub } from "./hub";

declare module "../models/device" {
  interface SiteServices {
    /** The hub that observes every node; present so it is enumerable like any other service. */
    stateHub?: StateHubService;
  }
}

export const STATE_HUB_SERVICE_ID = "state-hub";

export class StateHubService extends Service {
  readonly #log: EventLog;

  constructor(private readonly hub: StateHub, now: () => Date = () => new Date()) {
    super(STATE_HUB_SERVICE_ID, "State hub");
    this.#log = new EventLog(200, now);
  }

  status(): ServiceStatus {
    const watching = this.hub.observer.watching();
    const streams = this.hub.streams.count;
    return {
      availability: "online",
      detail: `Generation ${this.hub.generation}, ${streams} ${streams === 1 ? "stream" : "streams"} open, watching ${watching.length} ${watching.length === 1 ? "node" : "nodes"}`,
    };
  }

  /** Every device currently being observed, which is what the log can be filtered by. */
  override subjects(): readonly string[] {
    const ids = new Set<string>();
    for (const node of this.hub.observer.watching()) {
      const parsed = parseNode(node);
      if (parsed?.kind === "device") ids.add(parsed.id);
    }
    return [...ids].sort();
  }

  events(limit?: number, filter?: EventFilter): readonly ServiceEvent[] {
    return this.#log.recent(limit, filter ?? {});
  }

  subscribe(listener: ServiceEventListener, filter?: EventFilter): () => void {
    return this.#log.subscribe(listener, filter ?? {});
  }

  bound(options: { readonly devices: number; readonly pushSources: number }): void {
    this.#log.record("state_binding", `Watching ${options.devices} devices, ${options.pushSources} of them reporting their own changes`, {
      data: { generation: this.hub.generation, devices: options.devices, pushSources: options.pushSources },
    });
  }

  streamOpened(nodes: number, tier: Tier): void {
    this.#log.record("state_stream", `A page opened a ${tier} stream for ${nodes} ${nodes === 1 ? "node" : "nodes"}`, {
      data: { action: "opened", nodes, tier, open: this.hub.streams.count },
    });
  }

  streamRefused(): void {
    this.#log.record("state_stream", "A stream was refused: this worker is at its limit", {
      level: "warn",
      data: { action: "refused", open: this.hub.streams.count },
    });
  }
}

/** Nodes this hub is observing right now, for the graph's `sourcedBy` edges. */
export type WatchedNodes = readonly NodeId[];
