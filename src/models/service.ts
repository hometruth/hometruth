/**
 * A service is a shared, site-wide backing thing running inside this
 * process — not tied to one device — that devices depend on: the embedded
 * MQTT broker, in future perhaps a local DNS override or a cloud-emulator
 * hub. It sits alongside `Device` the way a device sits alongside its
 * capabilities: enumerable, inspectable, and it keeps its own event log so
 * "what just happened" is visible without reading server console output.
 *
 * A service is not a device: it has no capabilities, no config schema from
 * `devices.yml`, and nothing provisions it per-instance. It exists
 * once per process, started in `src/index.ts` alongside the site.
 */
import type { Availability } from "./capability";
import { HealthReporter, availabilityHealth, type HealthCheck } from "../health/model";
import type { EventFilter, ServiceEvent, ServiceEventListener } from "./event-log";
import { countDetectionLabels } from "./detection-labels";

/** What a service reports about itself right now, for the services list and its own page. */
export interface ServiceStatus {
  readonly availability: Availability;
  /** One line: what it is doing, e.g. "Listening on 0.0.0.0:1883, 2 clients connected". */
  readonly detail: string;
}

/**
 * Something a service can be told to do once, as opposed to `switch`'s
 * standing on/off: a Hue bridge's virtual link button, say. Declaring it here
 * is what lets the API route, the CLI command and the UI control all come from
 * one definition rather than three hand-written copies.
 */
export interface ServiceAction {
  readonly id: string;
  /**
   * What the action leaves standing right now, for an action whose effect
   * lasts: a pairing window that is open until some moment. A surface reads it
   * to show the truth before anyone presses, so the page never paints a
   * placeholder and then swaps it.
   */
  state?(): ServiceActionState;
  /** Performs it, returning one line describing what happened, for whichever surface asked. */
  invoke(): Promise<{ readonly detail: string }>;
}

/** How an action stands at this moment; an action with no lasting effect has no state at all. */
export interface ServiceActionState {
  /** When the effect lapses (ISO 8601), while it is in force; absent when nothing is in force. */
  readonly until?: string;
}

/**
 * One live endpoint a service is joined to — what a page shows so the thing is
 * not a black box: who connected to it and what it reaches.
 */
export interface ServiceEndpoint {
  /** `in`: something connected to this service (a client). `out`: something it reaches (an upstream). */
  readonly direction: "in" | "out";
  readonly label: string;
  /** A second line of context: an address, a count, a device type. */
  readonly detail?: string;
  /** Where to go to see more of it, when HomeTruth has such a page or the endpoint serves its own. */
  readonly href?: string;
  /** Carrying traffic right now (streaming, event stream connected), as opposed to merely known. */
  readonly active?: boolean;
}

export abstract class Service extends HealthReporter {
  constructor(readonly id: string, readonly title: string) { super(); }

  /** Status must reflect the backing listener, connection, or worker; override for an active API check. */
  async checkHealth(): Promise<HealthCheck> {
    if (this.switch && !this.switch.enabled) return this.reportHealth({ status: "disabled", detail: "Service is paused" });
    try { return this.reportHealth(availabilityHealth(this.status().availability)); }
    catch { return this.reportHealth({ status: "unhealthy", detail: "Service health check failed" }); }
  }

  /** Present on a service the web UI can show as an on/off switch (e.g. an automation's enabled flag). */
  get switch(): { enabled: boolean; setEnabled(enabled: boolean): Promise<void> } | undefined { return undefined; }

  /** Momentary actions this service offers; empty when it has none. */
  get actions(): readonly ServiceAction[] { return []; }

  /** What this service is joined to right now; empty when it fronts nothing. */
  get endpoints(): readonly ServiceEndpoint[] { return []; }

  abstract status(): ServiceStatus;

  /** Newest first, narrowed by `filter`; a service with no log yet returns an empty array. */
  abstract events(limit?: number, filter?: EventFilter): readonly ServiceEvent[];

  /**
   * Which devices this service's events are about, for a "filter by device"
   * menu. A service whose events name no device returns an empty array.
   */
  subjects(): readonly string[] {
    return [];
  }

  /** Available detection labels, including saved history when a service persists it. */
  detectionLabels(): readonly string[] {
    return Object.keys(this.detectionLabelCounts()).sort();
  }

  /** All kept label events for a device, independent of pagination and selected labels. */
  detectionLabelCounts(subject?: string): Readonly<Record<string, number>> {
    return countDetectionLabels(this.events(Number.MAX_SAFE_INTEGER, subject === undefined ? {} : { subject }));
  }

  /** Calls `listener` with each event as it happens, from now on (not the backlog — pair with `events()` for that). Returns a function that stops it. */
  abstract subscribe(listener: ServiceEventListener, filter?: EventFilter): () => void;

  stop?(): Promise<void>;
}

/** Domain facts held by state; page URLs and formatted text belong to presentation. */
export interface ServiceSnapshot {
  readonly health: HealthCheck;
  readonly id: string;
  readonly title: string;
  readonly status: ServiceStatus;
  readonly endpoints: readonly ServiceEndpoint[];
  readonly actions: readonly ({ readonly id: string } & ServiceActionState)[];
}
