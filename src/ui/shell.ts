import { TAG_CSS, TAG_EDITOR_SCRIPT } from "./tag-editor";
import { runtimeUpdateScript } from "./runtime-update";
import { renderStateSnapshot } from "./state-snapshot";
import { activeApiTab, pageStateHref, PAGE_STATE_SCRIPT, PAGE_DISCLOSURE_SCRIPT } from "./page-state";
/**
 * The one page shell every HomeTruth page renders through: document
 * skeleton, the active theme's tokens in light and dark, the component
 * vocabulary, the site header and footer, and the browser runtime
 * (`window.ht`) that scripts use for messages, formatting, and requests.
 */
import type { CapabilityKind } from "../models/capability";
import { schemaLink } from "../schema-catalog";
import type { RegisteredDevice } from "../site";
import type { NodeId, NodeRecord } from "../state/protocol";
import { FORMAT_MESSAGE_JS, LOCALE_NAMES, SUPPORTED_LOCALES, type Translator } from "./i18n";
import { PREFERENCES_PATH, SCHEMES, THEMES, type Scheme, type Theme, type UiPreferences } from "./preferences";
import { scaleCss, themeById, themeCss } from "./themes";

/** What a page may read from the state graph at render time: cached records only, never a device read. */
export interface PageState {
  snapshot(nodes: readonly NodeId[]): readonly NodeRecord[];
}

/** The tags a theme's browser entry defines; a page composes device views from these. */
export type HtTag = "ht-switch" | "ht-switch-row" | "ht-button" | "ht-light" | "ht-status" | "ht-sensor" | "ht-sensor-row" | "ht-television";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Everything a page needs from the request: who is looking, in what language, at what path. */
export interface PageContext {
  readonly nonce: string;
  readonly siteTitle: string;
  readonly i18n: Translator;
  readonly theme: Theme;
  readonly scheme: Scheme;
  /** The request path and query, so navigation and preferences preserve the view. */
  readonly path: string;
  /** Which optional site features exist, and whether this caller may administer, for the primary navigation. */
  readonly features: { readonly isolation: boolean; readonly admin: boolean };
  /** The graph's cached records, embedded as `#ht-state` so components paint real state before the stream connects. */
  readonly state: PageState;
  /** The worker generation, used as the cache key in browser module URLs. */
  readonly assetVersion: string;
  readonly rooms?: readonly string[];
  readonly tagEditor?: (key?: string) => string;
  readonly elementApi?: () => { body: string; tabs: string; css: string; script: string } | undefined;
}

export type NavItem = "health" | "devices" | "switches" | "groups" | "buttons" | "automations" | "events" | "services" | "network" | "schemas" | "api" | "kindle" | "tags" | "tokens";

export interface PageOptions {
  readonly ctx: PageContext;
  /** The document title, without the site name. Empty for a page that has no name of its own. */
  readonly title: string;
  /** The primary navigation item this page belongs to. */
  readonly nav?: NavItem;
  readonly body: string;
  readonly css?: string;
  readonly script?: string;
  /** Message prefixes the page's script needs (`ht.t("…")`). */
  readonly messages?: readonly string[];
  /** Attributes on `<main>`, already escaped. */
  readonly mainAttributes?: string;
  readonly wide?: boolean;
  /** A page reached before sign-in: no navigation, live state connection, or runtime notices. */
  readonly bare?: boolean;
  /** The graph nodes the page's `ht-*` elements are bound to; their cached records are embedded as `#ht-state`. */
  readonly nodes?: readonly NodeId[];
}

