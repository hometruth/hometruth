/**
 * The binary switch kind: a device's `binarySwitch` capability, or a group
 * switch (`group/<id>`), whose node value is a `GroupSwitch` with the same
 * `capabilities.binarySwitch` shape plus `group.mixed`, `group.canSwitch`,
 * and its members. `switchView()` is the whole state table; `HtBinarySwitch`
 * renders it and maps clicks to the four schema actions.
 *
 * Template contract (parts a themed `<ht-switch>` provides; each optional):
 * - `state`   container; gets `data-phase` and `data-availability`.
 * - `mark`    the status dot; gets `data-availability`.
 * - `value`   the state word (On, Off, Mixed, Offline…); gets `data-value` = on | off | "".
 *             `sr-only` (not visually hidden entirely, for the live region) once the turnOn/turnOff
 *             buttons already say it: On, Off, and Unknown (pressing neither) all read from the buttons.
 * - `detail`  "Read {time}" / "Last read {time}" / a fault's sentence; hidden when empty.
 * - `gaps`    which group members lack which power controls; hidden when empty.
 * - `actions` container of `<button data-action="turnOn|turnOff|toggle|getState">`; a button is
 *             hidden when the document lacks its action, labelled from the catalog, and carries
 *             `data-state` (active | inactive | unknown | checking | updating | failure) — the
 *             template's only signal of status; there is no "Turning on…"/"Checking…" text anywhere.
 * - `feedback` the error, when the last command failed; empty otherwise. Gets `data-tone`.
 * The host also gets `data-phase` and `data-availability` for page CSS.
 */
import type { Availability } from "../../../models/capability.ts";
import type { BinarySwitch } from "../../../schemas.ts";
import type { Fault, GroupSwitch } from "../../../state/protocol.ts";
import { HtElement } from "../element.ts";
import { ht } from "../runtime.ts";
import { type ActionView, type ButtonState, type Feedback, type FormatTime, type Notice, type Readiness, type Translate, feedbackOf, powerButtonState, powerLabel, readinessAvailability, readingDetail } from "../view.ts";

export type SwitchAction = keyof BinarySwitch["actions"];
export const SWITCH_ACTIONS: readonly SwitchAction[] = ["turnOn", "turnOff", "toggle", "getState"];

export type SwitchPhase = "checking" | "gone" | "offline" | "degraded" | "mixed" | "on" | "off" | "unknown";

export interface SwitchViewInput {
  readonly readiness: Readiness;
  /** The switch document; the last good one beside a fault, absent while checking or gone. */
  readonly document?: BinarySwitch;
  readonly fault?: Fault;
  readonly stale: boolean;
  /** Newest successful observation (the frame's, else the document's). */
  readonly observedAt?: string;
  /** Present for a group node. */
  readonly group?: GroupSwitch["group"];
  readonly pending?: SwitchAction;
  readonly error?: string;
  /** Which control the current `error` belongs to; a failure colours only that control's own button(s). */
  readonly errorControl?: SwitchAction;
  readonly notice?: Notice;
}

export interface SwitchView {
  readonly phase: SwitchPhase;
  readonly availability: Availability;
  readonly value: string;
  /** True once the turnOn/turnOff buttons themselves show which side is current, making the value word redundant for on/off/unknown. */
  readonly hasOnOffButtons: boolean;
  readonly detail: string;
  readonly gaps: string;
  readonly actions: readonly ActionView<SwitchAction>[];
  readonly feedback: Feedback;
  readonly busy: boolean;
}

const REQUIREMENTS = ["power.on", "power.turnOn", "power.turnOff", "power.toggle"] as const;

function requirementLabel(id: string, t: Translate): string {
  switch (id) {
    case "power.on": return t("switch.powerState");
    case "power.turnOn": return t("action.on");
    case "power.turnOff": return t("action.off");
    default: return t("action.toggle");
  }
}

function list(ids: readonly string[], type: "conjunction" | "disjunction", t: Translate, locale: string): string {
  const labels = REQUIREMENTS.filter((id) => ids.includes(id)).map((id) => requirementLabel(id, t));
  return typeof Intl.ListFormat === "function" ? new Intl.ListFormat(locale, { type }).format(labels) : labels.join(", ");
}

/** One sentence naming what keeps a group from being a switch; empty when every member qualifies. */
export function switchGaps(group: GroupSwitch["group"], t: Translate, locale: string): string {
  const short = group.members.filter((member) => member.missingForSwitch?.length);
  if (short.length === 0) return "";
  const controls = [...new Set(short.flatMap((member) => member.missingForSwitch ?? []))];
  return t("switch.notSharedBy", { controls: list(controls, "conjunction", t, locale), count: short.length, total: group.members.length });
}

function phaseOf(input: SwitchViewInput): SwitchPhase {
  if (input.readiness === "checking" || input.readiness === "gone") return input.readiness;
  if (input.fault) return "offline";
  const availability = input.document?.state.availability ?? input.readiness;
  if (availability === "offline") return "offline";
  if (availability === "degraded") return "degraded";
  if (input.group?.mixed) return "mixed";
  const value = input.document?.state.value;
  return value === "on" ? "on" : value === "off" ? "off" : "unknown";
}

/** The state word for a phase no button can say: buttons already say on/off/checking/unknown themselves. */
function wordOf(phase: SwitchPhase, t: Translate): string {
  switch (phase) {
    case "mixed": return t("grouping.mixed");
    case "gone": return t("state.gone");
    default: return "";
  }
}

