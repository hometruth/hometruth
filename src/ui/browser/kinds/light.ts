/**
 * The light kind: a device's `light` capability, or `stringLight` when the
 * element's `capability` attribute says so. `lightView()` reads power and
 * the bounds of every control the document declares (`setBrightness`,
 * `setColorTemperature` — fixed white when its minimum equals its maximum —
 * `setColor`), and says when the state is only what was last commanded.
 *
 * Template contract (parts a themed `<ht-light>` provides; each optional):
 * - `state`, `value`, `detail` as for `<ht-switch>` — no mark, no dot: status lives on the buttons.
 * - `swatch`   gets `data-on` and, when the light reports a colour while on, `data-color`
 *              and a `fill` attribute (an SVG shape shows it without a style attribute).
 * - `actions`  container of `<button data-action="turnOn|turnOff|toggle|getState">`, each carrying
 *              `data-state` (active | inactive | unknown | checking | updating | failure); turnOn/turnOff/toggle
 *              share it (one property), getState keeps its own.
 * - `brightness-field`, `brightness` (`<input type="range">`), `brightness-value` (text).
 * - `temperature-field`, `temperature` (`<input type="range">`), `temperature-value` (text).
 * - `white`    `<button data-action="white">` for a fixed-white string; `white-help` its note.
 * - `color-field`, `color` (`<input type="color">`), `color-value` (text).
 * - `feedback` the error, when the last command failed; empty otherwise.
 * A field is hidden when the document lacks its action; an input's `min`/`max`/`step` follow
 * the document's bounds; `input` events update the text, `change` events send the value.
 */
import type { Availability } from "../../../models/capability.ts";
import type { Light, StringLightDocument } from "../../../schemas.ts";
import type { Fault } from "../../../state/protocol.ts";
import { HtElement } from "../element.ts";
import { ht } from "../runtime.ts";
import { type ActionView, type Feedback, type FormatNumber, type FormatTime, type Notice, type Readiness, type Translate, feedbackOf, powerButtonState, powerLabel, readinessAvailability, readingDetail } from "../view.ts";

export type LightDocument = Light | StringLightDocument;
export type LightCapability = "light" | "stringLight";
export type LightAction = keyof NonNullable<Light["actions"]> | "getState";
export type LightPowerAction = "turnOn" | "turnOff" | "toggle" | "getState";
export const LIGHT_POWER_ACTIONS: readonly LightPowerAction[] = ["turnOn", "turnOff", "toggle", "getState"];

export type LightPhase = "checking" | "gone" | "offline" | "degraded" | "on" | "off" | "unknown";

export interface LightViewInput {
  readonly capability: LightCapability;
  readonly readiness: Readiness;
  readonly document?: LightDocument;
  readonly fault?: Fault;
  readonly stale: boolean;
  readonly observedAt?: string;
  readonly pending?: string;
  readonly error?: string;
  /** Which control the current `error` belongs to; a failure colours only that control's own button(s). */
  readonly errorControl?: string;
  readonly notice?: Notice;
}

export interface RangeView {
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly value?: number;
  /** The formatted value, or the catalog's colour-mode word for a temperature with none. */
  readonly text: string;
}

export interface LightView {
  readonly phase: LightPhase;
  readonly availability: Availability;
  readonly value: string;
  readonly detail: string;
  readonly swatch: { readonly on: boolean; readonly color?: string };
  readonly brightness?: RangeView;
  readonly temperature?: RangeView;
  /** Present when the document's temperature range is one value: a single button sets it. */
  readonly white?: { readonly kelvin: number; readonly label: string; readonly help: string };
  readonly color?: { readonly value?: string };
  readonly actions: readonly ActionView<LightPowerAction>[];
  readonly feedback: Feedback;
  readonly busy: boolean;
}

const HEX = /^#[0-9a-f]{6}$/iu;

function phaseOf(input: LightViewInput): LightPhase {
  if (input.readiness === "checking" || input.readiness === "gone") return input.readiness;
  if (input.fault) return "offline";
  const state = input.document?.state;
  const commanded = state?.stateSource === "commanded";
  if (!commanded) {
    if (input.readiness === "offline") return "offline";
    if (input.readiness === "degraded") return "degraded";
  }
  if (typeof state?.on !== "boolean") return "unknown";
  return state.on ? "on" : "off";
}

