/**
 * The page's one link to the state graph: a `StateStore` behind an
 * `EventSource` on `GET /api/state/stream`, plus the write path components
 * use. Every platform dependency is injected (`EventSource`, `fetch`,
 * `document`, `window`, timers) so `bun test` drives the whole life cycle:
 * one stream per page, held while the page is visible even with no nodes
 * (its `hello` names the worker generation the runtime notice compares), subscription changes coalesced for 20 ms and applied
 * by reopening the stream without dropping `live`, explicit reopen with
 * capped backoff once the browser gives up (`readyState === CLOSED`), closed
 * while the page is hidden, and a pending window on every command that ends
 * with the node's next signal or 2 s after the response, whichever is first.
 */
import type { NodeId, NodeRecord, StreamError, StreamHello, StreamObserved, Tier } from "../../state/protocol.ts";
import { readControlPath } from "./control-routes.ts";
import { StateStore, type StoredRecord, type StoreListener } from "./store.ts";

export type ConnectionState = "connecting" | "live" | "disconnected" | "hidden";
export type ConnectionListener = (state: ConnectionState) => void;

export interface StateClient {
  /** Subscribe to a node; the cached record, if any, is delivered synchronously. Returns the release. */
  subscribe(node: NodeId, listener: StoreListener, tier: Tier): () => void;
  read(node: NodeId): StoredRecord | undefined;
  /**
   * Invoke one control through the capability route (or the group switch
   * route). Resolves when the node's next `state`/`observed` signal lands
   * after the response, or 2 s after it; rejects with the API's message.
   */
  invoke(node: NodeId, capability: string, controlId: string, value?: unknown): Promise<void>;
  readonly connection: ConnectionState;
  /** The worker generation the current stream's `hello` named; undefined until the first one. */
  readonly generation: string | undefined;
  /** Called on every connection change, and on a `hello` from a different worker generation. */
  onConnection(listener: ConnectionListener): () => void;
  /** Close the stream and stop timers; the page is going away. */
  close(): void;
}

export interface StreamEvent {
  readonly type: string;
  /** A server frame carries JSON text; the browser's own connection error carries nothing. */
  readonly data?: unknown;
}

export interface StreamSource {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: StreamEvent) => void): void;
  close(): void;
}

export type StreamSourceConstructor = new (url: string) => StreamSource;

export interface ResponseLike {
  readonly ok: boolean;
  json(): Promise<unknown>;
}

export interface RequestInitLike {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly cache?: "no-store";
  readonly credentials?: "same-origin";
}

export interface DocumentLike {
  readonly hidden: boolean;
  addEventListener(type: string, listener: () => void): void;
}

export interface WindowLike {
  addEventListener(type: string, listener: () => void): void;
  /** The inline runtime, read lazily for the request-failed message; a test injects a fake. */
  readonly ht?: { readonly t: (key: "feedback.requestFailed") => string };
}

export interface StateClientDeps {
  readonly EventSource: StreamSourceConstructor;
  readonly fetch: (url: string, init?: RequestInitLike) => Promise<ResponseLike>;
  readonly document: DocumentLike;
  readonly window: WindowLike;
  readonly setTimeout: (fn: () => void, ms: number) => number;
  readonly clearTimeout: (handle: number) => void;
  /** Records embedded in `#ht-state`; cached as stale until the stream confirms them. */
  readonly seed?: readonly NodeRecord[];
}

/** `EventSource.CLOSED`: the browser will not retry by itself; the client reopens with backoff. */
export const CLOSED = 2;
export const COALESCE_MS = 20;
export const BACKOFF_MIN_MS = 2_000;
export const BACKOFF_MAX_MS = 30_000;
export const SETTLE_MS = 2_000;
export const STREAM_PATH = "/api/state/stream";

/** The stream URL for a node set and tier; nodes are already sorted by the store. */
export function streamUrl(nodes: readonly NodeId[], tier: Tier): string {
  const query = nodes.map((node) => `node=${encodeURIComponent(node)}`);
  return `${STREAM_PATH}?${[...query, `tier=${tier}`].join("&")}`;
}

function kebab(controlId: string): string {
  return controlId.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
}

function splitNode(node: NodeId): { kind: string; id: string } {
  const slash = node.indexOf("/");
  return { kind: node.slice(0, slash), id: node.slice(slash + 1) };
}

/**
 * Reads use GET resources; writes use the generic capability route for a
 * device or the switch route for a group or automation (`turnOn` → `turn-on`).
 */
