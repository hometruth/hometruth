/**
 * The television kind: a device's `television` capability. Power, the remote
 * keys the set declares, volume and mute, an input picker, and — on a set that
 * has one — art mode.
 *
 * Power and art mode are the same shape as the switch's on/off pair: two
 * buttons, the one that names the verified setting reading as pressed. What
 * makes a television different is that a set answers with its power state and
 * nothing else, so volume and mute are commands with no reading behind them
 * and never claim one.
 *
 * Template contract (parts a themed `<ht-television>` provides; each optional):
 * - `state`    container; gets `data-phase` and `data-availability`.
 * - `value`    the phase word (Art mode, "No longer configured…"); hidden when
 *              the power buttons already say it.
 * - `detail`   "Read {time}" / "Last read {time}" / a fault's sentence.
 * - `actions`  `<button data-action="turnOn|turnOff|getState">`.
 * - `art`      `<button data-action="artOn|artOff">`; the whole part is hidden
 *              on a set with no `setArtMode` action.
 * - `keys`     one `<button data-action="key" data-key="<generic key>">` per
 *              key in the shared vocabulary; each hidden unless the document's
 *              `press.keys` lists it.
 * - `volume`   `<button data-action="volumeUp|volumeDown|toggleMute">`.
 * - `input-field`, `input-label`, `input` (`<select>`), whose options are
 *              written from the document's `setInput.inputs`; the field is
 *              hidden on a set that declares none.
 * - `feedback` the last command's error; empty otherwise.
 */
import type { Availability } from "../../../models/capability.ts";
import type { Television } from "../../../schemas.ts";
import type { Fault } from "../../../state/protocol.ts";
import { HtElement } from "../element.ts";
import { ht } from "../runtime.ts";
import { type ActionView, type ButtonState, type Feedback, type FormatTime, type Notice, type Readiness, type Translate, feedbackOf, powerButtonState, readinessAvailability, readingDetail } from "../view.ts";

export type TelevisionAction = keyof Television["actions"];
/** The controls that write the set's own power, so they share one pending state. */
export const TELEVISION_POWER_ACTIONS: readonly string[] = ["turnOn", "turnOff"];
export const TELEVISION_ART_ACTIONS = ["artOn", "artOff"] as const;

export type TelevisionPhase = "checking" | "gone" | "offline" | "degraded" | "art" | "on" | "standby" | "unknown";

export interface TelevisionViewInput {
  readonly readiness: Readiness;
  readonly document?: Television;
  readonly fault?: Fault;
  readonly stale: boolean;
  readonly observedAt?: string;
  readonly pending?: string;
  readonly error?: string;
  readonly errorControl?: string;
  readonly notice?: Notice;
}

export interface TelevisionInputView {
  readonly id: string;
  readonly label: string;
  readonly current: boolean;
}

export interface TelevisionView {
  readonly phase: TelevisionPhase;
  readonly availability: Availability;
  readonly value: string;
  readonly detail: string;
  readonly actions: readonly ActionView<string>[];
  /** Empty on a set with no art mode, which is how a template knows to hide the whole part. */
  readonly art: readonly ActionView<string>[];
  readonly keys: readonly string[];
  readonly volume: readonly ActionView<string>[];
  readonly inputs: readonly TelevisionInputView[];
  readonly feedback: Feedback;
  readonly busy: boolean;
}

function phaseOf(input: TelevisionViewInput): TelevisionPhase {
  if (input.readiness === "checking" || input.readiness === "gone") return input.readiness;
  if (input.fault) return "offline";
  const state = input.document?.state;
  const availability = state?.availability ?? input.readiness;
  if (availability === "offline") return "offline";
  if (availability === "degraded") return "degraded";
  if (state?.power === "standby") return "standby";
  if (state?.power === "on") return state.artMode === "on" ? "art" : "on";
  return "unknown";
}

/**
 * The word for a phase the power buttons cannot say themselves. On and Standby
 * are already those two buttons' own pressed states, so only art mode — a third
 * thing a set can be doing while it is on — and the phases with no reading at
 * all get a word.
 */
function wordOf(phase: TelevisionPhase, t: Translate): string {
  switch (phase) {
    case "art": return t("tv.artMode");
    case "gone": return t("state.gone");
    case "degraded": return t("status.degraded");
    default: return "";
  }
}

/** Art mode is a second on/off pair, so it borrows the power button's own state ladder. */
function artState(side: "on" | "off", artMode: string | undefined, pending: boolean, failed: boolean, phase: TelevisionPhase): ButtonState {
  if (phase === "checking") return "checking";
  if (failed) return "failure";
  if (pending) return "updating";
  if (artMode !== "on" && artMode !== "off") return "unknown";
  return artMode === side ? "active" : "inactive";
}

