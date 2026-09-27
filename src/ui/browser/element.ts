/**
 * The base of every `ht-*` element: bound to one node by its `node`
 * attribute, it subscribes through `ht.state` while connected, keeps the
 * node's latest frame, and hands its subclass a typed `document` (the
 * capability the element shows). Open shadow DOM with `delegatesFocus`, the
 * shell's vocabulary and a per-class sheet adopted as constructed
 * stylesheets, `part="…"` names on everything a theme may style. The
 * constructor only attaches the shadow root and appends the template, as
 * the custom-element spec asks; the server-rendered light-DOM fallback is
 * simply no longer rendered once the shadow root exists.
 *
 * The contract a concrete (themed) subclass keeps:
 * - `constructor()` calls `super(styles, template, tier)` and nothing else.
 * - The template provides the parts its kind's `render()` writes; see each
 *   kind's class comment. Parts a template omits are skipped, never required.
 * - Action buttons carry `data-action="<controlId>"` inside the shadow root;
 *   a delegated click reaches `onAction()`. While a command is pending the
 *   host has `aria-busy="true"` and every action button `aria-disabled="true"`
 *   (focus stays), and clicks are ignored.
 * - Page scripts listen for `ht:frame` on the host; its `detail` is the frame.
 */
import type { Availability } from "../../models/capability.ts";
import type { NodeId, Tier } from "../../state/protocol.ts";
import { ht, type Key, type MessageParams, type Tone } from "./runtime.ts";
import type { StoredRecord } from "./store.ts";
import { isCold } from "./view.ts";
import type { Notice, Readiness } from "./view.ts";

export type { Readiness } from "./view.ts";

const NODE_ATTRIBUTE = /^(device|group|automation)\/[^/]/u;

export abstract class HtElement<Doc> extends HTMLElement {
  static readonly observedAttributes = ["node", "capability"];

  readonly #tier: Tier;
  #frame: StoredRecord | undefined;
  #release: (() => void) | undefined;
  #subscribed: NodeId | undefined;
  #pendingControl: string | undefined;
  #error: string | undefined;
  #erroredControl: string | undefined;
  #notice: Notice | undefined;
  #wired = false;

  constructor(styles: readonly CSSStyleSheet[], template: HTMLTemplateElement, tier: Tier) {
    super();
    const root = this.attachShadow({ mode: "open", delegatesFocus: true });
    root.adoptedStyleSheets = [...styles];
    root.append(template.content.cloneNode(true));
    this.#tier = tier;
  }

  /** The capability kind this element reads from a device document; the `capability` attribute overrides it. */
  protected abstract get defaultCapability(): string;

  /** The node this element is bound to, when its `node` attribute names one. */
  get node(): NodeId | undefined {
    const value = this.getAttribute("node") ?? "";
    return NODE_ATTRIBUTE.test(value) ? (value as NodeId) : undefined;
  }

  get capability(): string {
    return this.getAttribute("capability") || this.defaultCapability;
  }

  /** The node's latest record, stale flag included; undefined before the first frame. */
  get frame(): StoredRecord | undefined {
    return this.#frame;
  }

  /** The node's whole value: a HomeTruth object for a device, a group switch for a group. */
  protected get value(): unknown {
    return this.#frame?.value;
  }

  /** `value.capabilities[capability]` for a device node; the switch's `binarySwitch` for a group or automation node. */
  get document(): Doc | undefined {
    const capabilities = (this.value as { capabilities?: Record<string, unknown> } | undefined)?.capabilities;
    if (!capabilities) return undefined;
    const key = this.node?.startsWith("group/") || this.node?.startsWith("automation/") ? "binarySwitch" : this.capability;
    return capabilities[key] as Doc | undefined;
  }

  get readiness(): Readiness {
    const frame = this.#frame;
    if (!frame || (frame.value === undefined && !frame.fault)) return "unknown";
    if (frame.fault) return frame.fault.code === "unconfigured" ? "gone" : "offline";
    // A record the stream has not confirmed *and* that is too old to stand for
    // the present is last-known, not current. A page seed is seconds old and
    // passes; one restored from disk after a restart may be days old, and
    // claiming a device is online because it was on Tuesday is exactly the
    // thing the product promises not to do. The value is still rendered, with
    // the time it was read.
    if (frame.stale && isCold(frame.observedAt, Date.now())) return "unknown";
    const state = (this.document as { state?: { availability?: Availability } } | undefined)?.state;
    return state?.availability ?? (this.value as { status?: Availability } | undefined)?.status ?? "unknown";
  }

  get pending(): boolean {
    return this.#pendingControl !== undefined;
  }

  /** The control in flight, so a view can say "Turning on…" rather than "Sending…". */
  get pendingControl(): string | undefined {
    return this.#pendingControl;
  }

  /** The last command's error message; cleared when the next command starts. */
  get error(): string | undefined {
    return this.#error;
  }

  /** The control the current `error` belongs to, so a view can fail only the button that earned it. */
  get erroredControl(): string | undefined {
    return this.#erroredControl;
  }

  /** A confirmation kept until the next command or error (a button's "Pressed"). */
  protected get notice(): Notice | undefined {
    return this.#notice;
  }

