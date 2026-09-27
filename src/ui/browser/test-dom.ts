/**
 * A fake DOM for element tests: the subset the `ht-*` base classes and their
 * kinds touch, installed on `globalThis` by `installTestDom()` before a test
 * imports an element module (`HTMLElement` must exist when the class is
 * evaluated). Parsing is a small HTML tokenizer, selectors are compound only
 * (`tag`, `.class`, `#id`, `[attr]`, `[attr="v"]`, `[attr~="v"]`, comma
 * lists), events bubble through a shadow root to its host, and custom
 * elements get `connectedCallback`, `disconnectedCallback`, and
 * `attributeChangedCallback` the way the platform calls them.
 */
import type { NodeId, NodeRecord, Tier } from "../../state/protocol.ts";
import type { HtRuntime, MessageParams } from "./runtime.ts";
import type { ConnectionListener, ConnectionState, StateClient } from "./state.ts";
import type { StoredRecord, StoreListener } from "./store.ts";

type Listener = (event: Event) => void;

const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

function decode(text: string): string {
  return text.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

function encode(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

interface Compound {
  readonly tag?: string;
  readonly id?: string;
  readonly classes: readonly string[];
  readonly attributes: readonly { name: string; operator?: "=" | "~="; value?: string }[];
}

const COMPOUND = /^([a-zA-Z][\w-]*|\*)?((?:#[\w-]+|\.[\w-]+|\[[^\]]+\])*)$/u;
const SIMPLE = /#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:(~?=)(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]/gu;

function parseSelector(selector: string): Compound[] {
  return selector.split(",").map((part) => {
    const trimmed = part.trim();
    const match = COMPOUND.exec(trimmed);
    if (!match || trimmed.includes(" ")) throw new Error(`test-dom cannot match "${trimmed}": compound selectors only`);
    const compound: { tag?: string; id?: string; classes: string[]; attributes: { name: string; operator?: "=" | "~="; value?: string }[] } = { classes: [], attributes: [] };
    if (match[1] && match[1] !== "*") compound.tag = match[1].toLowerCase();
    for (const simple of (match[2] ?? "").matchAll(SIMPLE)) {
      if (simple[1]) compound.id = simple[1];
      else if (simple[2]) compound.classes.push(simple[2]);
      else if (simple[3]) {
        const value = simple[5] ?? simple[6] ?? simple[7];
        compound.attributes.push({ name: simple[3], ...(simple[4] ? { operator: simple[4] as "=" | "~=" } : {}), ...(value === undefined ? {} : { value }) });
      }
    }
    return compound;
  });
}

class FakeEventTarget {
  readonly #listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener | null): void {
    if (!listener) return;
    let set = this.#listeners.get(type);
    if (!set) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener | null): void {
    if (listener) this.#listeners.get(type)?.delete(listener);
  }

  /** This target's own listeners, without propagation. */
  invokeListeners(event: Event): void {
    for (const listener of [...(this.#listeners.get(event.type) ?? [])]) listener.call(this, event);
  }

  dispatchEvent(event: Event): boolean {
    const path: FakeEventTarget[] = [];
    let current: FakeEventTarget | null = this;
    while (current) {
      path.push(current);
      current = current instanceof FakeShadowRoot ? current.host : current instanceof FakeNode ? current.parentNode : null;
    }
    let stopped = false;
    const original = event.stopPropagation.bind(event);
    Object.defineProperty(event, "stopPropagation", { value: () => { stopped = true; original(); }, configurable: true });
    Object.defineProperty(event, "target", { value: this, configurable: true });
    for (const node of path) {
      Object.defineProperty(event, "currentTarget", { value: node, configurable: true });
      node.invokeListeners(event);
      if (!event.bubbles || stopped) break;
    }
    Object.defineProperty(event, "currentTarget", { value: null, configurable: true });
    return !event.defaultPrevented;
  }
}

export class FakeNode extends FakeEventTarget {
  parentNode: FakeContainer | FakeShadowRoot | null = null;
  isConnected = false;

  contains(node: FakeNode | null): boolean {
    for (let current = node; current; current = current.parentNode) if (current === this) return true;
    return false;
  }

  remove(): void {
    this.parentNode?.removeChild(this);
  }

  get textContent(): string {
    return "";
  }

  set textContent(_value: string) {}

  cloneNode(_deep = false): FakeNode {
    return new FakeNode();
  }
}

export class FakeText extends FakeNode {
  data: string;

  constructor(data: string) {
    super();
    this.data = data;
  }

  override get textContent(): string {
    return this.data;
  }

  override set textContent(value: string) {
    this.data = value;
  }

  override cloneNode(): FakeText {
    return new FakeText(this.data);
  }
}

interface CustomElementCallbacks {
  connectedCallback?(): void;
  disconnectedCallback?(): void;
  attributeChangedCallback?(name: string, previous: string | null, next: string | null): void;
}

function callbacks(node: FakeNode): CustomElementCallbacks {
  return node as unknown as CustomElementCallbacks;
}

export class FakeContainer extends FakeNode {
  readonly childNodes: FakeNode[] = [];

  get children(): FakeElement[] {
    return this.childNodes.filter((node): node is FakeElement => node instanceof FakeElement);
  }

  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  override get textContent(): string {
    return this.childNodes.map((node) => node.textContent).join("");
  }

  override set textContent(value: string) {
    this.replaceChildren(...(value ? [new FakeText(value)] : []));
  }

  append(...nodes: (FakeNode | string)[]): void {
    for (const item of nodes) {
      const node = typeof item === "string" ? new FakeText(item) : item;
      if (node instanceof FakeDocumentFragment) {
        const moved = [...node.childNodes];
        node.replaceChildren();
        for (const child of moved) this.#adopt(child);
        continue;
      }
      this.#adopt(node);
    }
  }

  appendChild<T extends FakeNode>(node: T): T {
    this.append(node);
    return node;
  }

  prepend(...nodes: (FakeNode | string)[]): void {
    const existing = [...this.childNodes];
    this.replaceChildren(...nodes, ...existing);
  }

  removeChild(node: FakeNode): void {
    const index = this.childNodes.indexOf(node);
    if (index < 0) return;
    this.childNodes.splice(index, 1);
    node.parentNode = null;
    if (node.isConnected) disconnect(node);
  }

  replaceChildren(...nodes: (FakeNode | string)[]): void {
    for (const child of [...this.childNodes]) this.removeChild(child);
    this.append(...nodes);
  }

  querySelector<T extends FakeElement = FakeElement>(selector: string): T | null {
    return (this.querySelectorAll<T>(selector)[0] ?? null);
  }

  querySelectorAll<T extends FakeElement = FakeElement>(selector: string): T[] {
    const compounds = parseSelector(selector);
    const found: T[] = [];
    const walk = (container: FakeContainer) => {
      for (const child of container.children) {
        if (compounds.some((compound) => child.matchesCompound(compound))) found.push(child as T);
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  #adopt(node: FakeNode): void {
    node.parentNode?.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    if (this.isConnected) connect(node);
  }
}

function connect(node: FakeNode): void {
  node.isConnected = true;
  if (node instanceof FakeElement) {
    callbacks(node).connectedCallback?.();
    for (const child of [...node.childNodes]) connect(child);
  }
}

function disconnect(node: FakeNode): void {
  node.isConnected = false;
  if (node instanceof FakeElement) {
    callbacks(node).disconnectedCallback?.();
    for (const child of [...node.childNodes]) disconnect(child);
  }
}

export class FakeDocumentFragment extends FakeContainer {
  override cloneNode(deep = false): FakeDocumentFragment {
    const copy = new FakeDocumentFragment();
    if (deep) for (const child of this.childNodes) copy.append(child.cloneNode(true));
    return copy;
  }
}

export class FakeShadowRoot extends FakeContainer {
  readonly host: FakeElement;
  adoptedStyleSheets: FakeCSSStyleSheet[] = [];
  readonly mode: string;
  readonly delegatesFocus: boolean;

  constructor(host: FakeElement, init: { mode: string; delegatesFocus?: boolean }) {
    super();
    this.host = host;
    this.mode = init.mode;
    this.delegatesFocus = init.delegatesFocus ?? false;
    this.isConnected = host.isConnected;
  }
}

/** The registry's view of construction: the tag being created, so `super()` can name the element. */
const constructing: string[] = [];

export class FakeElement extends FakeContainer {
  readonly tagName: string;
  readonly localName: string;
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string | undefined>;
  shadowRoot: FakeShadowRoot | null = null;
  #value: string | undefined;

  constructor(tag?: string) {
    super();
    const name = tag ?? constructing.at(-1) ?? registry.tagFor(new.target) ?? "unknown";
    this.localName = name.toLowerCase();
    this.tagName = name.toUpperCase();
    this.dataset = new Proxy({} as Record<string, string | undefined>, {
      get: (_target, key) => typeof key === "string" ? this.getAttribute(`data-${dashed(key)}`) ?? undefined : undefined,
      set: (_target, key, value) => { if (typeof key === "string") this.setAttribute(`data-${dashed(key)}`, String(value)); return true; },
      deleteProperty: (_target, key) => { if (typeof key === "string") this.removeAttribute(`data-${dashed(key)}`); return true; },
      has: (_target, key) => typeof key === "string" && this.hasAttribute(`data-${dashed(key)}`),
      ownKeys: () => [...this.attributes.keys()].filter((name) => name.startsWith("data-")).map((name) => camel(name.slice(5))),
      getOwnPropertyDescriptor: (_target, key) => typeof key === "string" && this.hasAttribute(`data-${dashed(key)}`) ? { value: this.getAttribute(`data-${dashed(key)}`), enumerable: true, configurable: true, writable: true } : undefined,
    });
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    const previous = this.getAttribute(name);
    const next = String(value);
    this.attributes.set(name, next);
    this.#changed(name, previous, next);
  }

  removeAttribute(name: string): void {
    if (!this.attributes.has(name)) return;
    const previous = this.getAttribute(name);
    this.attributes.delete(name);
    this.#changed(name, previous, null);
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  toggleAttribute(name: string, force?: boolean): boolean {
    const on = force ?? !this.hasAttribute(name);
    if (on) this.setAttribute(name, "");
    else this.removeAttribute(name);
    return on;
  }

  get id(): string {
    return this.getAttribute("id") ?? "";
  }

  set id(value: string) {
    this.setAttribute("id", value);
  }

  get className(): string {
    return this.getAttribute("class") ?? "";
  }

  set className(value: string) {
    this.setAttribute("class", value);
  }

  get classList(): { add(...names: string[]): void; remove(...names: string[]): void; contains(name: string): boolean; toggle(name: string, force?: boolean): boolean } {
    const read = () => this.className.split(/\s+/u).filter(Boolean);
    const write = (names: string[]) => this.setAttribute("class", names.join(" "));
    return {
      add: (...names) => write([...new Set([...read(), ...names])]),
      remove: (...names) => write(read().filter((name) => !names.includes(name))),
      contains: (name) => read().includes(name),
      toggle: (name, force) => {
        const on = force ?? !read().includes(name);
        write(on ? [...new Set([...read(), name])] : read().filter((item) => item !== name));
        return on;
      },
    };
  }

  get hidden(): boolean {
    return this.hasAttribute("hidden");
  }

  set hidden(value: boolean) {
    this.toggleAttribute("hidden", Boolean(value));
  }

  get disabled(): boolean {
    return this.hasAttribute("disabled");
  }

  set disabled(value: boolean) {
    this.toggleAttribute("disabled", Boolean(value));
  }

  /** A form control's live value; falls back to the `value` attribute the way the platform does. */
  get value(): string {
    return this.#value ?? this.getAttribute("value") ?? "";
  }

  set value(value: string) {
    this.#value = String(value);
  }

  get min(): string { return this.getAttribute("min") ?? ""; }
  set min(value: string) { this.setAttribute("min", String(value)); }
  get max(): string { return this.getAttribute("max") ?? ""; }
  set max(value: string) { this.setAttribute("max", String(value)); }
  get step(): string { return this.getAttribute("step") ?? ""; }
  set step(value: string) { this.setAttribute("step", String(value)); }

  get innerHTML(): string {
    return this.childNodes.map(serialize).join("");
  }

  set innerHTML(html: string) {
    this.replaceChildren(...parseHtml(html));
  }

  get outerHTML(): string {
    return serialize(this);
  }

  attachShadow(init: { mode: string; delegatesFocus?: boolean }): FakeShadowRoot {
    if (this.shadowRoot) throw new Error("Shadow root already attached");
    this.shadowRoot = new FakeShadowRoot(this, init);
    return this.shadowRoot;
  }

  matches(selector: string): boolean {
    return parseSelector(selector).some((compound) => this.matchesCompound(compound));
  }

  closest<T extends FakeElement = FakeElement>(selector: string): T | null {
    let current: FakeNode | FakeShadowRoot | null = this;
    while (current instanceof FakeElement) {
      if (current.matches(selector)) return current as T;
      current = current.parentNode;
    }
    return null;
  }

  matchesCompound(compound: Compound): boolean {
    if (compound.tag && compound.tag !== this.localName) return false;
    if (compound.id && this.id !== compound.id) return false;
    const classes = this.className.split(/\s+/u).filter(Boolean);
    if (!compound.classes.every((name) => classes.includes(name))) return false;
    return compound.attributes.every(({ name, operator, value }) => {
      const actual = this.getAttribute(name);
      if (actual === null) return false;
      if (!operator || value === undefined) return true;
      return operator === "=" ? actual === value : actual.split(/\s+/u).includes(value);
    });
  }

  click(): void {
    this.dispatchEvent(new Event("click", { bubbles: true, cancelable: true, composed: true }));
  }

  override cloneNode(deep = false): FakeElement {
    const copy = this instanceof FakeTemplate ? new FakeTemplate() : new FakeElement(this.localName);
    for (const [name, value] of this.attributes) copy.attributes.set(name, value);
    if (deep) {
      for (const child of this.childNodes) copy.append(child.cloneNode(true));
      if (this instanceof FakeTemplate && copy instanceof FakeTemplate) for (const child of this.content.childNodes) copy.content.append(child.cloneNode(true));
    }
    return copy;
  }

  #changed(name: string, previous: string | null, next: string | null): void {
    const observed = (this.constructor as { observedAttributes?: readonly string[] }).observedAttributes;
    if (observed?.includes(name)) callbacks(this).attributeChangedCallback?.(name, previous, next);
  }
}

function dashed(key: string): string {
  return key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
}

function camel(name: string): string {
  return name.replace(/-([a-z])/gu, (_all, letter: string) => letter.toUpperCase());
}

function serialize(node: FakeNode): string {
  if (node instanceof FakeText) return encode(node.data);
  if (!(node instanceof FakeElement)) return "";
  const attributes = [...node.attributes].map(([name, value]) => value === "" ? ` ${name}` : ` ${name}="${encode(value)}"`).join("");
  if (VOID_TAGS.has(node.localName)) return `<${node.localName}${attributes}>`;
  const inner = node instanceof FakeTemplate ? node.content.childNodes.map(serialize).join("") : node.childNodes.map(serialize).join("");
  return `<${node.localName}${attributes}>${inner}</${node.localName}>`;
}

export class FakeTemplate extends FakeElement {
  readonly content = new FakeDocumentFragment();

  constructor() {
    super("template");
  }

  override get innerHTML(): string {
    return this.content.childNodes.map(serialize).join("");
  }

  override set innerHTML(html: string) {
    this.content.replaceChildren(...parseHtml(html));
  }
}

const TOKEN = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/gu;
const ATTRIBUTE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/gu;

/** Enough HTML for a template: elements with attributes, text, comments; no entities beyond the five. */
export function parseHtml(html: string): FakeNode[] {
  const roots: FakeNode[] = [];
  const stack: FakeElement[] = [];
  const add = (node: FakeNode) => {
    const parent = stack.at(-1);
    if (parent) parent.append(node);
    else roots.push(node);
  };
  for (const token of html.matchAll(TOKEN)) {
    if (token[0].startsWith("<!--")) continue;
    if (token[1]) {
      const name = token[1].toLowerCase();
      while (stack.length) if (stack.pop()!.localName === name) break;
      continue;
    }
    if (token[2]) {
      const name = token[2].toLowerCase();
      const element = name === "template" ? new FakeTemplate() : new FakeElement(name);
      for (const attribute of (token[3] ?? "").matchAll(ATTRIBUTE)) {
        element.attributes.set(attribute[1]!, decode(attribute[2] ?? attribute[3] ?? attribute[4] ?? ""));
      }
      add(element);
      if (!token[4] && !VOID_TAGS.has(name) && !(element instanceof FakeTemplate)) stack.push(element);
      continue;
    }
    if (token[5]) add(new FakeText(decode(token[5])));
  }
  return roots;
}

export class FakeHTMLElement extends FakeElement {
  constructor() {
    super();
  }
}

class FakeRegistry {
  readonly #definitions = new Map<string, CustomElementConstructor>();

  define(tag: string, cls: CustomElementConstructor): void {
    if (this.#definitions.has(tag)) throw new Error(`"${tag}" is already defined`);
    this.#definitions.set(tag, cls);
  }

  get(tag: string): CustomElementConstructor | undefined {
    return this.#definitions.get(tag);
  }

  tagFor(cls: unknown): string | undefined {
    for (const [tag, definition] of this.#definitions) if (definition === cls) return tag;
    return undefined;
  }

  create(tag: string): FakeElement {
    const cls = this.#definitions.get(tag.toLowerCase());
    if (!cls) return new FakeElement(tag);
    constructing.push(tag.toLowerCase());
    try {
      return new cls() as unknown as FakeElement;
    } finally {
      constructing.pop();
    }
  }
}

const registry = new FakeRegistry();

export class FakeDocument extends FakeContainer {
  readonly documentElement: FakeElement;
  readonly head: FakeElement;
  readonly body: FakeElement;
  hidden = false;

  constructor() {
    super();
    this.isConnected = true;
    this.documentElement = new FakeElement("html");
    this.documentElement.setAttribute("lang", "en");
    this.head = new FakeElement("head");
    this.body = new FakeElement("body");
    this.append(this.documentElement);
    this.documentElement.append(this.head, this.body);
  }

  createElement(tag: string): FakeElement {
    if (tag.toLowerCase() === "template") return new FakeTemplate();
    return registry.create(tag);
  }

  createTextNode(text: string): FakeText {
    return new FakeText(text);
  }

  getElementById(id: string): FakeElement | null {
    return this.querySelector(`#${id}`);
  }
}

export class FakeCSSStyleSheet {
  cssText = "";

  replaceSync(css: string): void {
    this.cssText = css;
  }
}

export class FakeWindow extends FakeEventTarget {
  ht: HtRuntime;
  #timers = 0;

  constructor(ht: HtRuntime) {
    super();
    this.ht = ht;
  }

  /** Timers never fire: a theme entry's real state client may schedule its stream, but never opens it under test. */
  setTimeout(_fn: () => void, _ms?: number): number {
    return ++this.#timers;
  }

  clearTimeout(_handle?: number): void {}
}

/** A translator that echoes keys and parameters, so assertions read as catalog keys. */
export function fakeTranslate(key: string, params?: MessageParams): string {
  const entries = Object.entries(params ?? {});
  return entries.length ? `${key}{${entries.map(([name, value]) => `${name}=${value}`).join(",")}}` : key;
}

export function fakeRuntime(): HtRuntime {
  const t = fakeTranslate as HtRuntime["t"];
  return {
    t,
    locale: "en",
    time: (value) => `time(${typeof value === "string" ? value : new Date(value).toISOString()})`,
    dateTime: (value) => `dateTime(${typeof value === "string" ? value : new Date(value).toISOString()})`,
    relativeTime: (value) => `relativeTime(${typeof value === "string" ? value : new Date(value).toISOString()})`,
    number: (value, options) => new Intl.NumberFormat("en", options).format(value),
    availability: (value) => t(`status.${value === "online" || value === "offline" || value === "degraded" ? value : "unknown"}` as "status.online"),
    request: () => Promise.reject(new Error("no request in tests")),
    say: () => {},
    live: (element, observedAt) => {
      if (element instanceof Element) {
        if (observedAt) element.setAttribute("data-live", observedAt);
        else element.removeAttribute("data-live");
      }
      return element;
    },
    errorOf: (payload, fallback) => (payload as { error?: { message?: string } } | null)?.error?.message ?? fallback,
  };
}

/** A scripted state client: tests push records and decide how each invoke settles. */
export interface FakeStateClient extends StateClient {
  readonly subscriptions: { node: NodeId; tier: Tier; listener: StoreListener; released: boolean }[];
  readonly invocations: { node: NodeId; capability: string; controlId: string; value: unknown }[];
  /** Deliver a record to every live subscriber of its node (stale false unless told). */
  push(record: NodeRecord, stale?: boolean): StoredRecord;
  /** The next invoke waits for `settle()`; `fail(message)` rejects it instead. */
  settle(): void;
  fail(message: string): void;
  setConnection(state: ConnectionState): void;
}

export function fakeStateClient(): FakeStateClient {
  const subscriptions: FakeStateClient["subscriptions"] = [];
  const invocations: FakeStateClient["invocations"] = [];
  const records = new Map<NodeId, StoredRecord>();
  const listeners = new Set<ConnectionListener>();
  let connection: ConnectionState = "live";
  let waiting: { resolve: () => void; reject: (error: Error) => void } | undefined;
  return {
    subscriptions,
    invocations,
    subscribe(node, listener, tier) {
      const entry = { node, tier, listener, released: false };
      subscriptions.push(entry);
      const cached = records.get(node);
      if (cached) listener(cached);
      return () => { entry.released = true; };
    },
    read: (node) => records.get(node),
    invoke(node, capability, controlId, value) {
      invocations.push({ node, capability, controlId, value });
      return new Promise<void>((resolve, reject) => { waiting = { resolve, reject }; });
    },
    get connection() {
      return connection;
    },
    generation: "dev",
    onConnection(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    close() {},
    push(record, stale = false) {
      const stored = { ...record, stale };
      records.set(record.node, stored);
      for (const entry of subscriptions) if (!entry.released && entry.node === record.node) entry.listener(stored);
      return stored;
    },
    settle() {
      waiting?.resolve();
      waiting = undefined;
    },
    fail(message) {
      waiting?.reject(new Error(message));
      waiting = undefined;
    },
    setConnection(state) {
      connection = state;
      for (const listener of listeners) listener(state);
    },
  };
}

export interface TestDom {
  readonly document: FakeDocument;
  readonly window: FakeWindow;
  readonly ht: HtRuntime;
  /** A fresh body and a fresh `ht.state`; definitions stay (a tag can be defined once per process). */
  reset(): FakeStateClient;
}

interface Installed {
  document: FakeDocument;
  window: FakeWindow;
}

const INSTALLED = Symbol.for("hometruth.test-dom");

/** Put the fake DOM on `globalThis`; call it before importing an element module. Idempotent per process. */
export function installTestDom(): TestDom {
  const globals = globalThis as unknown as Record<PropertyKey, unknown>;
  let installed = globals[INSTALLED] as Installed | undefined;
  if (!installed) {
    const ht = fakeRuntime();
    installed = { document: new FakeDocument(), window: new FakeWindow(ht) };
    globals[INSTALLED] = installed;
    globals.document = installed.document;
    globals.window = installed.window;
    globals.Element = FakeElement;
    globals.HTMLElement = FakeHTMLElement;
    globals.HTMLTemplateElement = FakeTemplate;
    globals.customElements = registry;
    globals.CSSStyleSheet = FakeCSSStyleSheet;
    globals.EventSource = class { static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSED = 2; };
  }
  const dom = installed;
  return {
    document: dom.document,
    window: dom.window,
    ht: dom.window.ht,
    reset() {
      dom.document.body.replaceChildren();
      dom.document.head.replaceChildren();
      const client = fakeStateClient();
      dom.window.ht.state = client;
      return client;
    },
  };
}