function label(controlId: string, t: Translate): string {
  switch (controlId) {
    case "turnOn": return t("tv.turnOn");
    case "turnOff": return t("tv.turnOff");
    case "artOn": return t("tv.showArt");
    case "artOff": return t("tv.leaveArt");
    case "volumeUp": return t("tv.volumeUp");
    case "volumeDown": return t("tv.volumeDown");
    case "toggleMute": return t("tv.toggleMute");
    default: return t("action.refresh");
  }
}

export function televisionView(input: TelevisionViewInput, t: Translate, time: FormatTime): TelevisionView {
  const phase = phaseOf(input);
  const document = input.document;
  const actions = document?.actions;
  const readiness: Readiness = phase === "on" || phase === "standby" || phase === "art" || phase === "unknown"
    ? (document?.state.availability ?? input.readiness)
    : phase;
  const powerPending = input.pending !== undefined && TELEVISION_POWER_ACTIONS.includes(input.pending);
  const powerFailed = input.errorControl !== undefined && TELEVISION_POWER_ACTIONS.includes(input.errorControl);
  const refreshPending = input.pending === "getState";
  const refreshFailed = input.errorControl === "getState";
  const artPending = input.pending === "setArtMode";
  const artFailed = input.errorControl === "setArtMode";
  // Art mode is something the set does while it is on, so the power side of the
  // pair reads "on" whether or not art is showing.
  const powerPhase = phase === "art" ? "on" : phase === "standby" ? "off" : phase;

  const powerActions: ActionView<string>[] = [];
  if (actions) {
    for (const id of ["turnOn", "turnOff", "getState"] as const) {
      if (!Object.hasOwn(actions, id)) continue;
      const state = id === "getState"
        ? powerButtonState({ side: "neither", phase: powerPhase, powerPending: refreshPending, powerFailed: refreshFailed })
        : powerButtonState({ side: id === "turnOn" ? "on" : "off", phase: powerPhase, powerPending, powerFailed });
      powerActions.push({ id, label: label(id, t), primary: id === "turnOn", enabled: state !== "checking" && state !== "updating", state });
    }
  }

  const artMode = document?.state.artMode;
  const art: ActionView<string>[] = actions && Object.hasOwn(actions, "setArtMode")
    ? TELEVISION_ART_ACTIONS.map((id) => {
      const side = id === "artOn" ? "on" : "off";
      const state = artState(side, artMode, artPending, artFailed, phase);
      return { id, label: label(id, t), primary: id === "artOn", enabled: state !== "checking" && state !== "updating", state };
    })
    : [];

  const volume: ActionView<string>[] = actions
    ? (["volumeDown", "toggleMute", "volumeUp"] as const)
      .filter((id) => Object.hasOwn(actions, id))
      .map((id) => {
        const pending = input.pending === id;
        const failed = input.errorControl === id;
        // At rest these read as `inactive`, the plain-button state, not
        // `unknown`. `unknown` means "which side is current is unclear", which
        // only a pair like power or art mode can be; volume and mute have no
        // side at all. They still show `updating` and `failure`, which is the
        // part worth seeing — and it keeps them looking like the remote keys
        // beside them, which are the same kind of write-only command.
        const state: ButtonState = phase === "checking" ? "checking" : failed ? "failure" : pending ? "updating" : "inactive";
        return { id, label: label(id, t), primary: false, enabled: state !== "checking" && state !== "updating", state };
      })
    : [];

  const press = actions && Object.hasOwn(actions, "press") ? actions.press : undefined;
  const keys = press && Array.isArray(press.keys) ? press.keys.map(String) : [];

  const setInput = actions && Object.hasOwn(actions, "setInput") ? actions.setInput : undefined;
  const current = document?.state.input?.id;
  const inputs: TelevisionInputView[] = setInput && Array.isArray(setInput.inputs)
    ? setInput.inputs.map((source) => ({ id: source.id, label: source.name ?? source.id, current: source.id === current }))
    : [];

  return {
    phase,
    availability: readinessAvailability(readiness),
    value: wordOf(phase, t),
    detail: readingDetail({ readiness, stale: input.stale, ...(input.fault ? { fault: input.fault } : {}), ...(input.observedAt ? { observedAt: input.observedAt } : {}) }, t, time),
    actions: powerActions,
    art,
    keys,
    volume,
    inputs,
    feedback: feedbackOf({ ...(input.error ? { error: input.error } : {}), ...(input.notice ? { notice: input.notice } : {}) }),
    busy: input.pending !== undefined,
  };
}