/** The state word for a phase no button can say: the power buttons already carry on/off/checking/unknown themselves. */
function wordOf(phase: LightPhase, t: Translate): string {
  return phase === "gone" ? t("state.gone") : "";
}

export function lightView(input: LightViewInput, t: Translate, time: FormatTime, number: FormatNumber): LightView {
  const phase = phaseOf(input);
  const state = input.document?.state;
  const actions = input.document?.actions ?? {};
  const powerPending = input.pending !== undefined && input.pending !== "getState" && (LIGHT_POWER_ACTIONS as readonly string[]).includes(input.pending);
  const powerFailed = input.error !== undefined && input.errorControl !== undefined && input.errorControl !== "getState" && (LIGHT_POWER_ACTIONS as readonly string[]).includes(input.errorControl);
  const refreshPending = input.pending === "getState";
  const refreshFailed = input.error !== undefined && input.errorControl === "getState";
  const busy = input.pending !== undefined;
  const readiness: Readiness = phase === "on" || phase === "off" || phase === "unknown" ? input.readiness : phase;
  const percent = (value: number) => number(value / 100, { style: "percent" });
  const kelvin = (value: number) => t("light.kelvin", { kelvin: number(value) });
  const commandedAt = state?.stateSource === "commanded" ? state.commandedAt : undefined;
  const reading = readingDetail({ readiness, stale: input.stale, ...(input.fault ? { fault: input.fault } : {}), ...(input.observedAt ? { observedAt: input.observedAt } : {}) }, t, time);
  // A fault names the problem and the fix; only a light that answers gets the "last command" sentence.
  const detail = input.fault
    ? reading
    : commandedAt
      ? t("light.commanded", { time: time(commandedAt) })
      : reading || (phase !== "offline" && state?.detail ? state.detail : "");
  const on = state?.on === true;
  const color = typeof state?.color === "string" && HEX.test(state.color) ? state.color : undefined;
  const temperatureAction = actions.setColorTemperature;
  const fixedWhite = temperatureAction !== undefined && temperatureAction.minimumKelvin === temperatureAction.maximumKelvin;
  return {
    phase,
    availability: readinessAvailability(readiness),
    value: wordOf(phase, t),
    detail,
    swatch: { on, ...(on && color ? { color } : {}) },
    ...(actions.setBrightness ? {
      brightness: {
        min: actions.setBrightness.minimumPercent,
        max: actions.setBrightness.maximumPercent,
        ...(actions.setBrightness.stepPercent === undefined ? {} : { step: actions.setBrightness.stepPercent }),
        ...(typeof state?.brightnessPercent === "number" ? { value: state.brightnessPercent, text: percent(state.brightnessPercent) } : { text: "" }),
      },
    } : {}),
    ...(temperatureAction && !fixedWhite ? {
      temperature: {
        min: temperatureAction.minimumKelvin,
        max: temperatureAction.maximumKelvin,
        ...(temperatureAction.stepKelvin === undefined ? {} : { step: temperatureAction.stepKelvin }),
        ...(typeof state?.colorTemperatureKelvin === "number" ? { value: state.colorTemperatureKelvin, text: kelvin(state.colorTemperatureKelvin) } : { text: t("light.colorMode") }),
      },
    } : {}),
    ...(temperatureAction && fixedWhite ? {
      white: {
        kelvin: temperatureAction.minimumKelvin,
        label: t(input.capability === "stringLight" ? "stringLight.warmWhite" : "light.warmWhite", { kelvin: kelvin(temperatureAction.minimumKelvin) }),
        help: input.capability === "stringLight" ? t("stringLight.warmWhiteHelp") : "",
      },
    } : {}),
    ...(actions.setColor ? { color: color ? { value: color } : {} } : {}),
    actions: input.document
      ? LIGHT_POWER_ACTIONS.filter((id) => Object.hasOwn(actions, id)).map((id): ActionView<LightPowerAction> => {
        const side = id === "turnOn" ? "on" : id === "turnOff" ? "off" : "neither";
        const buttonState = id === "getState"
          ? powerButtonState({ side: "neither", phase, powerPending: refreshPending, powerFailed: refreshFailed })
          : powerButtonState({ side, phase, powerPending, powerFailed });
        return { id, label: powerLabel(id, t), primary: id === "turnOn", enabled: buttonState !== "checking" && buttonState !== "updating", state: buttonState };
      })
      : [],
    feedback: feedbackOf({ ...(input.error ? { error: input.error } : {}), ...(input.notice ? { notice: input.notice } : {}) }),
    busy,
  };
}

