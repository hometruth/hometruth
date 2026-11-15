/** First script in a static export: every transport terminates in this browser. */
import { DemoError, DemoState, demoCookieWrites, readDemoCookie, type DemoData } from "./state";

const object = (value: unknown): Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const json = (value: unknown, status = 200): Response => Response.json(value, { status, headers: { "cache-control": "no-store" } });
const error = (message: string, status = 404): Response => json({ error: { code: "demo_not_supported", message }, demo: true }, status);
const CAMERA_IMAGE = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540"><rect width="960" height="540" fill="#f0eadd"/><path d="M0 380L240 220 400 340 650 140 960 380V540H0Z" fill="#d5dccb"/><circle cx="760" cy="110" r="44" fill="#d4b56d"/><rect x="270" y="185" width="420" height="155" rx="8" fill="#f8f4e9"/><text x="480" y="245" font-family="Georgia,serif" font-size="32" fill="#292c28" text-anchor="middle">Pretend camera</text><text x="480" y="290" font-family="Arial,sans-serif" font-size="20" fill="#4d5748" text-anchor="middle">No camera is connected</text></svg>')}`;

export function demoCameraPath(path: string, basePath: string): string | undefined {
  const local = basePath && path.startsWith(`${basePath}/`) ? path.slice(basePath.length) : path;
  return /^\/api\/cameras\/[^/]+\/(?:snapshot|stream\.mjpeg|photos\/[^/?]+)(?:\?|$)/.test(local) ? CAMERA_IMAGE : undefined;
}

/** Exported separately so tests prove even absolute and unknown URLs never escape. */
export function createDemoFetch(state: DemoState, origin: string): typeof fetch {
  const basePath = state.snapshot.basePath;
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    try {
      if (init?.signal?.aborted || input instanceof Request && input.signal.aborted) throw new DOMException("The request was aborted", "AbortError");
      const url = new URL(input instanceof Request ? input.url : String(input), origin);
      if (url.origin !== origin) return error("External connections are disabled in this demo.");
      let path = url.pathname;
      if (basePath && (path === basePath || path.startsWith(`${basePath}/`))) path = path.slice(basePath.length) || "/";
      const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const raw = init?.body ?? (input instanceof Request && !["GET", "HEAD"].includes(method) ? await input.clone().text() : undefined);
      let body: Record<string, any> = {};
      if (typeof raw === "string" && raw) {
        try { body = object(JSON.parse(raw)); }
        catch { return error("The demo expected a JSON request.", 400); }
      }
      if (path === "/api/graph") return json(state.snapshot.graph ?? { nodes: [], edges: [] });
      if (path === "/api/graph/scene") return json(state.snapshot.graphScene ?? { nodes: [], edges: [] });
      if (path === "/api/devices" && method === "GET") return json({ devices: state.snapshot.devices.map(device => ({ ...device, status: "online" })) });
      if (parts[0] !== "api") return error("This action is not available in the static demo.");
      if (parts[1] === "state") return json({ records: state.records() });
      if (method === "GET" && (path === "/api/events" || /^\/api\/devices\/[^/]+\/events$/.test(path))) return json({ events: [], nextCursor: null, detectionLabels: [], demo: true });
      if (parts[1] === "cameras" && parts[2] && parts[3] === "photos") return json({ photos: [], total: 0, sync: { running: false, lastSuccessAt: new Date().toISOString() }, demo: true });
      if (parts[1] === "devices" && parts[2]) {
        const node = `device/${parts[2]}`;
        const current = state.read(node);
        if (!current) return error("This device is not in the demo.");
        if (parts.length === 3 && method === "GET") return json({ object: current.value, demo: true });
        if (parts[3] === "capabilities" && parts[4] && parts[5] === "controls" && parts[6] && method === "POST") {
          const record = state.invoke(node, parts[4], parts[6], body.value);
          return json({ object: record.value, ok: true, demo: true });
        }
        if (parts[3] === "controls" && parts[4] && method === "POST") {
          const capabilities = object(object(current.value).capabilities);
          const capability = Object.keys(capabilities).find(kind => Object.hasOwn(object(capabilities[kind].actions), parts[4]!));
          if (!capability) return error("This control is not available in the demo.");
          const record = state.invoke(node, capability, parts[4], body.value);
          return json({ object: record.value, ok: true, demo: true });
        }
      }
      if (parts[1] === "switches" && parts[2]) {
        const control = parts[3] === "state" ? "getState" : camel(parts[3] ?? "getState");
        if ((control === "getState" && method === "GET") || method === "POST") {
          const record = state.invoke(`device/${parts[2]}`, "binarySwitch", control, body.value);
          return json({ object: record.value, ...object(object(record.value).capabilities).binarySwitch, demo: true });
        }
      }
      if (parts[1] === "buttons" && parts[2] && parts[3] === "press" && method === "POST") {
        const record = state.invoke(`device/${parts[2]}`, "button", "press", body);
        return json({ object: record.value, ok: true, demo: true });
      }
      if (parts[1] === "device-groups" && parts[2]) {
        const id = parts[2];
        if (parts.length === 3 && method === "GET") return json(state.groupSnapshot(id));
        if (parts[3] === "switch" && (method === "POST" || method === "GET" && !parts[4])) {
          const record = state.invoke(`group/${id}`, "binarySwitch", parts[4] ? camel(parts[4]) : "getState");
          return json({ object: record.value, ...object(record.value), demo: true });
        }
        if (parts[3] === "controls" && parts[4] && method === "POST") {
          const [capability, control] = parts[4].split(".");
          if (!capability || !control) return error("Choose a group control.", 400);
          state.invoke(`group/${id}`, capability, control, body.value);
          const group = state.groupSnapshot(id);
          return json({ ok: true, group, results: group.members.map((member: Record<string, unknown>) => ({ id: member.id, name: member.name, ok: true })), demo: true });
        }
      }
      // Never call a saved native fetch, including for an unrecognized API.
      return error("This action is not simulated in the demo. No real device was contacted.", 501);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
      return error(cause instanceof Error ? cause.message : "The demo could not perform this action.", cause instanceof DemoError ? cause.status : 400);
    }
  }) as typeof fetch;
}