export abstract class HtTelevision extends HtElement<Television> {
  #inputsWired = false;

  protected get defaultCapability(): string {
    return "television";
  }

  turnOn(): Promise<boolean> {
    return this.invoke("turnOn");
  }

  turnOff(): Promise<boolean> {
    return this.invoke("turnOff");
  }

  setArtMode(on: boolean): Promise<boolean> {
    return this.invoke("setArtMode", on);
  }

  press(key: string): Promise<boolean> {
    return this.invoke("press", key);
  }

  setInput(id: string): Promise<boolean> {
    return this.invoke("setInput", id);
  }

  refresh(): Promise<boolean> {
    return this.invoke("getState");
  }

  get view(): TelevisionView {
    const frame = this.frame;
    const document = this.document;
    const observedAt = frame?.observedAt ?? document?.state.observedAt;
    const pending = this.pendingControl;
    const errorControl = this.erroredControl;
    const notice = this.notice;
    return televisionView({
      readiness: this.readiness,
      stale: frame?.stale ?? false,
      ...(document ? { document } : {}),
      ...(frame?.fault ? { fault: frame.fault } : {}),
      ...(observedAt ? { observedAt } : {}),
      ...(pending ? { pending } : {}),
      ...(this.error ? { error: this.error } : {}),
      ...(errorControl ? { errorControl } : {}),
      ...(notice ? { notice } : {}),
    }, (key, params) => this.t(key, params), ht.time);
  }

  override connectedCallback(): void {
    if (!this.#inputsWired) {
      this.#inputsWired = true;
      const select = this.partNamed("input") as HTMLSelectElement | null;
      select?.addEventListener("change", () => {
        if (this.pending || !select.value) return;
        void this.setInput(select.value);
      });
    }
    super.connectedCallback();
  }

  protected override onAction(action: string, source: HTMLElement): void {
    switch (action) {
      case "turnOn": void this.turnOn(); break;
      case "turnOff": void this.turnOff(); break;
      case "artOn": void this.setArtMode(true); break;
      case "artOff": void this.setArtMode(false); break;
      case "volumeUp": void this.invoke("volumeUp"); break;
      case "volumeDown": void this.invoke("volumeDown"); break;
      case "toggleMute": void this.invoke("toggleMute"); break;
      case "getState": case "refresh": void this.refresh(); break;
      case "key": {
        const key = source.dataset.key;
        if (key) void this.press(key);
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
    const art = this.partNamed("art");
    if (art) art.hidden = view.art.length === 0;

    const buttons = [...view.actions, ...view.art, ...view.volume];
    for (const button of this.actionButtons()) {
      const action = button.dataset.action;
      if (action === "key") {
        const key = button.dataset.key ?? "";
        const offered = view.keys.includes(key);
        button.hidden = !offered;
        if (offered) button.textContent = this.t(`tv.key.${key}` as Parameters<typeof this.t>[0]);
        continue;
      }
      const item = buttons.find((candidate) => candidate.id === action);
      button.hidden = !item;
      if (!item) continue;
      button.textContent = item.label;
      if (item.enabled) button.removeAttribute("aria-disabled");
      else button.setAttribute("aria-disabled", "true");
      button.dataset.state = item.state;
      if (item.id === "turnOn" || item.id === "turnOff" || item.id === "artOn" || item.id === "artOff") {
        button.setAttribute("aria-pressed", String(item.state === "active"));
      }
      if (item.state === "failure" && view.feedback.message) button.setAttribute("title", view.feedback.message);
      else button.removeAttribute("title");
    }

    const field = this.partNamed("input-field");
    if (field) field.hidden = view.inputs.length === 0;
    const inputLabel = this.partNamed("input-label");
    if (inputLabel) inputLabel.textContent = this.t("tv.input");
    const select = this.partNamed("input") as HTMLSelectElement | null;
    if (select && view.inputs.length > 0) {
      const wanted = JSON.stringify(view.inputs.map((input) => [input.id, input.label]));
      // Options are rewritten only when the set changes them, so an open menu
      // is not rebuilt underneath the person on every frame.
      if (select.dataset.options !== wanted) {
        select.dataset.options = wanted;
        select.textContent = "";
        for (const input of view.inputs) {
          const option = globalThis.document.createElement("option");
          option.value = input.id;
          option.textContent = input.label;
          select.append(option);
        }
      }
      const current = view.inputs.find((input) => input.current);
      if (current && select.value !== current.id) select.value = current.id;
    }

    this.writeFeedback(view.feedback.message, view.feedback.tone);
  }
}