export function switchView(input: SwitchViewInput, t: Translate, time: FormatTime, locale = "en"): SwitchView {
  const phase = phaseOf(input);
  // A reading (or its absence) colours the mark with the device's own availability; the other phases are the mark.
  const readiness: Readiness = phase === "on" || phase === "off" || phase === "mixed" || phase === "unknown" ? (input.document?.state.availability ?? input.readiness) : phase;
  const powerPending = input.pending !== undefined && input.pending !== "getState";
  const powerFailed = input.error !== undefined && input.errorControl !== undefined && input.errorControl !== "getState";
  const refreshPending = input.pending === "getState";
  const refreshFailed = input.error !== undefined && input.errorControl === "getState";
  const canSwitch = input.group?.canSwitch ?? true;
  const actions = input.document
    ? SWITCH_ACTIONS.filter((id) => Object.hasOwn(input.document!.actions, id)).map((id): ActionView<SwitchAction> => {
      const side = id === "turnOn" ? "on" : id === "turnOff" ? "off" : "neither";
      const state = id === "getState"
        ? powerButtonState({ side: "neither", phase, powerPending: refreshPending, powerFailed: refreshFailed })
        : powerButtonState({ side, phase, powerPending, powerFailed });
      return {
        id,
        label: powerLabel(id, t),
        primary: id === "turnOn",
        enabled: state !== "checking" && state !== "updating" && (canSwitch || id === "getState"),
        state,
      };
    })
    : [];
  return {
    phase,
    availability: readinessAvailability(readiness),
    value: wordOf(phase, t),
    hasOnOffButtons: actions.some((action) => action.id === "turnOn") && actions.some((action) => action.id === "turnOff"),
    detail: readingDetail({ readiness, stale: input.stale, ...(input.fault ? { fault: input.fault } : {}), ...(input.observedAt ? { observedAt: input.observedAt } : {}) }, t, time),
    gaps: input.group ? switchGaps(input.group, t, locale) : "",
    actions,
    feedback: feedbackOf({ ...(input.error ? { error: input.error } : {}), ...(input.notice ? { notice: input.notice } : {}) }),
    busy: input.pending !== undefined,
  };
}

export abstract class HtBinarySwitch extends HtElement<BinarySwitch> {
  protected get defaultCapability(): string {
    return "binarySwitch";
  }

  /** The group half of a `group/<id>` value; undefined for a device. */
  get group(): GroupSwitch["group"] | undefined {
    return this.node?.startsWith("group/") ? (this.value as GroupSwitch | undefined)?.group : undefined;
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

  /** `getState`: the schema declares it, so it renders as the last, non-primary button. */
  refresh(): Promise<boolean> {
    return this.invoke("getState");
  }

  get view(): SwitchView {
    const frame = this.frame;
    const document = this.document;
    const group = this.group;
    const observedAt = frame?.observedAt ?? document?.state.observedAt;
    const pending = this.pendingControl;
    const errorControl = this.erroredControl;
    const notice = this.notice;
    return switchView({
      readiness: this.readiness,
      stale: frame?.stale ?? false,
      ...(document ? { document } : {}),
      ...(frame?.fault ? { fault: frame.fault } : {}),
      ...(observedAt ? { observedAt } : {}),
      ...(group ? { group } : {}),
      ...(pending && (SWITCH_ACTIONS as readonly string[]).includes(pending) ? { pending: pending as SwitchAction } : {}),
      ...(this.error ? { error: this.error } : {}),
      ...(errorControl && (SWITCH_ACTIONS as readonly string[]).includes(errorControl) ? { errorControl: errorControl as SwitchAction } : {}),
      ...(notice ? { notice } : {}),
    }, (key, params) => this.t(key, params), ht.time, ht.locale);
  }

  protected override onAction(action: string): void {
    switch (action) {
      case "turnOn": void this.turnOn(); break;
      case "turnOff": void this.turnOff(); break;
      case "toggle": void this.toggle(); break;
      case "getState": case "refresh": void this.refresh(); break;
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
      value.dataset.value = view.phase === "on" || view.phase === "off" ? view.phase : "";
      // The turnOn/turnOff buttons already carry on/off/checking/unknown as their own state; the word would only repeat it — and there is never a word for a phase they can say.
      value.hidden = !view.value;
    }
    const detail = this.partNamed("detail");
    if (detail) {
      detail.textContent = view.detail;
      detail.hidden = !view.detail;
    }
    const gaps = this.partNamed("gaps");
    if (gaps) {
      gaps.textContent = view.gaps;
      gaps.hidden = !view.gaps;
    }
    for (const button of this.actionButtons()) {
      const action = view.actions.find((item) => item.id === button.dataset.action);
      button.hidden = !action;
      if (!action) continue;
      button.textContent = action.label;
      if (action.enabled) button.removeAttribute("aria-disabled");
      else button.setAttribute("aria-disabled", "true");
      button.dataset.state = action.state;
      // On/Off read as pressed on the side that is the verified setting; a group split, an unread value, or a command in flight presses neither.
      if (action.id === "turnOn" || action.id === "turnOff") button.setAttribute("aria-pressed", String(action.state === "active"));
      // The failure itself is the button's state; its sentence is there for a screen reader or a hover, not as a line of standing text.
      if (action.state === "failure" && view.feedback.message) button.setAttribute("title", view.feedback.message);
      else button.removeAttribute("title");
    }
  }
}