export abstract class HtLight extends HtElement<LightDocument> {
  #inputsWired = false;

  protected get defaultCapability(): string {
    return "light";
  }

  get lightCapability(): LightCapability {
    return this.capability === "stringLight" ? "stringLight" : "light";
  }

  turnOn(): Promise<boolean> {
    return this.invoke("turnOn");
  }

  turnOff(): Promise<boolean> {
    return this.invoke("turnOff");
  }

  toggle(): Promise<boolean> {
    return this.invoke("toggle");
  }

  refresh(): Promise<boolean> {
    return this.invoke("getState");
  }

  setBrightness(percent: number): Promise<boolean> {
    return this.invoke("setBrightness", percent);
  }

  setColorTemperature(kelvin: number): Promise<boolean> {
    return this.invoke("setColorTemperature", kelvin);
  }

  setColor(hex: string): Promise<boolean> {
    return this.invoke("setColor", hex);
  }

  get view(): LightView {
    const frame = this.frame;
    const document = this.document;
    const observedAt = frame?.observedAt ?? document?.state.observedAt;
    const pending = this.pendingControl;
    const errorControl = this.erroredControl;
    const notice = this.notice;
    return lightView({
      capability: this.lightCapability,
      readiness: this.readiness,
      stale: frame?.stale ?? false,
      ...(document ? { document } : {}),
      ...(frame?.fault ? { fault: frame.fault } : {}),
      ...(observedAt ? { observedAt } : {}),
      ...(pending ? { pending } : {}),
      ...(this.error ? { error: this.error } : {}),
      ...(errorControl ? { errorControl } : {}),
      ...(notice ? { notice } : {}),
    }, (key, params) => this.t(key, params), ht.time, ht.number);
  }

  override connectedCallback(): void {
    if (!this.#inputsWired) {
      this.#inputsWired = true;
      this.#wireRange("brightness", "brightness-value", (value) => ht.number(value / 100, { style: "percent" }), (value) => this.setBrightness(value));
      this.#wireRange("temperature", "temperature-value", (value) => this.t("light.kelvin", { kelvin: ht.number(value) }), (value) => this.setColorTemperature(value));
      const color = this.partNamed("color") as HTMLInputElement | null;
      color?.addEventListener("input", () => {
        const output = this.partNamed("color-value");
        if (output) output.textContent = color.value;
      });
      color?.addEventListener("change", () => {
        if (this.pending || !HEX.test(color.value)) return;
        this.#hold("color", color.value);
        void this.setColor(color.value).then((accepted) => { if (!accepted) this.#drop("color"); });
      });
    }
    super.connectedCallback();
  }

  /**
   * What the user just asked for, shown until a frame newer than the one at
   * command time arrives: the device's readback lags the command, and a
   * render in between must not snap the slider back to the old value.
   */
  readonly #commanded = new Map<string, { value: string; version: number }>();

  #hold(control: string, value: string): void {
    this.#commanded.set(control, { value, version: this.frame?.version ?? 0 });
  }

  #drop(control: string): void {
    this.#commanded.delete(control);
    this.render();
  }

