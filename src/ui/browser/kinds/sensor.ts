/**
 * The sensor kind: one contact or occupancy sensor as a row of cells, the same
 * row wherever it appears — in the list of what a hub bridges, and alone on the
 * sensor's own page. A hub's list and a device page used to build this reading
 * twice, by hand, in two different shapes; they now render the same element
 * against the same schema, so a door reads the same way in both places and is
 * marked live in both by the same code.
 *
 * Template contract (parts a themed `<ht-sensor>` provides; each optional):
 * - `state`    the row container; carries `data-availability` and `data-stale`.
 * - `name`     the device's own name, from the node. A themed template may make it a link, which
 *              the element points at the `href` attribute the page set; without one it stays text.
 * - `mark`     the availability mark, coloured by `data-availability`, paired always with `value`.
 * - `value`    the reading in words: Open / Closed, Occupied / Clear, or the availability word when
 *              there is no reading to show. Never blank, because a row with an empty cell reads as
 *              a layout fault rather than as a sensor that has not answered.
 * - `battery`  the battery percentage, or an em dash when the document carries none.
 * - `age`      when the graph last confirmed this record, in words.
 * - `detail`   a fault's own sentence; empty otherwise.
 *
 * The host is `display: contents` in every theme, so the cells above are laid out by the *list's*
 * grid rather than by the element. That is what keeps columns aligned down a hub's nine sensors
 * while the identical element, alone on its own page, is simply that grid with one row.
 */
import type { Availability } from "../../../models/capability.ts";
import type { ContactDocument, OccupancyDocument } from "../../../models/sensors.ts";
import { HtElement } from "../element.ts";
import { ht } from "../runtime.ts";
import { readinessAvailability, readinessWord, type Readiness } from "../view.ts";

export type SensorDocument = ContactDocument | OccupancyDocument;

type SensorState = {
  availability?: Availability;
  detail?: string;
  open?: boolean;
  occupied?: boolean;
  batteryPercent?: number;
  tampered?: boolean;
};

export interface SensorView {
  readonly availability: Availability;
  readonly name: string;
  readonly value: string;
  readonly battery: string;
  readonly age: string;
  readonly detail: string;
  readonly stale: boolean;
}

const DASH = "—";

/**
 * The reading in words. A contact sensor says Open or Closed, an occupancy sensor Occupied or
 * Clear; anything with no reading of its own falls back to the availability word, so the cell
 * still says something true rather than going blank.
 */
export function sensorWord(state: SensorState, readiness: Readiness): string {
  if (typeof state.open === "boolean") return ht.t(state.open ? "sensor.open" : "sensor.closed");
  if (typeof state.occupied === "boolean") return ht.t(state.occupied ? "sensor.occupied" : "sensor.clear");
  return readinessWord(readiness, ht.t);
}

/** Everything a themed template writes, decided once here so every theme says the same thing. */
export function sensorView(input: {
  readonly state: SensorState;
  readonly readiness: Readiness;
  readonly name: string;
  readonly observedAt?: string;
  readonly fault?: { message: string };
  readonly stale: boolean;
}): SensorView {
  const { state, readiness } = input;
  return {
    availability: readinessAvailability(readiness),
    name: input.name,
    value: sensorWord(state, readiness),
    battery: typeof state.batteryPercent === "number" ? ht.number(state.batteryPercent / 100, { style: "percent" }) : DASH,
    // Relative, because on a row the useful question is how old this is, not what o'clock it was.
    age: input.observedAt ? ht.relativeTime(input.observedAt) : "",
    detail: input.fault ? input.fault.message : state.detail ?? "",
    stale: input.stale,
  };
}

export abstract class HtSensor extends HtElement<SensorDocument> {
  protected get defaultCapability(): string {
    return "contactSensor";
  }

  /**
   * A device node's document for whichever sensor capability it carries. The `capability`
   * attribute picks one explicitly; otherwise contact wins over occupancy, which is the order a
   * device that somehow exposed both would want.
   */
  protected get sensorDocument(): SensorDocument | undefined {
    const capabilities = (this.value as { capabilities?: Record<string, SensorDocument> } | undefined)?.capabilities;
    if (!capabilities) return undefined;
    return capabilities[this.capability] ?? capabilities.contactSensor ?? capabilities.occupancySensor;
  }

  protected render(): void {
    const frame = this.frame;
    const state = (this.sensorDocument?.state ?? {}) as SensorState;
    const view = sensorView({
      state,
      readiness: this.readiness,
      name: (this.value as { name?: string } | undefined)?.name ?? this.getAttribute("label") ?? "",
      ...(frame?.observedAt ? { observedAt: frame.observedAt } : {}),
      ...(frame?.fault ? { fault: frame.fault } : {}),
      stale: frame?.stale ?? true,
    });
    const container = this.partNamed("state");
    if (container) {
      container.dataset.availability = view.availability;
      container.dataset.stale = String(view.stale);
    }
    this.dataset.availability = view.availability;
    const name = this.partNamed("name");
    if (name) {
      name.textContent = view.name;
      const href = this.getAttribute("href");
      if (href && name instanceof HTMLAnchorElement) name.href = href;
    }
    const mark = this.partNamed("mark");
    if (mark) mark.dataset.availability = view.availability;
    this.write("value", view.value);
    this.write("battery", view.battery);
    this.write("age", view.age);
    const detail = this.partNamed("detail");
    if (detail) {
      detail.textContent = view.detail;
      detail.hidden = !view.detail;
    }
  }

  private write(part: string, text: string): void {
    const node = this.partNamed(part);
    if (node) node.textContent = text;
  }
}
