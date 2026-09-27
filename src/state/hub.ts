/**
 * The one object `createApp` and `application.ts` share: the graph, the
 * observer that feeds it, and the open streams that read it. The worker
 * serves the preview app until the live app is ready, so the hub outlives
 * either: a rebind points the observer at the new site, drops every record
 * and closes every stream, and the browsers reconnect within two seconds
 * onto the live app.
 */
import { Graph } from "./graph";
import { Observer, type ObserverBinding, type ObserverTimers } from "./observer";
import { STREAM_LIMITS, type NodeId, type NodeRecord } from "./protocol";
import { Streams } from "./stream";
import { StateData, type StateDataSources } from "./data";
import { automationNode, deviceNode, groupNode } from "./protocol";

export interface StateHubLimits {
  readonly maxStreams: number;
  readonly maxNodes: number;
}

export interface StateHubOptions {
  /** The worker generation a `hello` frame names; `dev` outside the supervisor. */
  readonly generation?: string;
  readonly limits?: StateHubLimits;
  readonly now?: () => Date;
  readonly timers?: ObserverTimers;
  readonly random?: () => number;
}

export class StateHub {
  readonly graph: Graph;
  readonly observer: Observer;
  readonly streams: Streams;
  readonly generation: string;
  readonly limits: StateHubLimits;
  #data: StateData | undefined;
  #releases = new Map<NodeId, () => void>();
  #refreshTimer: ReturnType<typeof setInterval> | undefined;

  get data(): StateData {
    if (!this.#data) throw new Error("State data has not been configured");
    return this.#data;
  }

  configure(sources: StateDataSources): StateData {
    this.#data?.close();
    this.#data = new StateData(sources, this.graph);
    return this.#data;
  }

  /** Keep the whole configured domain warm, independent of which pages are open. */
  observeAll(): void {
    const site = this.data.sources.site;
    const nodes = new Set([
      ...site.devices.filter(device => device.enabled).map(device => deviceNode(device.id)),
      ...site.deviceGroups.filter(group => group.asSwitch).map(group => groupNode(group.id)),
      ...site.services.filter(service => service.switch).map(service => automationNode(service.id)),
    ]);
    for (const [node, release] of this.#releases) if (!nodes.has(node)) { release(); this.#releases.delete(node); this.graph.remove(node); }
    for (const node of nodes) if (!this.#releases.has(node)) this.#releases.set(node, this.observer.retain(node, "glance"));
    this.#refreshTimer ??= setInterval(() => { void this.data.refresh(); }, 30_000);
    this.#refreshTimer.unref();
  }

  constructor(options: StateHubOptions = {}) {
    this.generation = options.generation ?? "dev";
    this.limits = options.limits ?? { maxStreams: STREAM_LIMITS.maxStreams, maxNodes: STREAM_LIMITS.maxNodes };
    this.graph = new Graph({ ...(options.now ? { now: options.now } : {}) });
    this.observer = new Observer(this.graph, {
      ...(options.now ? { now: options.now } : {}),
      ...(options.timers ? { timers: options.timers } : {}),
      ...(options.random ? { random: options.random } : {}),
    });
    this.streams = new Streams(this.limits);
  }

  /** Streams close first so their releases land before the observer forgets the old site. */
  bind(binding: ObserverBinding): void {
    this.streams.closeAll();
    this.observer.bind(binding);
  }

  snapshot(nodes?: readonly NodeId[]): NodeRecord[] {
    return this.graph.snapshot(nodes);
  }

  stop(): void {
    clearInterval(this.#refreshTimer);
    this.#refreshTimer = undefined;
    for (const release of this.#releases.values()) release();
    this.#releases.clear();
    this.#data?.close();
    this.streams.closeAll();
    this.observer.stop();
    this.graph.clear();
  }
}