  /** The held value for a control, or undefined once a newer frame has spoken. */
  #held(control: string): string | undefined {
    const held = this.#commanded.get(control);
    if (!held) return undefined;
    if ((this.frame?.version ?? 0) > held.version) {
      this.#commanded.delete(control);
      return undefined;
    }
    return held.value;
  }

  #dragging(input: HTMLElement | null): boolean {
    return input !== null && this.shadowRoot?.activeElement === input;
  }

  protected override onAction(action: string): void {
    switch (action) {
      case "turnOn": void this.turnOn(); break;
      case "turnOff": void this.turnOff(); break;
      case "toggle": void this.toggle(); break;
      case "getState": case "refresh": void this.refresh(); break;
      case "white": {
        const white = this.view.white;
        if (white) void this.setColorTemperature(white.kelvin);
        break;
      }
      default: break;
    }
  }

  protected render(): void {
    const view = this.view;
    this.dataset.phase = view.phase;
    this.dataset.availability = view.availability;
    const state = this.partNamed("state");
    if (state) {
      state.dataset.phase = view.phase;
      state.dataset.availability = view.availability;
    }
    const value = this.partNamed("value");
    if (value) {
      value.textContent = view.value;
      value.hidden = !view.value;
    }
    const detail = this.partNamed("detail");
    if (detail) {
      detail.textContent = view.detail;
      detail.hidden = !view.detail;
    }
    const swatch = this.partNamed("swatch");
    if (swatch) {
      swatch.dataset.on = String(view.swatch.on);
      if (view.swatch.color) {
        swatch.dataset.color = view.swatch.color;
        swatch.setAttribute("fill", view.swatch.color);
      } else {
        delete swatch.dataset.color;
        swatch.removeAttribute("fill");
      }
    }
    this.#renderRange("brightness", view.brightness);
    this.#renderRange("temperature", view.temperature);
    const white = this.partNamed("white");
    if (white) {
      white.hidden = !view.white;
      if (view.white) white.textContent = view.white.label;
    }
    const whiteHelp = this.partNamed("white-help");
    if (whiteHelp) {
      whiteHelp.textContent = view.white?.help ?? "";
      whiteHelp.hidden = !view.white?.help;
    }
    const colorField = this.partNamed("color-field");
    if (colorField) colorField.hidden = !view.color;
    const color = this.partNamed("color") as HTMLInputElement | null;
    const heldColor = this.#held("color");
    const colorValue = this.partNamed("color-value");
    if (heldColor !== undefined) {
      if (color) color.value = heldColor;
      if (colorValue) colorValue.textContent = heldColor;
    } else if (!this.#dragging(color)) {
      if (color && view.color?.value) color.value = view.color.value;
      if (colorValue) colorValue.textContent = view.color?.value ?? "";
    }
    for (const button of this.actionButtons()) {
      if (button.dataset.action === "white") {
        if (view.busy) button.setAttribute("aria-disabled", "true");
        else button.removeAttribute("aria-disabled");
        button.dataset.state = view.phase === "checking" ? "checking" : "unknown";
        continue;
      }
      const action = view.actions.find((item) => item.id === button.dataset.action);
      button.hidden = !action;
      if (!action) continue;
      button.textContent = action.label;
      if (action.enabled) button.removeAttribute("aria-disabled");
      else button.setAttribute("aria-disabled", "true");
      button.dataset.state = action.state;
      if (action.id === "turnOn" || action.id === "turnOff") button.setAttribute("aria-pressed", String(action.state === "active"));
      if (action.state === "failure" && view.feedback.message) button.setAttribute("title", view.feedback.message);
      else button.removeAttribute("title");
    }
  }

  #renderRange(name: "brightness" | "temperature", range: RangeView | undefined): void {
    const field = this.partNamed(`${name}-field`);
    if (field) field.hidden = !range;
    const input = this.partNamed(name) as HTMLInputElement | null;
    const held = this.#held(name);
    // A value the user is dragging or has just sent stays; the frame writes the input only when it has the last word.
    const keep = held !== undefined || this.#dragging(input);
    if (input && range) {
      input.min = String(range.min);
      input.max = String(range.max);
      if (range.step !== undefined) input.step = String(range.step);
      if (held !== undefined) input.value = held;
      else if (!keep && range.value !== undefined) input.value = String(range.value);
    }
    const output = this.partNamed(`${name}-value`);
    if (output && !keep) output.textContent = range?.text ?? "";
  }

  #wireRange(name: string, outputName: string, format: (value: number) => string, send: (value: number) => Promise<boolean>): void {
    const input = this.partNamed(name) as HTMLInputElement | null;
    if (!input) return;
    input.addEventListener("input", () => {
      const output = this.partNamed(outputName);
      if (output) output.textContent = format(Number(input.value));
    });
    input.addEventListener("change", () => {
      if (this.pending) return;
      this.#hold(name, input.value);
      void send(Number(input.value)).then((accepted) => { if (!accepted) this.#drop(name); });
    });
  }
}