  connectedCallback(): void {
    if (!this.#wired) {
      this.#wired = true;
      this.shadowRoot?.addEventListener("click", (event) => this.#onClick(event));
    }
    this.#subscribe();
    this.paint();
  }

  disconnectedCallback(): void {
    this.#unsubscribe();
  }

  attributeChangedCallback(name: string, previous: string | null, next: string | null): void {
    if (previous === next || !this.isConnected) return;
    if (name === "node") {
      this.#unsubscribe();
      this.#frame = undefined;
      this.#subscribe();
    }
    this.paint();
  }

  /** Write the current frame, pending state, and error into the parts. */
  protected abstract render(): void;

  /**
   * The parts whose text is a value the graph delivered, rather than a label or a sentence about
   * one. Each is stamped with the record's freshness so the shell can say, on hover, how old the
   * reading is. `detail` is deliberately absent: it already says the time in words.
   */
  protected get liveParts(): readonly string[] {
    return ["value", "word", "summary", "brightness-value", "temperature-value", "color-value"];
  }

  /**
   * Render, then stamp. A part that carries a stronger colour of its own — a switch value gone
   * offline, a status word — keeps it, because the kind's own sheet is adopted after the shell's
   * vocabulary and wins on order. The stamp still lands on every one of them, so the freshness is
   * on hover everywhere even where the ink is spoken for.
   */
  protected paint(): void {
    this.render();
    const at = this.#frame?.observedAt;
    for (const name of this.liveParts) {
      for (const part of this.shadowRoot?.querySelectorAll<HTMLElement>(`[part~="${name}"]`) ?? []) {
        if (at) part.setAttribute("data-live", at);
        else part.removeAttribute("data-live");
      }
    }
  }

  /** A click on `[data-action]` inside the shadow root, unless a command is pending. Subclasses map ids to methods. */
  protected onAction(_action: string, _source: HTMLElement): void {}

  /**
   * Send one control and hold the element busy until the node's next signal
   * (or 2 s after the response). Re-entry is ignored. Resolves with whether
   * the command was accepted; a refusal is kept in `error` for the view.
   */
  protected async invoke(controlId: string, value?: unknown): Promise<boolean> {
    if (this.#pendingControl !== undefined) return false;
    const client = ht.state;
    const node = this.node;
    if (!client || !node) return false;
    this.#pendingControl = controlId;
    this.#error = undefined;
    this.#erroredControl = undefined;
    this.#notice = undefined;
    this.#busy(true);
    this.paint();
    try {
      await client.invoke(node, this.capability, controlId, value);
      return true;
    } catch (error) {
      this.#error = error instanceof Error && error.message ? error.message : this.t("feedback.requestFailed");
      this.#erroredControl = controlId;
      return false;
    } finally {
      this.#pendingControl = undefined;
      this.#busy(false);
      this.paint();
    }
  }

  protected t(key: Key, params?: MessageParams): string {
    return ht.t(key, params);
  }

  /** The first element in the shadow root with this part name. */
  protected partNamed(name: string): HTMLElement | null {
    return this.shadowRoot?.querySelector<HTMLElement>(`[part~="${name}"]`) ?? null;
  }

  /** Every action button in the shadow root. */
  protected actionButtons(): HTMLElement[] {
    return [...(this.shadowRoot?.querySelectorAll<HTMLElement>("[data-action]") ?? [])];
  }

  /** Write the feedback part and keep the message until the next command or error. */
  protected announce(message: string, tone?: Tone): void {
    this.#notice = message ? (tone ? { message, tone } : { message }) : undefined;
    this.writeFeedback(message, tone);
  }

  /** Write the feedback part without keeping the message. */
  protected writeFeedback(message: string, tone?: Tone): void {
    const feedback = this.partNamed("feedback");
    if (!feedback) return;
    feedback.textContent = message;
    if (tone) feedback.dataset.tone = tone;
    else delete feedback.dataset.tone;
  }

  /** Tell page scripts the frame changed; `detail` is the frame. */
  protected emit(): void {
    this.dispatchEvent(new CustomEvent("ht:frame", { detail: this.#frame, bubbles: true }));
  }

  #onClick(event: Event): void {
    const target = event.target as Element | null;
    const source = target?.closest?.<HTMLElement>("[data-action]");
    // A control the view disabled (pending, or a group that cannot switch) is not sent; the server would only refuse it.
    if (!source || this.#pendingControl !== undefined || source.getAttribute("aria-disabled") === "true") return;
    const action = source.dataset.action;
    if (action) this.onAction(action, source);
  }

  #busy(on: boolean): void {
    if (on) this.setAttribute("aria-busy", "true");
    else this.removeAttribute("aria-busy");
    for (const button of this.actionButtons()) {
      if (on) button.setAttribute("aria-disabled", "true");
      else button.removeAttribute("aria-disabled");
    }
  }

  #subscribe(): void {
    const client = ht.state;
    const node = this.node;
    if (!client || !node || this.#subscribed === node) return;
    this.#unsubscribe();
    this.#subscribed = node;
    this.#release = client.subscribe(node, (record) => {
      this.#frame = record;
      this.paint();
      this.emit();
    }, this.#tier);
  }

  #unsubscribe(): void {
    this.#release?.();
    this.#release = undefined;
    this.#subscribed = undefined;
  }
}
