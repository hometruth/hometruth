/**
 * What every kind's view function shares: the readiness ladder a frame puts
 * an element on, the detail line that says how current a reading is, and the
 * feedback line that overlays a pending command or its error. Pure, so the
 * per-kind view tables stay small and each rule is decided once.
 */
import type { Availability } from "../../models/capability.ts";
import type { Fault } from "../../state/protocol.ts";
import type { Tone, Translate } from "./runtime.ts";

export type { Translate } from "./runtime.ts";
export type FormatTime = (value: string | number | Date) => string;
export type FormatNumber = (value: number, options?: Intl.NumberFormatOptions) => string;

/** `checking` before the first frame, `gone` when the node left the site, else the document's availability. */
export type Readiness = "checking" | Availability | "gone";

/**
 * Beyond this a record stops being what something is doing and becomes what it
 * was last seen doing, so it must not be presented as current.
 *
 * Kept here as well as in `src/state/persistence.ts` because browser modules
 * may not import values from outside their own two folders; a test holds the
 * two equal. The distinction matters because a page seed is seconds old while a
 * record restored from disk after a restart can be days old, and both arrive
 * through the same path.
 */
export const COLD_AFTER_MS = 60_000;

/** True when a record is too old to stand for the present. */
export function isCold(observedAt: string | undefined, now: number): boolean {
  if (!observedAt) return true;
  const seen = Date.parse(observedAt);
  return !Number.isFinite(seen) || now - seen > COLD_AFTER_MS;
}

/** A transient confirmation an element keeps until the next command or error. */
export interface Notice {
  readonly message: string;
  readonly tone?: Tone;
}

export interface Feedback {
  readonly message: string;
  readonly tone?: Tone;
}

/**
 * What a control button looks like, with no text of its own: `active` is the
 * current verified setting, `inactive` a setting that is not, `unknown` when
 * the true side is unclear (nothing read yet, or a group split across
 * members), `checking` before the first frame, `updating` while a command
 * that would decide this button's own side is in flight, `failure` right
 * after such a command errors.
 */
export type ButtonState = "active" | "inactive" | "unknown" | "checking" | "updating" | "failure";

/** What the mark and the state word say for a readiness that is not a live reading. */
export function readinessWord(readiness: Readiness, t: Translate): string {
  switch (readiness) {
    case "checking": return t("status.checking");
    case "gone": return t("state.gone");
    case "online": return t("status.online");
    case "offline": return t("status.offline");
    case "degraded": return t("status.degraded");
    case "unknown": return t("status.unknown");
  }
}

/** The mark colour for a readiness: nothing to say reads as unknown. */
export function readinessAvailability(readiness: Readiness): Availability {
  return readiness === "checking" || readiness === "gone" ? "unknown" : readiness;
}

export interface DetailInput {
  readonly readiness: Readiness;
  readonly fault?: Fault;
  /** The record has not been confirmed by the stream in this connection. */
  readonly stale: boolean;
  /** Newest successful observation, ISO. */
  readonly observedAt?: string;
}

/**
 * The small line under the state word: a fault's own sentence, "Last read"
 * for anything unconfirmed, "Read" for a live reading, "Not reachable" for a
 * device that answered offline, nothing while checking.
 *
 * "Last read" comes before the checking case, because a record can be both: too
 * old to stand for the present, yet with a known time it was last seen. Saying
 * when is the whole point of not presenting it as current.
 */
export function readingDetail(input: DetailInput, t: Translate, time: FormatTime): string {
  if (input.fault && input.readiness !== "checking") return input.fault.message;
  if (input.stale && input.observedAt) return t("state.stale", { time: time(input.observedAt) });
  if (input.readiness === "checking") return "";
  if (input.fault) return input.fault.message;
  if (input.stale) return "";
  if (input.readiness === "offline") return t("status.notReachable");
  return input.observedAt ? t("status.readAt", { time: time(input.observedAt) }) : "";
}

export interface FeedbackInput {
  readonly error?: string;
  readonly notice?: Notice;
}

/** An error outranks a kept confirmation; a command in flight has no sentence of its own (its button carries `updating`). */
export function feedbackOf(input: FeedbackInput): Feedback {
  if (input.error) return { message: input.error, tone: "bad" };
  if (input.notice) return input.notice.tone ? { message: input.notice.message, tone: input.notice.tone } : { message: input.notice.message };
  return { message: "" };
}

export interface ActionView<Id extends string = string> {
  readonly id: Id;
  readonly label: string;
  /** The one action a template may style as primary. */
  readonly primary: boolean;
  readonly enabled: boolean;
  readonly state: ButtonState;
}

/** The catalog label of a power control; the schema names them, the owner named the words. */
export function powerLabel(controlId: string, t: Translate): string {
  switch (controlId) {
    case "turnOn": return t("action.on");
    case "turnOff": return t("action.off");
    case "toggle": return t("action.toggle");
    default: return t("action.refresh");
  }
}

export interface PowerButtonStateInput {
  /** `on` when this button's own side is the current value, `off` the other side, `neither` for toggle/refresh. */
  readonly side: "on" | "off" | "neither";
  readonly phase: "on" | "off" | "mixed" | "unknown" | "checking" | "gone" | "offline" | "degraded";
  /** True once a power command (`turnOn`/`turnOff`/`toggle`) is in flight — every power button shares this, since they all read and write the same value. */
  readonly powerPending: boolean;
  readonly powerFailed: boolean;
}

/**
 * A power button's own visual state. `turnOn`/`turnOff`/`toggle` all decide
 * the same property, so while any of them is in flight or has just failed,
 * all three show it; `getState`/`refresh` reads a different question (is the
 * reading current) and keeps its own state, computed the same way with
 * `side: "neither"` and its own pending/failed flags.
 */
export function powerButtonState(input: PowerButtonStateInput): ButtonState {
  if (input.phase === "checking") return "checking";
  if (input.powerFailed) return "failure";
  if (input.powerPending) return "updating";
  if (input.side === "neither") return "unknown";
  if (input.phase === "mixed" || input.phase === "unknown" || input.phase === "gone" || input.phase === "offline" || input.phase === "degraded") return "unknown";
  return input.phase === input.side ? "active" : "inactive";
}