export function controlUrl(node: NodeId, capability: string, controlId: string): string {
  const { kind, id } = splitNode(node);
  if (kind === "group" || kind === "automation") {
    const base = kind === "group" ? `/api/device-groups/${encodeURIComponent(id)}/switch` : `/api/automations/${encodeURIComponent(id)}/switch`;
    return controlId === "getState" ? base : `${base}/${kebab(controlId)}`;
  }
  return readControlPath(id, capability, controlId)
    ?? `/api/devices/${encodeURIComponent(id)}/capabilities/${encodeURIComponent(capability)}/controls/${encodeURIComponent(controlId)}`;
}

export interface ControlRequest {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly body?: string;
}

/** Reads have no body. Writes send JSON, `{}` when the control takes no value. */
export function controlRequest(node: NodeId, capability: string, controlId: string, value?: unknown): ControlRequest {
  const url = controlUrl(node, capability, controlId);
  const { kind, id } = splitNode(node);
  const read = kind === "device" ? readControlPath(id, capability, controlId) !== undefined : controlId === "getState";
  if (read) return { url, method: "GET" };
  return { url, method: "POST", body: JSON.stringify(value === undefined ? {} : { value }) };
}

/** The `#ht-state` snapshot a page embeds, or nothing when the page has none or it does not parse. */
export function readSeed(document: { getElementById(id: string): { textContent: string | null } | null }): NodeRecord[] {
  const text = document.getElementById("ht-state")?.textContent;
  if (!text) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as NodeRecord[]) : [];
  } catch {
    return [];
  }
}

function parseFrame(event: StreamEvent): unknown {
  if (typeof event.data !== "string") return undefined;
  try {
    return JSON.parse(event.data);
  } catch {
    return undefined;
  }
}

function errorMessage(payload: unknown, fallback: string): string {
  const error = (payload as { error?: { message?: unknown } } | null)?.error;
  return typeof error?.message === "string" && error.message ? error.message : fallback;
}

interface Waiter {
  readonly node: NodeId;
  readonly resolve: () => void;
}

class Client implements StateClient {
  readonly #deps: StateClientDeps;
  readonly #store: StateStore;
  readonly #listeners = new Set<ConnectionListener>();
  readonly #waiters = new Set<Waiter>();
  #connection: ConnectionState;
  #source: StreamSource | undefined;
  #url = "";
  #syncTimer: number | undefined;
  #reopenTimer: number | undefined;
  #backoff = BACKOFF_MIN_MS;
  #closed = false;
  #generation: string | undefined;