const camel = (value: string): string => value.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());

export function createDemoEventSource(state: DemoState, origin: string): typeof EventSource {
  class DemoEventSource extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSED = 2;
    readonly withCredentials = false;
    readonly url: string;
    readyState = 0;
    onopen: ((event: Event) => unknown) | null = null;
    onmessage: ((event: MessageEvent) => unknown) | null = null;
    onerror: ((event: Event) => unknown) | null = null;
    #release: (() => void) | undefined;

    constructor(url: string | URL) {
      super();
      this.url = new URL(url, origin).href;
      const parsed = new URL(this.url);
      let path = parsed.pathname;
      if (state.snapshot.basePath && path.startsWith(`${state.snapshot.basePath}/`)) path = path.slice(state.snapshot.basePath.length);
      const nodes = new Set(parsed.searchParams.getAll("node"));
      queueMicrotask(() => {
        if (this.readyState === this.CLOSED) return;
        const eventLog = /^\/api\/(?:events|devices\/[^/]+\/events)\/stream$/.test(path);
        if (parsed.origin !== origin || path !== "/api/state/stream" && !eventLog) {
          this.readyState = this.CLOSED;
          const event = new Event("error"); this.dispatchEvent(event); this.onerror?.(event); return;
        }
        this.readyState = this.OPEN;
        const open = new Event("open"); this.dispatchEvent(open); this.onopen?.(open);
        if (eventLog) return;
        this.#emit("hello", { generation: "static-demo", tier: parsed.searchParams.get("tier") ?? "glance", nodes: [...nodes], keepaliveMs: 20000 });
        const publish = () => { for (const record of state.records()) if (nodes.has(record.node)) this.#emit("state", record); };
        this.#release = state.onChange(publish);
        publish();
      });
    }

    #emit(type: string, data: unknown): void {
      if (this.readyState !== this.OPEN) return;
      const event = new MessageEvent(type, { data: JSON.stringify(data) });
      this.dispatchEvent(event);
      if (type === "message") this.onmessage?.(event);
    }

    close(): void { this.readyState = this.CLOSED; this.#release?.(); }
  }
  return DemoEventSource as unknown as typeof EventSource;
}

export function installDemo(document: Document, window: Window & typeof globalThis): DemoState | undefined {
  const source = document.getElementById("ht-demo");
  if (!source?.textContent) return undefined;
  const snapshot = JSON.parse(source.textContent) as DemoData;
  if (snapshot.version !== 1 || !Array.isArray(snapshot.records) || !Array.isArray(snapshot.devices) || !Array.isArray(snapshot.groups)) throw new Error("Invalid demo snapshot");
  const state = new DemoState(snapshot, readDemoCookie(document.cookie));
  window.fetch = createDemoFetch(state, window.location.origin);
  window.EventSource = createDemoEventSource(state, window.location.origin);
  // Camera pages assign image.src directly. Resolve that URL to an inline drawing
  // before the shell initializes, so it never makes an image HTTP request.
  let runtime: Record<string, any> | undefined;
  Object.defineProperty(window, "ht", {
    configurable: true,
    get: () => runtime,
    set: value => {
      runtime = value;
      const apiPath = value.apiPath;
      value.apiPath = (path: string) => demoCameraPath(path, snapshot.basePath) ?? apiPath(path);
    },
  });
  const save = () => {
    const value = state.persist();
    for (const cookie of demoCookieWrites(value, snapshot.basePath, window.location.protocol === "https:")) document.cookie = cookie;
    const output = document.querySelector("[data-demo-status]");
    if (output) output.textContent = value && readDemoCookie(document.cookie) !== value ? "Cookies are blocked. Changes last until you leave this page." : "Pretend controls · saved in this browser";
  };
  state.onChange(save);
  const wire = () => {
    // The real components seed themselves from this element before opening a stream.
    const seed = document.getElementById("ht-state");
    if (seed) seed.textContent = JSON.stringify(state.records());
    let banner = document.querySelector("[data-demo-banner]");
    if (!banner) {
      banner = document.createElement("aside");
      banner.setAttribute("data-demo-banner", "");
      banner.setAttribute("aria-label", "Demo mode");
      banner.innerHTML = '<strong>Demo</strong> <span data-demo-status>Pretend controls · saved in this browser</span> <button type="button" class="btn" data-demo-reset>Reset demo</button>';
      document.body.prepend(banner);
    }
    document.querySelectorAll("[data-demo-reset]").forEach(button => button.addEventListener("click", () => {
      state.reset();
      const output = document.querySelector("[data-demo-status]");
      if (output) output.textContent = "Demo reset. Everything is back to its starting state.";
    }));
    // Forms outside the ordinary button handlers must not submit to a real server.
    document.addEventListener("submit", event => event.preventDefault());
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire, { once: true });
  else wire();
  return state;
}

if (typeof document !== "undefined" && typeof window !== "undefined") installDemo(document, window);