export const CLIENT_RUNTIME = String.raw`
  ${FORMAT_MESSAGE_JS}
  window.ht = (() => {
    const node = document.getElementById("ht-messages");
    const messages = node ? JSON.parse(node.textContent || "{}") : {};
    const locale = document.documentElement.lang || "en";
    const t = (key, params) => formatMessage(messages[key] === undefined ? key : messages[key], params, locale);
    const time = (value) => new Intl.DateTimeFormat(locale, { timeStyle: "medium" }).format(new Date(value));
    const dateTime = (value) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
    const number = (value, options) => new Intl.NumberFormat(locale, options).format(value);
    const RELATIVE = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60], ["second", 1]];
    // Five minutes ago, in the page's language. Computed from the stamp against the clock at the
    // moment it is asked for, which is the only reason nothing here needs a timer.
    const relativeTime = (value) => {
      const at = new Date(value).getTime();
      if (!Number.isFinite(at)) return "";
      const seconds = Math.round((at - Date.now()) / 1000);
      const size = Math.abs(seconds);
      const format = new Intl.RelativeTimeFormat(locale, { numeric: size < 10 ? "auto" : "always" });
      const step = RELATIVE.find(([, span]) => size >= span) || RELATIVE[RELATIVE.length - 1];
      return format.format(Math.round(seconds / step[1]), step[0]);
    };
    const availability = (value) => t("status." + (value === "online" || value === "offline" || value === "degraded" ? value : "unknown"));
    const errorOf = (payload, fallback) => payload && payload.error && payload.error.message ? payload.error.message : fallback;
    const request = async (url, init) => {
      const response = await fetch(url, Object.assign({ cache: "no-store", credentials: "same-origin" }, init || {}, {
        headers: Object.assign({ accept: "application/json" }, init && init.body ? { "content-type": "application/json" } : {}, init && init.headers ? init.headers : {}),
      }));
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorOf(payload, t("feedback.requestFailed")));
      return payload;
    };
    /*
     * Mark an element as showing a value the state graph delivered, stamped with the freshness the
     * graph put on that record. Everything that displays state goes through here: it is what gives
     * the value its live ink and what the hover reads, so neither is a thing a page has to
     * remember to do twice. Passing no stamp clears the mark, which is the honest state for a cell
     * whose record has not arrived.
     */
    const live = (element, observedAt) => {
      if (!(element instanceof Element)) return element;
      if (observedAt) element.setAttribute("data-live", observedAt);
      else element.removeAttribute("data-live");
      return element;
    };
    const say = (element, message, tone) => {
      if (!(element instanceof HTMLElement)) return;
      element.textContent = message || "";
      if (tone) element.dataset.tone = tone; else delete element.dataset.tone;
    };
    const prefs = document.querySelector("form[data-preferences]");
    if (prefs instanceof HTMLFormElement) {
      const submit = prefs.querySelector("button[type=submit]");
      if (submit instanceof HTMLElement) submit.hidden = true;
      prefs.addEventListener("change", () => prefs.requestSubmit());
    }
    // No row ever shows a dot: a live view with no button of its own (ht-status) says its state by
    // recolouring the row's own name, so this mirrors the view's availability onto the row it sits in.
    document.addEventListener("ht:frame", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target.tagName.toLowerCase() !== "ht-status") return;
      const row = target.closest(".row");
      if (!(row instanceof HTMLElement)) return;
      const availability = target.dataset.availability;
      if (availability) row.dataset.availability = availability;
      else delete row.dataset.availability;
    });
    /*
     * The freshness stamp on hover. One tooltip for the whole page, filled from whichever
     * data-live element the pointer is over — including one inside a shadow root, which is why the
     * target comes from composedPath() rather than event.target (retargeting would only ever name
     * the host). Nothing is scheduled: an age nobody is looking at is not computed.
     */
    let tip;
    const hideTip = () => { if (tip) tip.hidden = true; };
    const showTip = (target) => {
      const at = target.getAttribute("data-live");
      if (!at) return hideTip();
      if (!tip) {
        tip = document.createElement("div");
        tip.id = "ht-live-tip";
        tip.setAttribute("role", "tooltip");
        tip.hidden = true;
        tip.append(document.createElement("b"), document.createElement("span"));
        document.body.append(tip);
      }
      tip.firstChild.textContent = relativeTime(at);
      tip.lastChild.textContent = dateTime(at);
      tip.hidden = false;
      // Above the value by preference, below it when there is no room; clamped inside the viewport.
      const anchor = target.getBoundingClientRect();
      const box = tip.getBoundingClientRect();
      const gap = 8;
      const top = anchor.top - box.height - gap;
      tip.style.insetBlockStart = (top < gap ? anchor.bottom + gap : top) + "px";
      tip.style.insetInlineStart = Math.max(gap, Math.min(anchor.left, document.documentElement.clientWidth - box.width - gap)) + "px";
    };
    const liveUnder = (event) => {
      for (const node of event.composedPath()) {
        if (node instanceof Element && node.hasAttribute("data-live")) return node;
      }
      return undefined;
    };
    document.addEventListener("pointerover", (event) => {
      const target = liveUnder(event);
      if (target) showTip(target); else hideTip();
    });
    document.addEventListener("pointerdown", hideTip);
    document.addEventListener("keydown", (event) => { if (event.key === "Escape") hideTip(); });
    window.addEventListener("scroll", hideTip, { passive: true, capture: true });
    return { t, locale, time, dateTime, relativeTime, number, availability, request, say, errorOf, live };
  })();
`;

