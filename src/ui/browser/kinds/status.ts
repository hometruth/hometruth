/**
 * The status kind: a whole device in one line for a list row — the mark, the
 * availability word, and `summaryOf()`, the catalog-driven port of the
 * server's English `summaryDetail()` (`src/site.ts`). The API's `detail`
 * field stays for the CLI; pages read the node and format here, so a row
 * reads in the viewer's language with `Intl` numbers.
 *
 * Template contract (parts a themed `<ht-status>` provides; each optional):
 * - `state`   container; gets `data-availability` and `data-stale`. No dot, no status word: this
 *             row has no button of its own, so the page recolours the row's name instead (the
 *             runtime mirrors `data-availability` from the host onto the closest `.row` on every frame).
 * - `summary` what the object carries (On, 45 % · 2700 K, a reading preview…); empty while checking
 *             or once a fault or an unreached device leaves nothing to say. Hidden when empty.
 */
import type { Availability } from "../../../models/capability.ts";
import type { HomeTruthObject } from "../../../schemas.ts";
import type { Fault } from "../../../state/protocol.ts";
import { HtElement } from "../element.ts";
import { ht } from "../runtime.ts";
import { type FormatNumber, type Readiness, type Translate, readinessAvailability } from "../view.ts";

/** What `summaryOf` reads: a HomeTruth object, or a group switch (which carries the same `binarySwitch`). */
export interface SummaryInput {
  readonly status?: Availability;
  readonly model?: string;
  readonly firmwareVersion?: string;
  readonly sensors?: HomeTruthObject["sensors"];
  readonly capabilities: HomeTruthObject["capabilities"];
}

const SEPARATOR = " · ";

function readingPreview(readings: readonly { name: string; value?: number; unit: string; availability: Availability }[], t: Translate, number: FormatNumber): string {
  return readings
    .filter((reading) => reading.availability === "online" && reading.value !== undefined)
    .slice(0, 3)
    .map((reading) => t("summary.reading", { name: reading.name, value: number(reading.value!, { maximumFractionDigits: 1 }), unit: reading.unit }))
    .join(SEPARATOR);
}

function playbackWord(playback: string, t: Translate): string {
  switch (playback) {
    case "playing": return t("speaker.playing");
    case "paused": return t("speaker.paused");
    case "stopped": return t("speaker.stopped");
    case "transitioning": return t("speaker.transitioning");
    default: return t("status.unknown");
  }
}