  constructor(deps: StateClientDeps) {
    this.#deps = deps;
    this.#store = new StateStore(deps.seed ?? []);
    this.#connection = deps.document.hidden ? "hidden" : "connecting";
    deps.document.addEventListener("visibilitychange", () => {
      if (deps.document.hidden) this.#hide();
      else this.#schedule();
    });
    deps.window.addEventListener("pagehide", () => this.#hide());
    deps.window.addEventListener("pageshow", () => this.#schedule());
    // A page without elements still holds its one stream.
    if (!deps.document.hidden) this.#schedule();
  }

  get connection(): ConnectionState {
    return this.#connection;
  }

  get generation(): string | undefined {
    return this.#generation;
  }

  onConnection(listener: ConnectionListener): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  subscribe(node: NodeId, listener: StoreListener, tier: Tier): () => void {
    const release = this.#store.subscribe(node, listener, tier);
    this.#schedule();
    const cached = this.#store.read(node);
    if (cached) listener(cached);
    return () => {
      release();
      this.#schedule();
    };
  }

  read(node: NodeId): StoredRecord | undefined {
    return this.#store.read(node);
  }

  async invoke(node: NodeId, capability: string, controlId: string, value?: unknown): Promise<void> {
    const request = controlRequest(node, capability, controlId, value);
    let signalled = false;
    const waiter: Waiter = { node, resolve: () => { signalled = true; } };
    this.#waiters.add(waiter);
    let payload: unknown;
    let ok: boolean;
    try {
      const response = await this.#deps.fetch(request.url, {
        method: request.method,
        cache: "no-store",
        credentials: "same-origin",
        headers: { accept: "application/json", ...(request.body === undefined ? {} : { "content-type": "application/json" }) },
        ...(request.body === undefined ? {} : { body: request.body }),
      });
      ok = response.ok;
      payload = await response.json().catch(() => null);
    } catch (error) {
      this.#waiters.delete(waiter);
      throw error instanceof Error ? error : new Error(this.#requestFailed());
    }
    if (!ok) {
      this.#waiters.delete(waiter);
      throw new Error(errorMessage(payload, this.#requestFailed()));
    }
    if (signalled) {
      this.#waiters.delete(waiter);
      return;
    }
    await new Promise<void>((resolve) => {
      const settle = () => {
        this.#deps.clearTimeout(timer);
        this.#waiters.delete(waiter);
        this.#waiters.delete(late);
        resolve();
      };
      const late: Waiter = { node, resolve: settle };
      this.#waiters.delete(waiter);
      this.#waiters.add(late);
      const timer = this.#deps.setTimeout(settle, SETTLE_MS);
    });
  }

  close(): void {
    this.#closed = true;
    this.#clearTimers();
    this.#closeStream();
  }

  #requestFailed(): string {
    return this.#deps.window.ht?.t("feedback.requestFailed") ?? "feedback.requestFailed";
  }

  #set(state: ConnectionState, force = false): void {
    if (this.#connection === state && !force) return;
    this.#connection = state;
    for (const listener of [...this.#listeners]) listener(state);
  }

  #signal(node: NodeId): void {
    for (const waiter of [...this.#waiters]) if (waiter.node === node) waiter.resolve();
  }

  #clearTimers(): void {
    if (this.#syncTimer !== undefined) this.#deps.clearTimeout(this.#syncTimer);
    if (this.#reopenTimer !== undefined) this.#deps.clearTimeout(this.#reopenTimer);
    this.#syncTimer = undefined;
    this.#reopenTimer = undefined;
  }

  /** Coalesce subscription churn (a list re-rendering its rows) into one reopen. */
  #schedule(): void {
    if (this.#closed || this.#syncTimer !== undefined) return;
    this.#syncTimer = this.#deps.setTimeout(() => {
      this.#syncTimer = undefined;
      this.#sync();
    }, COALESCE_MS);
  }

  #hide(): void {
    this.#clearTimers();
    this.#closeStream();
    this.#store.markStale();
    this.#set("hidden");
  }

  #closeStream(): void {
    const source = this.#source;
    this.#source = undefined;
    this.#url = "";
    source?.close();
  }

  #sync(): void {
    if (this.#closed) return;
    if (this.#deps.document.hidden) {
      this.#hide();
      return;
    }
    const { nodes, tier } = this.#store.wanted();
    const url = streamUrl(nodes, tier);
    if (this.#source && this.#url === url && this.#source.readyState !== CLOSED) return;
    this.#open(url);
  }

  /** Open the stream for a node set; an intentional reopen keeps `live` until the new stream fails. */
  #open(url: string): void {
    this.#closeStream();
    this.#url = url;
    const source = new this.#deps.EventSource(url);
    this.#source = source;
    const current = () => source === this.#source;
    source.addEventListener("hello", (event) => {
      if (!current()) return;
      const hello = parseFrame(event) as StreamHello | undefined;
      if (!hello) return;
      this.#backoff = BACKOFF_MIN_MS;
      const replaced = this.#generation !== undefined && this.#generation !== hello.generation;
      this.#generation = hello.generation;
      this.#set("live", replaced);
    });
    source.addEventListener("state", (event) => {
      if (!current()) return;
      const record = parseFrame(event) as NodeRecord | undefined;
      if (!record || typeof record.node !== "string") return;
      this.#store.apply(record);
      this.#signal(record.node);
    });
    source.addEventListener("observed", (event) => {
      if (!current()) return;
      const observed = parseFrame(event) as StreamObserved | undefined;
      if (!observed || typeof observed !== "object") return;
      this.#store.observed(observed);
      for (const node of Object.keys(observed)) this.#signal(node as NodeId);
    });
    source.addEventListener("error", (event) => {
      if (!current()) return;
      this.#store.markStale();
      this.#set("disconnected");
      const frame = parseFrame(event) as StreamError | undefined;
      if (frame) return; // The server said it is full and closed; its `retry` governs the browser's next attempt.
      if (source.readyState === CLOSED) {
        this.#source = undefined;
        this.#url = "";
        this.#scheduleReopen();
      }
    });
    if (this.#connection === "hidden") this.#set("connecting");
  }

  #scheduleReopen(): void {
    if (this.#closed || this.#reopenTimer !== undefined) return;
    const delay = this.#backoff;
    this.#backoff = Math.min(this.#backoff * 2, BACKOFF_MAX_MS);
    this.#reopenTimer = this.#deps.setTimeout(() => {
      this.#reopenTimer = undefined;
      this.#sync();
    }, delay);
  }
}

export function createStateClient(deps: StateClientDeps): StateClient {
  return new Client(deps);
}

// The real platform objects satisfy the injected shapes; a mismatch fails here, not in a browser.
type Check = typeof EventSource extends StreamSourceConstructor ? true : never;
export const PLATFORM_SHAPES_MATCH: Check = true;