/** The component vocabulary. Every colour is a token; theme character lives in each theme's own `character` CSS. */
const COMPONENTS_CSS = String.raw`
  *, *::before, *::after { box-sizing: border-box; }
  html { background: var(--bg); color: var(--fg); font: var(--text)/1.5 var(--font-body); -webkit-text-size-adjust: 100%; scrollbar-color: var(--fg-2) transparent; }
  body { margin: 0; min-height: 100svh; display: flex; flex-direction: column; }
  ::selection { background: var(--accent); color: var(--accent-fg); }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  a { color: var(--accent); text-decoration-thickness: 1px; text-underline-offset: .15em; }
  a:hover { text-decoration-thickness: 2px; }
  h1, h2, h3 { margin: 0; font-weight: 400; line-height: 1.2; text-wrap: balance; }
  h1 { font-size: 1.75rem; letter-spacing: -.01em; margin-block: var(--s5) var(--s5); }
  h2 { font-size: 1rem; margin-block: var(--s6) var(--s3); padding-block-end: var(--s1); border-block-end: var(--rule-w) solid var(--rule); }
  h2:first-child { margin-block-start: 0; }
  section + section, section + details, details + section { margin-block-start: var(--s6); }
  h2 + .rows, h2 + .kv, h2 + .events, h2 + .cap-list { border-block-start: 0; }
  h3 { font-size: 1rem; margin-block: var(--s4) var(--s2); color: var(--fg-2); }
  p { margin: 0 0 var(--s3); max-width: var(--measure); }
  p:last-child { margin-block-end: 0; }
  code, .mono { font-family: var(--font-mono); font-size: .875em; }
  small, .small { font-size: .875rem; }
  .muted { color: var(--fg-2); }
  .num { font-variant-numeric: tabular-nums; }

  /*
   * Live state. A value carrying data-live came from the state graph and is pushed here the
   * moment the server learns it changed; its attribute is the freshness stamp the graph put on
   * the record. It takes its own ink so what the house is doing is distinguishable at a glance
   * from what it was merely configured to be, and hovering one says how old that reading is.
   *
   * Colour is the whole signal here, so it never carries meaning by itself: the value's own words
   * stay the content, the mark and word still say availability, and the stamp is on hover.
   */
  /*
   * The attribute is written twice on purpose. Live ink has to outrank the ordinary ink a value
   * inherits from its container (.field-value output and friends), or it never shows; it must
   * still lose to a colour that says something stronger about the same value, which is why the
   * kinds' own offline/mixed rules are written as descendants and win on their own specificity.
   * The order is: fault colour, then live ink, then plain ink.
   */
  [data-live][data-live] { color: var(--live); font-variant-numeric: tabular-nums; }
  [data-live]:hover { cursor: help; }
  #ht-live-tip {
    position: fixed; inset-block-start: 0; inset-inline-start: 0; z-index: 60; max-width: 20rem;
    padding: var(--s2) var(--s3); background: var(--bg); border: var(--rule-w) solid var(--rule);
    border-radius: var(--radius); box-shadow: var(--shadow);
    font-size: .8125rem; line-height: 1.35; pointer-events: none;
  }
  #ht-live-tip b { display: block; color: var(--live); font-weight: inherit; font-variant-numeric: tabular-nums; }
  #ht-live-tip span { display: block; color: var(--fg-2); font-variant-numeric: tabular-nums; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  [hidden] { display: none !important; }
  .runtime-connection { width: min(var(--page), calc(100% - var(--s6))); margin: var(--s7) auto; }
  .runtime-connection h1 { color: var(--bad); }

  main { width: min(var(--page), calc(100% - var(--s6))); margin-inline: auto; padding-block: 0 var(--s7); flex: 1; }
  main[data-wide] { width: min(var(--page-wide), calc(100% - var(--s6))); }
  @media (max-width: 40rem) { main, main[data-wide] { width: calc(100% - var(--s4) * 2); } }

  .site-head { width: min(var(--page-wide), calc(100% - var(--s6))); margin-inline: auto; display: flex; align-items: baseline; justify-content: space-between; gap: var(--s4); flex-wrap: wrap; padding-block: var(--s4) var(--s3); border-block-end: var(--rule-w) solid var(--rule); }
  @media (max-width: 40rem) { .site-head { width: calc(100% - var(--s4) * 2); } }
  .brand { color: var(--fg); font-weight: 600; text-decoration: none; }
  .site-nav { display: flex; gap: var(--s4); flex-wrap: wrap; }
  .site-nav a { color: var(--fg-2); text-decoration: none; }
  .site-nav a:hover, .site-nav a:focus-visible { color: var(--fg); text-decoration: underline; }
  .site-nav a[aria-current="page"] { color: var(--fg); font-weight: 600; }

  .site-foot { width: min(var(--page-wide), calc(100% - var(--s6))); margin-inline: auto; display: flex; gap: var(--s4); align-items: center; flex-wrap: wrap; padding-block: var(--s3) var(--s5); border-block-start: var(--rule-w) solid var(--rule); color: var(--fg-2); font-size: .875rem; }
  @media (max-width: 40rem) { .site-foot { width: calc(100% - var(--s4) * 2); } }
  .site-foot form { display: flex; gap: var(--s3); flex-wrap: wrap; align-items: center; margin-inline-start: auto; }
  .site-foot label { display: inline-flex; gap: var(--s2); align-items: center; }
  .site-foot select { padding: .15rem .35rem; font-size: .875rem; }

  .page-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--s4); flex-wrap: wrap; }
  .page-head h1 { min-width: 0; overflow-wrap: anywhere; }
  .device-relations { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--s1) var(--s4); margin-block-end: var(--s3); }
  .device-relations > p { margin: 0; max-width: none; }

  .mark { display: inline-block; width: var(--mark); height: var(--mark); border-radius: var(--mark-radius); background: var(--fg-2); opacity: .5; flex: none; vertical-align: middle; transition: background var(--motion), opacity var(--motion); }
  .mark[data-availability="online"], .mark[data-availability="available"] { background: var(--ok); opacity: 1; }
  .mark[data-availability="offline"], .mark[data-availability="unavailable"] { background: var(--bad); opacity: 1; }
  .mark[data-availability="degraded"], .mark[data-availability="connecting"] { background: var(--warn-mark); opacity: 1; }
  .mark[data-availability="connecting"] { animation: ht-pulse 1.4s infinite; }
  @keyframes ht-pulse { 50% { opacity: .35; } }
  .status { display: inline-flex; align-items: center; gap: var(--s2); color: var(--fg-2); }
  .status[data-availability="offline"] { color: var(--bad); }

  .rows { list-style: none; margin: 0; padding: 0; border-block-start: var(--rule-w) solid var(--rule); }
  .row { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: var(--s4); row-gap: var(--s1); align-items: center; padding-block: var(--s3); border-block-end: 1px solid var(--hair); color: inherit; text-decoration: none; }
  a.row:hover .row-name, a.row:focus-visible .row-name { text-decoration: underline; text-decoration-thickness: 1.5px; text-underline-offset: .15em; }
  a.row:focus-visible { outline-offset: -2px; }
  .row-name { grid-column: 1; font-size: 1.0625rem; overflow-wrap: anywhere; transition: color var(--motion); }
  .row-name a { color: inherit; text-decoration-thickness: 1px; }
  .row-name a:hover, .row-name a:focus-visible { text-decoration-thickness: 1.5px; }
  /* A row with no button of its own says its state on its own name, never a dot: muted while unread, red once it fails to answer. */
  .row[data-availability="unknown"] .row-name, .row[data-availability="connecting"] .row-name { color: var(--fg-2); }
  .row[data-availability="offline"] .row-name, .row[data-availability="unavailable"] .row-name { color: var(--bad); }
  .row-meta { grid-column: 1; color: var(--fg-2); font-size: .875rem; overflow-wrap: anywhere; }
  .row-side { grid-column: 2; grid-row: 1 / span 2; justify-self: end; display: inline-flex; align-items: center; gap: var(--s2); color: var(--fg-2); font-size: .875rem; white-space: nowrap; }
  .row-side[data-availability="offline"] { color: var(--bad); }
  .row-actions { grid-column: 2; grid-row: 1 / span 2; justify-self: end; display: flex; gap: var(--s2); }
  @media (max-width: 30rem) { .row { grid-template-columns: 1fr; } .row-side, .row-actions { grid-column: 1; grid-row: auto; justify-self: start; } }

  .empty { color: var(--fg-2); padding-block: var(--s4); border-block: 1px solid var(--hair); max-width: none; }

  .kv { display: grid; grid-template-columns: max-content minmax(0, 1fr); column-gap: var(--s5); row-gap: 0; margin: 0; border-block-start: var(--rule-w) solid var(--rule); }
  .kv > dt, .kv > dd { margin: 0; padding-block: var(--s2); border-block-end: 1px solid var(--hair); }
  .kv > dt { color: var(--fg-2); }
  .kv > dd { overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
  @media (max-width: 30rem) { .kv { grid-template-columns: 1fr; } .kv > dt { border: 0; padding-block-end: 0; font-size: .875rem; } }

  /* A row per thing, a column per attribute — never the other way round, so ten sensors read
     down the page rather than sideways. The header row is the only bold row; a row's own th
     names the thing and its td cells carry the readings, both at text weight. The header earns
     no rule heavier than the hairline between rows: a section heading already rules off above
     the table, and a second heavy rule under it reads as two headings rather than a heading
     over a table. Every td needs a data-label, which the narrow layout shows beside its value
     once the header row is gone and a row's name becomes that block's heading. */
  .table-wrap { overflow-x: auto; }
  .table { width: 100%; min-width: 30rem; border-collapse: collapse; margin: 0; }
  .table th, .table td { text-align: start; vertical-align: top; padding-block: var(--s2); padding-inline: 0 var(--s4); }
  .table th:last-child, .table td:last-child { padding-inline-end: 0; }
  .table thead th { font-weight: 600; border-block-end: 1px solid var(--hair); }
  .table tbody th, .table tbody td { border-block-end: 1px solid var(--hair); }
  .table tbody tr:last-child th, .table tbody tr:last-child td { border-block-end: 0; }
  .table tbody th { font-weight: 400; overflow-wrap: anywhere; }
  .table tbody td { overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
  .table tbody th a { color: inherit; text-decoration: none; }
  .table tbody th a:hover, .table tbody th a:focus-visible { text-decoration: underline; text-decoration-thickness: 1.5px; text-underline-offset: .15em; }
  @media (max-width: 40rem) {
    .table { min-width: 0; }
    .table thead { display: none; }
    .table tbody, .table tbody tr, .table tbody th, .table tbody td { display: block; }
    .table tbody tr { padding-block: var(--s2); border-block-end: 1px solid var(--hair); }
    .table tbody tr:last-child { border-block-end: 0; }
    .table tbody th, .table tbody td { border: 0; padding-inline-end: 0; }
    .table tbody th { font-weight: 600; padding-block-end: var(--s1); }
    .table tbody td { display: flex; justify-content: space-between; gap: var(--s3); }
    .table tbody td::before { content: attr(data-label); color: var(--fg-2); font-weight: 400; }
  }

  .state { display: flex; align-items: baseline; gap: var(--s3); flex-wrap: wrap; padding-block: var(--s3); border-block: var(--rule-w) solid var(--rule); }
  .state-value { font-size: 1.5rem; line-height: 1.2; }
  .state-detail { color: var(--fg-2); font-size: .875rem; }

  .bar { display: flex; gap: var(--s2); flex-wrap: wrap; align-items: center; margin-block: var(--s4); }
  .btn { font: inherit; color: var(--fg); background: transparent; border: var(--rule-w) solid var(--rule); border-radius: var(--radius); box-shadow: var(--shadow); padding: .45rem .9rem; line-height: 1.25; cursor: pointer; min-height: 2.5rem; transition: background var(--motion), color var(--motion), border-color var(--motion); }
  .btn:hover:not(:disabled), .btn:focus-visible { background: var(--ok-soft); }
  .btn:active:not(:disabled) { background: var(--panel); }
  .btn:disabled { cursor: not-allowed; color: var(--fg-2); border-color: var(--hair); }
  .btn[aria-pressed="true"], .btn[data-active="true"] { color: var(--bg); background: var(--fg); border-color: var(--fg); }
  .btn-primary { color: var(--accent-fg); background: var(--accent); border-color: var(--accent); }
  .btn-primary:hover:not(:disabled), .btn-primary:focus-visible { background: color-mix(in srgb, var(--accent) 86%, var(--fg)); }
  .btn-primary:disabled { color: var(--fg-2); background: transparent; border-color: var(--hair); }
  .btn-small { min-height: 2rem; padding: .2rem .6rem; font-size: .875rem; }
  .btn-danger { color: var(--bad); border-color: var(--bad); }
  .btn-danger:hover:not(:disabled), .btn-danger:focus-visible { background: var(--bad-soft); }

  /* A live control's own state, with no text of its own: fill says active, a plain outline says
     inactive, and the rest read as texture — dim for unknown, dashed for checking, a pulse while
     updating, red for a failure. A theme may retune any of these; this is the shared default. */
  .btn[data-state="active"] { color: var(--bg); background: var(--fg); border-color: var(--fg); }
  .btn[data-state="inactive"] { color: var(--fg); background: transparent; }
  .btn[data-state="unknown"] { color: var(--fg-2); border-style: dashed; }
  .btn[data-state="checking"] { color: var(--fg-2); border-style: dashed; cursor: default; }
  .btn[data-state="updating"] { color: var(--fg-2); background: var(--panel); animation: ht-pulse 1.1s ease-in-out infinite; cursor: default; }
  .btn[data-state="failure"] { color: var(--bad); border-color: var(--bad); }
  .btn[aria-disabled="true"] { cursor: not-allowed; }
  .btn[aria-disabled="true"]:not([data-state="updating"]):not([data-state="checking"]) { color: var(--fg-2); border-color: var(--hair); background: transparent; }
  .btn-link { font: inherit; color: var(--accent); background: none; border: 0; padding: 0; cursor: pointer; text-decoration: underline; text-underline-offset: .15em; }
  .btn-link:disabled { color: var(--fg-2); cursor: default; text-decoration: none; }
  .btn-icon { display: inline-grid; place-items: center; width: 2.5rem; padding: 0; font-size: 0; }
  .btn-icon::before { width: 1.2rem; height: 1.2rem; background: currentColor; -webkit-mask: center / contain no-repeat; mask: center / contain no-repeat; content: ""; }

  input, select, textarea { font: inherit; color: var(--fg); background: var(--bg); border: var(--rule-w) solid var(--rule); border-radius: var(--radius); box-shadow: var(--shadow); padding: .45rem .6rem; min-height: 2.5rem; max-width: 100%; }
  input:disabled, select:disabled, textarea:disabled { color: var(--fg-2); border-color: var(--hair); }
  input::placeholder, textarea::placeholder { color: var(--fg-2); opacity: 1; }
  input[type="checkbox"], input[type="radio"] { width: 1.1rem; height: 1.1rem; min-height: 0; margin: 0; accent-color: var(--accent); vertical-align: -.15em; }
  input[type="range"] { width: 100%; min-height: 0; padding: 0; border: 0; background: transparent; accent-color: var(--accent); }
  input[type="color"] { width: 3rem; padding: .15rem; }
  textarea { resize: vertical; min-height: 5rem; overflow-wrap: anywhere; }
  .field { display: grid; gap: var(--s1); margin-block: var(--s3); }
  .field > span:first-child, .field > label:first-child, label.field { color: var(--fg-2); font-size: .875rem; }
  .field-row { display: flex; gap: var(--s2); align-items: center; }
  .field-row > input, .field-row > select { flex: 1; min-width: 0; }
  .field-value { display: flex; justify-content: space-between; gap: var(--s3); font-size: .875rem; color: var(--fg-2); }
  .field-value output { color: var(--fg); font-variant-numeric: tabular-nums; }
  fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
  legend { padding: 0; }
  .checks { display: flex; gap: var(--s3) var(--s4); flex-wrap: wrap; }
  .checks label { display: inline-flex; gap: var(--s2); align-items: center; }

  .rescan { margin-block-start: var(--s5); }
  .rescan-results { list-style: none; margin: var(--s2) 0 0; padding: 0; font-size: .875rem; }
  .rescan-results li { padding-block: var(--s1); border-block-start: 1px solid var(--hair); }
  .rescan-results li[data-outcome="moved"], .rescan-results li[data-outcome="identified"] { color: var(--ok); }
  .rescan-results li[data-outcome="failed"] { color: var(--bad); }
  .feedback { min-height: 1.5rem; margin: var(--s2) 0 0; color: var(--fg-2); font-size: .875rem; white-space: pre-wrap; }
  .feedback[data-tone="ok"] { color: var(--ok); }
  .feedback[data-tone="bad"] { color: var(--bad); }
  .problems { margin: var(--s3) 0; padding: var(--s2) var(--s3) var(--s2) var(--s5); border: var(--rule-w) solid var(--bad); color: var(--bad); font-size: .875rem; }
  .problems li + li { margin-block-start: var(--s1); }
  .note { max-width: var(--measure); color: var(--fg-2); font-size: .875rem; }

  .tabs { display: flex; gap: var(--s4); margin: 0 0 var(--s5); border-block-end: var(--rule-w) solid var(--rule); }
  .tabs a, .tabs button { padding: var(--s2) 0; margin-block-end: calc(var(--rule-w) * -1); border: 0; border-block-end: 2px solid transparent; background: none; color: var(--fg-2); font: inherit; text-decoration: none; cursor: pointer; }
  .tabs a:hover, .tabs button:hover { color: var(--fg); }
  .tabs a[aria-current="page"], .tabs button[aria-selected="true"] { color: var(--fg); border-block-end-color: var(--fg); }
  .tabs + .state, .tabs + .statusline { border-block-start: 0; margin-block-start: calc(var(--s5) * -1); }

  .stage { position: relative; display: grid; place-items: center; width: 100%; aspect-ratio: var(--stage-aspect, 16 / 9); overflow: hidden; background: var(--stage); color: var(--stage-fg); }
  .stage img, .stage canvas, .stage svg { position: absolute; inset: 0; width: 100%; height: 100%; }
  .stage img { object-fit: contain; display: block; }
  .stage .placeholder { z-index: 1; color: var(--stage-fg); opacity: .7; text-align: center; padding: var(--s4); }

  details > summary { cursor: pointer; color: var(--fg-2); list-style: none; }
  details > summary::-webkit-details-marker { display: none; }
  details > summary::before { content: "\25B8\A0"; }
  details[open] > summary::before { content: "\25BE\A0"; }

  .events { list-style: none; margin: 0; padding: 0; border-block-start: var(--rule-w) solid var(--rule); font-size: .9375rem; }
  .event { display: grid; gap: var(--s1); padding-block: var(--s2); border-block-end: 1px solid var(--hair); }
  .event-head .mark { --mark: .5rem; }
  .event.is-new { animation: ht-flash 1.2s ease-out; }
  @keyframes ht-flash { from { background: var(--ok-soft); } to { background: transparent; } }
  .event-head { display: flex; gap: var(--s3); align-items: baseline; flex-wrap: wrap; }
  .event-at { color: var(--fg-2); font-size: .8125rem; font-variant-numeric: tabular-nums; }
  .event-type { font-weight: 600; }
  .event-subject { color: var(--fg-2); font-size: .8125rem; }
  .event-body { display: flex; gap: var(--s3); align-items: flex-start; }
  .event-thumb { flex: none; width: 8rem; aspect-ratio: 16 / 9; object-fit: cover; background: var(--stage); }
  .event-preview { flex: none; width: 12rem; max-width: 40vw; }
  .event-frame-link { display: block; position: relative; background: var(--stage); }
  .event-frame-link[hidden], .event-frame-missing[hidden] { display: none; }
  .event-detection-image { display: block; width: 100%; height: auto; }
  .event-detection-boxes { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
  .event-detection-boxes rect { fill: none; stroke: rgba(255, 255, 255, .8); stroke-width: 1; filter: drop-shadow(0 0 1px rgba(0, 0, 0, .7)); }
  .event-frame-caption { margin-block-start: .2rem; color: var(--fg-2); font-size: .75rem; }
  .event-preview-toggle { margin-block-start: .25rem; min-height: 0; padding: .2rem .5rem; font-size: .75rem; }
  .event-frame-missing { display: grid; gap: .4rem; padding: .75rem; color: var(--fg-2); border: 1px solid var(--hair); font-size: .8rem; }
  .event-frame-missing button { justify-self: start; min-height: 0; padding: .2rem .5rem; font-size: inherit; }
  .event-facts { display: flex; flex-wrap: wrap; gap: var(--s1) var(--s3); color: var(--fg-2); font-size: .8125rem; }
  .event-facts b { color: var(--fg); font-weight: 600; font-variant-numeric: tabular-nums; }
  .event-codes { color: var(--fg-2); font-family: var(--font-mono); font-size: .8125rem; overflow-wrap: anywhere; }
  .filters { display: flex; gap: var(--s3); align-items: center; flex-wrap: wrap; margin-block: var(--s3); font-size: .875rem; }
  .filters label { display: inline-flex; gap: var(--s2); align-items: center; color: var(--fg-2); }
  .filters select { min-height: 2rem; padding-block: .2rem; }
  .subject-filter { display: flex; align-items: center; gap: var(--s2); min-width: 0; color: var(--fg-2); }
  .subject-dropdown { position: relative; min-width: 8rem; max-width: min(28rem, 65vw); }
  .subject-dropdown > summary { display: flex; align-items: center; min-height: 2rem; padding: .2rem .6rem; border: var(--rule-w) solid var(--rule); border-radius: var(--radius); background: var(--bg); color: var(--fg); }
  .subject-selection { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .subject-menu { position: absolute; z-index: 10; inset-block-start: calc(100% + .25rem); inset-inline-start: 0; width: max-content; min-width: 100%; max-width: min(30rem, 75vw); max-height: 20rem; overflow: auto; padding: var(--s2); border: var(--rule-w) solid var(--rule); border-radius: var(--radius); background: var(--bg); box-shadow: var(--shadow); }
  .subject-options { display: grid; margin-block-start: var(--s2); }
  .subject-options label { padding: .4rem; color: var(--fg); cursor: pointer; }
  .subject-options label:hover { background: var(--panel); }
  .subject-options input { width: 1rem; height: 1rem; min-height: 0; margin: 0; flex-shrink: 0; accent-color: var(--accent); }
  .filters .count { margin-inline-start: auto; color: var(--fg-2); font-variant-numeric: tabular-nums; }
  .detection-filter { margin-block: var(--s3); }
  .detection-filter legend { font-weight: 600; }
  .detection-filter .hint { margin-block: var(--s1) var(--s2); font-size: .8rem; color: var(--fg-2); }
  .detection-filter button { padding: .2rem .5rem; min-height: 0; font-size: inherit; }
  .detection-options { display: flex; flex-wrap: wrap; gap: .5rem 1rem; }
  .detection-options label { display: inline-flex; align-items: center; gap: .4rem; font-size: .875rem; cursor: pointer; }
  .detection-options input { width: 1rem; height: 1rem; min-height: 0; margin: 0; accent-color: var(--accent); }
  .detection-name { text-transform: capitalize; }
  .detection-count { color: var(--fg-2); font-variant-numeric: tabular-nums; }
  .detection-missing { margin-block-start: var(--s2); color: var(--fg-2); font-size: .8rem; }
  .detection-missing summary { cursor: pointer; }
  .detection-absent { margin-block-start: var(--s2); }
  .live { display: inline-flex; align-items: center; gap: var(--s2); font-size: .875rem; color: var(--fg-2); font-weight: 400; }
  .live .mark { opacity: .5; }
  .live[data-connected="true"] .mark { background: var(--ok); opacity: 1; }
  .live[data-connected="false"] .mark { background: var(--bad); opacity: 1; }

  .chips { display: flex; flex-wrap: wrap; gap: var(--s2); }
  .chip { display: inline-flex; align-items: stretch; border: var(--rule-w) solid var(--rule); }
  .chip > * { border: 0; border-radius: 0; box-shadow: none; min-height: 2.25rem; }
  .chip > * + * { border-inline-start: 1px solid var(--hair); }
  .chip input { width: 4.5rem; text-align: end; }
  .chip .unit { align-self: center; padding-inline-end: var(--s2); color: var(--fg-2); font-size: .8125rem; }

  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; } }

  /* Live device views: block-level before their theme's element definitions arrive, so the upgrade shifts nothing. */
  ht-switch, ht-light, ht-button { display: block; }
  ht-switch:not(:defined), ht-light:not(:defined), ht-button:not(:defined) { min-height: 8rem; }
  ht-status, ht-switch-row { display: inline-flex; align-items: center; gap: var(--s2); }

`;