/** One line of status for a row, from the object's own document; undefined when the object says nothing. */
export function summaryOf(object: SummaryInput, t: Translate, number: FormatNumber): string | undefined {
  const { capabilities } = object;
  const percent = (value: number) => number(value / 100, { style: "percent" });
  if (capabilities.binarySwitch) {
    const value = capabilities.binarySwitch.state.value;
    return value ? (value === "on" ? t("action.on") : t("action.off")) : t("status.notReachable");
  }
  if (capabilities.stringLight) {
    const state = capabilities.stringLight.state;
    const power = state.on === undefined ? t("status.unknown") : state.on ? t("action.on") : t("action.off");
    return [t("summary.lights", { count: state.lightCount }), power].join(SEPARATOR);
  }
  if (capabilities.light) {
    const state = capabilities.light.state;
    if (state.on === undefined) return t("status.notReachable");
    if (!state.on) return t("action.off");
    return [
      t("action.on"),
      ...(state.brightnessPercent === undefined ? [] : [percent(state.brightnessPercent)]),
      ...(state.colorTemperatureKelvin === undefined ? [] : [t("light.kelvin", { kelvin: number(state.colorTemperatureKelvin) })]),
    ].join(SEPARATOR);
  }
  if (capabilities.camera) {
    if (object.status === "offline") return capabilities.treatDispenser ? t("summary.notDiscovered") : t("status.notReachable");
    const parts = [object.model, object.firmwareVersion ? t("camera.firmware", { version: object.firmwareVersion }) : undefined].filter((part): part is string => Boolean(part));
    return parts.length ? parts.join(", ") : t("summary.discovered");
  }
  if (capabilities.infraredBlaster || capabilities.radioFrequencyBlaster) {
    return object.status === "online" ? t("summary.ready") : t("status.notReachable");
  }
  if (capabilities.radioFrequencyReceiver) {
    return capabilities.radioFrequencyReceiver.state.availability === "offline" ? t("status.notReachable") : t("summary.readyToListen");
  }
  if (capabilities.speaker) {
    const state = capabilities.speaker.state;
    if (state.playback === undefined) return t("status.notReachable");
    if (state.group && state.group.isCoordinator === false) return t("summary.bondedTo", { host: state.group.coordinatorHost ?? "" });
    return [playbackWord(state.playback, t), ...(state.volumePercent === undefined ? [] : [percent(state.volumePercent)])].join(SEPARATOR);
  }
  if (capabilities.button) return t("summary.button");
  if (object.sensors?.length) {
    const preview = readingPreview(object.sensors.map((sensor) => ({ name: sensor.name, unit: sensor.unit, availability: sensor.state.availability, ...(sensor.state.value === undefined ? {} : { value: sensor.state.value }) })), t, number);
    if (preview) return object.status === "degraded" ? [preview, t("summary.someUnavailable")].join(SEPARATOR) : preview;
    return object.sensors.find((sensor) => sensor.state.detail)?.state.detail ?? t("sensor.unavailable");
  }
  const sensor = capabilities.sensor?.state;
  if (sensor) {
    if (sensor.availability === "offline") return sensor.detail ?? t("status.notReachable");
    const preview = readingPreview(sensor.sensors.map((reading) => ({ name: reading.name, unit: reading.unit, availability: reading.availability, ...(reading.value === undefined ? {} : { value: reading.value }) })), t, number);
    if (preview) return sensor.availability === "degraded" ? [preview, t("summary.someUnavailable")].join(SEPARATOR) : preview;
    return sensor.detail ?? t("sensor.unavailable");
  }
  const occupancy = capabilities.occupancySensor?.state;
  if (occupancy) return occupancy.detail ?? (occupancy.occupied === undefined ? t("sensor.unavailable") : occupancy.occupied ? t("sensor.occupied") : t("sensor.clear"));
  const contact = capabilities.contactSensor?.state;
  if (contact) {
    if (contact.detail) return contact.detail;
    if (contact.open === undefined) return t("sensor.unavailable");
    const word = contact.open ? t("sensor.open") : t("sensor.closed");
    return contact.batteryPercent === undefined ? word : [word, t("summary.battery", { percent: percent(contact.batteryPercent) })].join(SEPARATOR);
  }
  const hub = capabilities.hub?.state;
  if (hub) return hub.detail ?? t("summary.accessories", { count: hub.accessories?.length ?? 0 });
  return undefined;
}

export interface StatusViewInput {
  readonly readiness: Readiness;
  readonly object?: SummaryInput;
  readonly fault?: Fault;
  readonly stale: boolean;
}

export interface StatusView {
  readonly availability: Availability;
  readonly summary: string;
  readonly stale: boolean;
}

/** The fault's sentence when there is one, else what the object carries; empty while checking, or once there is nothing to say. The row's own colour carries the readiness — there is no separate word for it. */
export function statusView(input: StatusViewInput, t: Translate, number: FormatNumber): StatusView {
  const summary = input.readiness === "checking" ? "" : input.fault ? input.fault.message : input.object ? summaryOf(input.object, t, number) ?? "" : "";
  return {
    availability: readinessAvailability(input.readiness),
    summary,
    stale: input.stale,
  };
}

export abstract class HtStatus extends HtElement<SummaryInput> {
  protected get defaultCapability(): string {
    return "status";
  }

  /** The whole object: a status line reads every capability, not one. */
  override get document(): SummaryInput | undefined {
    const value = this.value as SummaryInput | undefined;
    return value && typeof value === "object" && "capabilities" in value ? value : undefined;
  }

  get view(): StatusView {
    const frame = this.frame;
    const object = this.document;
    return statusView({
      readiness: this.readiness,
      stale: frame?.stale ?? false,
      ...(object ? { object } : {}),
      ...(frame?.fault ? { fault: frame.fault } : {}),
    }, (key, params) => this.t(key, params), ht.number);
  }

  protected render(): void {
    const view = this.view;
    this.dataset.availability = view.availability;
    if (view.stale) this.dataset.stale = "true";
    else delete this.dataset.stale;
    const state = this.partNamed("state");
    if (state) {
      state.dataset.availability = view.availability;
      if (view.stale) state.dataset.stale = "true";
      else delete state.dataset.stale;
    }
    const summary = this.partNamed("summary");
    if (summary) {
      summary.textContent = view.summary;
      summary.hidden = !view.summary;
    }
  }
}
