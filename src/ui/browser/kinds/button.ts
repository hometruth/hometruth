/**
 * The button kind: a stateless `press`, held for a bounded duration when the
 * document's `actions.press.maximumDurationMs` allows it. The document has
 * no state, so readiness comes from the object's own `status`.
 *
 * Template contract (parts a themed `<ht-button>` provides; each optional):
 * - `state`      container; gets `data-phase` and `data-availability`. No dot: the Press button's
 *                own `data-state` (checking | unknown | updating | failure — a press has no
 *                active/inactive side) is the only status.
 * - `value`      the phase word, shown only for a phase the button can't say (Offline, "No longer configured…").
 * - `detail`     a fault's sentence or "Last read {time}"; hidden when empty.
 * - `hold-field` the hold control's container; hidden unless holding is allowed.
 * - `hold`       `<input type="number">` in seconds; `max` follows the document.
 * - `actions`    container of `<button data-action="press">`, labelled from the catalog, carrying `data-state`.
 * - `feedback`   the error, when the last press failed; empty otherwise.
 */
import type { Availability } from "../../../models/capability.ts";
import type { Button } from "../../../schemas.ts";
import type { Fault } from "../../../state/protocol.ts";
import { HtElement } from "../element.ts";
import { ht } from "../runtime.ts";
import { type ActionView, type ButtonState, type Feedback, type FormatTime, type Notice, type Readiness, type Translate, feedbackOf, readinessAvailability, readinessWord, readingDetail } from "../view.ts";

export type ButtonAction = keyof Button["actions"];
export type ButtonPhase = "checking" | "gone" | "offline" | "degraded" | "ready";

export interface ButtonViewInput {
  readonly readiness: Readiness;
  readonly document?: Button;
  readonly fault?: Fault;
  readonly stale: boolean;
  readonly observedAt?: string;
  readonly pending: boolean;
  readonly error?: string;
  readonly notice?: Notice;
}

export interface ButtonView {
  readonly phase: ButtonPhase;
  readonly availability: Availability;
  readonly value: string;
  readonly detail: string;
  /** Present iff the document allows holding; seconds, for the number input. */
  readonly hold?: { readonly maximumSeconds: number };
  readonly actions: readonly ActionView<ButtonAction>[];
  readonly feedback: Feedback;
  readonly busy: boolean;
}

function phaseOf(input: ButtonViewInput): ButtonPhase {
  if (input.readiness === "checking" || input.readiness === "gone") return input.readiness;
  if (input.fault || input.readiness === "offline") return "offline";
  if (input.readiness === "degraded") return "degraded";
  return "ready";
}

/** Press has no side of its own — checking, a command in flight, and a failure are the only states it can show. */
function pressState(phase: ButtonPhase, pending: boolean, failed: boolean): ButtonState {
  if (phase === "checking") return "checking";
  if (failed) return "failure";
  if (pending) return "updating";
  return "unknown";
}

export function buttonView(input: ButtonViewInput, t: Translate, time: FormatTime): ButtonView {
  const phase = phaseOf(input);
  const readiness: Readiness = phase === "ready" ? input.readiness : phase;
  const maximum = input.document?.actions.press.maximumDurationMs;
  const canPress = input.document !== undefined && phase !== "offline" && phase !== "gone" && phase !== "checking";
  const failed = input.error !== undefined && !input.pending;
  const state = pressState(phase, input.pending, failed);
  return {
    phase,
    availability: readinessAvailability(readiness),
    // The button itself says checking/ready/pressing/failed; the word is only for a phase it can't (Offline, gone).
    value: phase === "offline" || phase === "degraded" || phase === "gone" ? readinessWord(phase, t) : "",
    detail: readingDetail({ readiness, stale: input.stale, ...(input.fault ? { fault: input.fault } : {}), ...(input.observedAt ? { observedAt: input.observedAt } : {}) }, t, time),
    ...(typeof maximum === "number" ? { hold: { maximumSeconds: maximum / 1000 } } : {}),
    actions: input.document ? [{ id: "press", label: t("button.press"), primary: true, enabled: !input.pending && canPress, state }] : [],
    feedback: feedbackOf({ ...(input.error ? { error: input.error } : {}), ...(input.notice ? { notice: input.notice } : {}) }),
    busy: input.pending,
  };
}

export abstract class HtButton extends HtElement<Button> {
  protected get defaultCapability(): string {
    return "button";
  }

  /** Press once, or hold for `durationMs` when the document allows it. */
  press(durationMs?: number): Promise<boolean> {
    return this.invoke("press", durationMs === undefined ? undefined : { durationMs });
  }

  get view(): ButtonView {
    const frame = this.frame;
    const document = this.document;
    const notice = this.notice;
    return buttonView({
      readiness: this.readiness,
      stale: frame?.stale ?? false,
      pending: this.pending,
      ...(document ? { document } : {}),
      ...(frame?.fault ? { fault: frame.fault } : {}),
      ...(frame?.observedAt ? { observedAt: frame.observedAt } : {}),
      ...(this.error ? { error: this.error } : {}),
      ...(notice ? { notice } : {}),
    }, (key, params) => this.t(key, params), ht.time);
  }

  protected override onAction(action: string): void {
    if (action !== "press") return;
    const hold = this.view.hold ? this.partNamed("hold") as HTMLInputElement | null : null;
    const seconds = hold ? Number(hold.value || 0) : 0;
    void this.press(hold ? Math.round(seconds * 1000) : undefined);
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
    const field = this.partNamed("hold-field");
    if (field) field.hidden = !view.hold;
    const hold = this.partNamed("hold") as HTMLInputElement | null;
    if (hold && view.hold) hold.max = String(view.hold.maximumSeconds);
    for (const button of this.actionButtons()) {
      const action = view.actions.find((item) => item.id === button.dataset.action);
      button.hidden = !action;
      if (!action) continue;
      button.textContent = action.label;
      if (action.enabled) button.removeAttribute("aria-disabled");
      else button.setAttribute("aria-disabled", "true");
      button.dataset.state = action.state;
      if (action.state === "failure" && view.feedback.message) button.setAttribute("title", view.feedback.message);
      else button.removeAttribute("title");
    }
  }
}