const NAV: readonly { item: NavItem; href: string; key: `nav.${NavItem}` }[] = [
  { item: "devices", href: "/devices", key: "nav.devices" },
  { item: "switches", href: "/switches", key: "nav.switches" },
  { item: "groups", href: "/groups", key: "nav.groups" },
  { item: "buttons", href: "/buttons", key: "nav.buttons" },
  { item: "tags", href: "/tags", key: "nav.tags" },
  { item: "kindle", href: "/kindle/designer", key: "nav.kindle" },
  { item: "automations", href: "/automations", key: "nav.automations" },
  { item: "events", href: "/events", key: "nav.events" },
  { item: "health", href: "/health", key: "nav.health" },
  { item: "services", href: "/services", key: "nav.services" },
  { item: "network", href: "/network-isolation", key: "nav.network" },
  { item: "schemas", href: "/schemas", key: "nav.schemas" },
  { item: "api", href: "/api-docs", key: "nav.api" },
  { item: "tokens", href: "/settings/tokens", key: "nav.tokens" },
];

export function renderSiteHeader(ctx: PageContext, active?: NavItem): string {
  const { t } = ctx.i18n;
  const links = NAV
    // A link to a page this caller would be refused is worse than no link.
    .filter((entry) => entry.item !== "network" || ctx.features.isolation)
    .filter((entry) => entry.item !== "tokens" || ctx.features.admin)
    .map((entry) => `<a href="${entry.href}"${entry.item === active ? ' aria-current="page"' : ""}>${escapeHtml(t(entry.key))}</a>`)
    .join("");
  return `<header class="site-head"><a class="brand" href="/">${escapeHtml(ctx.siteTitle)}</a><nav class="site-nav" aria-label="${escapeHtml(t("nav.label"))}">${links}</nav></header>`;
}

