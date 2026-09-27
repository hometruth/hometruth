/**
 * The browser runtime the shell's inline script installs as `window.ht`
 * (see `CLIENT_RUNTIME` in `../shell.ts`), typed for the modules under this
 * folder. Modules read it through here so the runtime can stay an inline
 * classic script while components are real modules; a test installs a fake
 * `window.ht` (see `test-dom.ts`) before importing anything that uses it.
 */
import type { MessageKey } from "../i18n/en.ts";
export type { MessageKey } from "../i18n/en.ts";
import type { StateClient } from "./state.ts";

export type MessageParams = Readonly<Record<string, string | number>>;

/**
 * Keys this change adds to the catalog (`summaryOf` and the light kind need
 * them); the integrator lands them in all four locales, after which this
 * union is a subset of `MessageKey` and can go.
 */
export type AddedKey =
  | "summary.button"
  | "summary.reading"
  | "summary.lights"
  | "summary.notDiscovered"
  | "summary.discovered"
  | "summary.ready"
  | "summary.readyToListen"
  | "summary.bondedTo"
  | "summary.someUnavailable"
  | "summary.battery"
  | "summary.accessories"
  | "light.kelvin";

export type Key = MessageKey | AddedKey;
export type Translate = (key: Key, params?: MessageParams) => string;
export type Tone = "ok" | "bad";

export interface HtRuntime {
  readonly t: Translate;
  readonly locale: string;
  /** `Intl` time (`timeStyle: "medium"`) for an ISO string, epoch, or Date. */
  readonly time: (value: string | number | Date) => string;
  readonly dateTime: (value: string | number | Date) => string;
  /** "5 minutes ago", from `Intl.RelativeTimeFormat`, against the clock at the moment it is called. */
  readonly relativeTime: (value: string | number | Date) => string;
  readonly number: (value: number, options?: Intl.NumberFormatOptions) => string;
  /** The catalog word for an availability; anything unrecognised reads as unknown. */
  readonly availability: (value: unknown) => string;
  /** Same-origin JSON request; rejects with the API's `error.message`. */
  readonly request: (url: string, init?: RequestInit) => Promise<unknown>;
  readonly say: (element: unknown, message: string, tone?: Tone) => void;
  /**
   * Mark an element as showing a value the state graph delivered, stamped with that record's
   * freshness: the live ink and the hover both read it. Every displayed state value goes
   * through this, so neither is something a page can half-do.
   */
  readonly live: <T>(element: T, observedAt: string | undefined) => T;
  readonly errorOf: (payload: unknown, fallback: string) => string;
  /** The page's state client, installed by the theme entry before it defines any element. */
  state?: StateClient;
}

export const ht: HtRuntime = (window as unknown as { ht: HtRuntime }).ht;