export function renderSiteFooter(ctx: PageContext): string {
  const { t } = ctx.i18n;
  const option = (value: string, label: string, selected: boolean) => `<option value="${escapeHtml(value)}"${selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
  return `<footer class="site-foot">
    <form method="post" action="${PREFERENCES_PATH}" data-preferences>
      <input type="hidden" name="return" value="${escapeHtml(ctx.path)}">
      <label>${escapeHtml(t("footer.theme"))}<select name="theme">${THEMES.map((theme) => option(theme, t(`theme.${theme}`), theme === ctx.theme)).join("")}</select></label>
      <label>${escapeHtml(t("footer.scheme"))}<select name="scheme">${SCHEMES.map((scheme) => option(scheme, t(`scheme.${scheme}`), scheme === ctx.scheme)).join("")}</select></label>
      <label>${escapeHtml(t("footer.language"))}<select name="locale">${SUPPORTED_LOCALES.map((locale) => option(locale, LOCALE_NAMES[locale], locale === ctx.i18n.locale)).join("")}</select></label>
      <button type="submit" class="btn">${escapeHtml(t("footer.apply"))}</button>
    </form>
  </footer>`;
}

/**
 * The catalog prefixes the `ht-*` elements read (`src/ui/browser/kinds/*`):
 * state words, pending sentences, row summaries, and the light's units. A
 * page that hosts an element gets them all, so a theme may swap in any
 * element without the page knowing which strings it needs.
 */
export const ELEMENT_MESSAGE_PREFIXES: readonly string[] = ["state.", "live.", "summary.", "switch.", "light.", "stringLight.", "button.", "grouping.", "camera.", "speaker.", "sensor."];

/** JSON for a `<script type="application/json">`: `<` is escaped so no text can close the element. */
function jsonScript(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export function renderPage({ ctx, title, nav, body, css = "", script = "", messages = [], mainAttributes = "", wide = false, bare = false, nodes = [] }: PageOptions): string {
  // A page with no body of its own has nothing to tag, so it gets no panel —
  // and neither does a bare page, which is reached before there is a session
  // to tag anything with.
  const tagEditor = !bare && body && nav !== "tags" && !body.includes("data-tag-editor") ? ctx.tagEditor?.() ?? "" : "";
  const api = !bare ? ctx.elementApi?.() : undefined;
  let content = body + tagEditor;
  if (api) {
    // Page renderers own their header markup. Extend their first page tab bar,
    // keeping the header outside the mutually exclusive page/API panels.
    const tabs = /<nav\b[^>]*class="[^"]*\btabs\b[^"]*"[^>]*>[\s\S]*?<\/nav>/.exec(body);
    const before = tabs ? body.slice(0, tabs.index) : "";
    const active = activeApiTab(ctx.path);
    const pageLink = `<a data-element-page-tab href="${escapeHtml(pageStateHref(ctx.path, "tab"))}"${active ? "" : ' aria-current="page"'} aria-controls="element-page-panel">${escapeHtml(title || ctx.siteTitle)}</a>`;
    const navigation = tabs
      ? tabs[0].replace('<nav ', '<nav data-element-tabs ').replace('class="tabs', 'class="tabs element-tabs')
        .replace(' aria-current="page"', ` data-element-page-tab${active ? "" : ' aria-current="page"'}`)
        .replace('</nav>', `${tabs[0].includes('aria-current="page"') ? "" : pageLink}${api.tabs}</nav>`)
      : `<nav class="tabs element-tabs" data-element-tabs aria-label="${escapeHtml(ctx.i18n.t("device.tabs.label"))}">${pageLink}${api.tabs}</nav>`;
    const page = tabs ? body.slice(tabs.index + tabs[0].length) : body;
    content = `${before}${navigation}<div id="element-page-panel" data-element-page-panel${active ? " hidden" : ""}>${page}${tagEditor}</div>${api.body}`;
  }
  const nonce = escapeHtml(ctx.nonce);
  const dictionary = jsonScript(ctx.i18n.messages(["status.", "feedback.", "action.", "tags.", ...(nodes.length ? ELEMENT_MESSAGE_PREFIXES : []), ...(api ? ["api."] : []), ...messages]));
  const seed = jsonScript(ctx.state.snapshot(nodes));
  const entry = `/ui/${encodeURIComponent(ctx.assetVersion)}/themes/${encodeURIComponent(ctx.theme)}/index.ts`;
  return `<!doctype html>
<html lang="${escapeHtml(ctx.i18n.locale)}" dir="${ctx.i18n.dir}" data-theme="${ctx.theme}" data-scheme="${ctx.scheme}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="${ctx.scheme === "auto" ? "light dark" : ctx.scheme}">
    <meta name="referrer" content="no-referrer">
    <title>${title ? `${escapeHtml(title)} · ` : ""}${escapeHtml(ctx.siteTitle)}</title>
    <style id="ht-css" nonce="${nonce}">${scaleCss()}${themeCss(themeById(ctx.theme))}${COMPONENTS_CSS}${TAG_CSS}${css}${api?.css ?? ""}</style>
  </head>
  <body>
    ${bare ? "" : renderSiteHeader(ctx, nav)}
    <main${wide ? " data-wide" : ""}${mainAttributes ? ` ${mainAttributes}` : ""}>
${content}
    </main>
    ${renderSiteFooter(ctx)}
    <script type="application/json" id="ht-messages" nonce="${nonce}">${dictionary}</script>
    <script type="application/json" id="ht-state" nonce="${nonce}">${seed}</script>
    <script nonce="${nonce}">${CLIENT_RUNTIME}${bare ? "" : PAGE_STATE_SCRIPT}${TAG_EDITOR_SCRIPT}${script}${api?.script ?? ""}${bare ? "" : PAGE_DISCLOSURE_SCRIPT}</script>
    ${bare ? "" : `<script type="module" nonce="${nonce}" src="${escapeHtml(entry)}"></script>`}
    ${!bare && process.env.HOMETRUTH_RELOAD_VERSION ? `<script nonce="${nonce}">${runtimeUpdateScript(process.env.HOMETRUTH_RELOAD_VERSION)}</script>` : ""}
  </body>
</html>`;
}

/** A page state with nothing cached: the initial HTML says Unknown. */
export const EMPTY_PAGE_STATE: PageState = { snapshot: () => [] };

export function createPageContext(options: { nonce: string; siteTitle: string; preferences: UiPreferences; i18n: Translator; path: string; features?: { isolation: boolean; admin: boolean }; state?: PageState; assetVersion?: string; rooms?: readonly string[]; tagEditor?: PageContext["tagEditor"]; elementApi?: PageContext["elementApi"] }): PageContext {
  return {
    nonce: options.nonce,
    siteTitle: options.siteTitle,
    i18n: options.i18n,
    theme: options.preferences.theme,
    scheme: options.preferences.scheme,
    path: options.path,
    features: options.features ?? { isolation: false, admin: false },
    state: options.state ?? EMPTY_PAGE_STATE,
    assetVersion: options.assetVersion ?? "dev",
    ...(options.rooms ? { rooms: options.rooms } : {}),
    ...(options.tagEditor ? { tagEditor: options.tagEditor } : {}),
    ...(options.elementApi ? { elementApi: options.elementApi } : {}),
  };
}

/**
 * A live device view: one `ht-*` element bound to a graph node. It has
 * cached reading is present in the HTML before the theme upgrades it.
 */
export function htElement(ctx: PageContext, tag: HtTag, node: NodeId, attributes = ""): string {
  return `<${tag} node="${escapeHtml(node)}"${attributes ? ` ${attributes}` : ""}>${renderStateSnapshot(ctx, tag, ctx.state.snapshot([node])[0])}</${tag}>`;
}

export function capabilityLabel(ctx: PageContext, kind: CapabilityKind): string {
  return ctx.i18n.t(`cap.${kind}`);
}

/** Human-readable labels for the model's controlled connection vocabulary. */
export function deviceConnectionLabel(ctx: PageContext, device: Pick<RegisteredDevice, "connectionTypes">): string {
  return (device.connectionTypes ?? []).map((type) => ctx.i18n.lookup(`connection.${type}`) ?? type).join(" · ");
}

/** The status mark plus its word; scripts update both through `data-availability` and `.status-text`. */
export function renderStatus(ctx: PageContext, availability: string, options: { id?: string; text?: string } = {}): string {
  const text = options.text ?? ctx.i18n.lookup(`status.${availability}`) ?? ctx.i18n.t("status.unknown");
  return `<span class="status"${options.id ? ` id="${escapeHtml(options.id)}"` : ""} data-availability="${escapeHtml(availability)}"><span class="mark" data-availability="${escapeHtml(availability)}" aria-hidden="true"></span><span class="status-text">${escapeHtml(text)}</span></span>`;
}

/** One line that says what a device is: model, capabilities, address. */
export function renderDeviceMeta(ctx: PageContext, device: RegisteredDevice): string {
  const capabilities = [...device.capabilities.map((kind) => capabilityLabel(ctx, kind)), ...(device.sensors ?? []).map(sensor => sensor.name)].join(" + ");
  const connection = deviceConnectionLabel(ctx, device);
  return `<p class="muted small" data-model="${escapeHtml(device.model)}">${escapeHtml(device.modelTitle)} · ${escapeHtml(capabilities)}${connection ? ` · ${escapeHtml(connection)}` : ""} · <span class="mono">${escapeHtml(device.host)}</span></p>`;
}

export function deviceNav(device: RegisteredDevice): NavItem {
  return device.page.startsWith("/groups/") ? "groups" : device.page.startsWith("/switches/") ? "switches" : "devices";
}

export function renderDeviceTabs(ctx: PageContext, device: RegisteredDevice, active: "controls" | "log" | "settings" | "graph"): string {
  const { t } = ctx.i18n;
  const base = escapeHtml(device.page);
  const tab = (href: string, id: typeof active, label: string) => `<a href="${href}"${active === id ? ' aria-current="page"' : ""}>${escapeHtml(label)}</a>`;
  return `<nav class="tabs" aria-label="${escapeHtml(t("device.tabs.label"))}">${tab(base, "controls", t(device.kind === "device" && device.sensors?.length ? "sensor.components" : "device.tabs.controls"))}${tab(`${base}/graph`, "graph", t("device.tabs.graph"))}${tab(`${base}/log`, "log", t("device.tabs.log"))}${tab(`${base}/settings`, "settings", t("device.tabs.settings"))}</nav>`;
}

/** The link above a device's title to the schema it's an instance of, when that schema has a page. */
export function renderInstanceOf(ctx: PageContext, schemaId: string): string {
  const link = schemaLink(schemaId);
  if (!link) return "";
  return `<p class="muted small"><a href="${escapeHtml(link.page)}">${escapeHtml(ctx.i18n.t("device.instanceOf", { schema: link.title }))}</a></p>`;
}

/** The device header: schema and relationships in one row, name, then tabs. `aside` (already escaped) sits to the right of the name, for a page whose live status belongs beside its title. */
export function renderDeviceHead(ctx: PageContext, device: RegisteredDevice, active: "controls" | "log" | "settings" | "graph", aside = ""): string {
  const relationships = active === "graph" ? [] : device.relationships ?? [];
  const related = [...new Set(relationships.map(link => link.relation))].map(relation => `<p class="small">${escapeHtml(ctx.i18n.t(`relations.${relation}`))}: ${relationships.filter(link => link.relation === relation).map(link => `<a href="${escapeHtml(link.page)}">${escapeHtml(link.name)}</a>`).join(" · ")}</p>`).join("");
  const metadata = renderInstanceOf(ctx, device.schemaId) + related;
  const title = aside
    ? `<div class="page-head"><h1>${escapeHtml(device.name)}</h1>${aside}</div>`
    : `<h1>${escapeHtml(device.name)}</h1>`;
  return `${metadata ? `<div class="device-relations" data-element-relations>${metadata}</div>` : ""}${title}${renderDeviceTabs(ctx, device, active)}`;
}
