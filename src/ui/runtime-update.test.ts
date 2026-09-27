import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { runtimeUpdateScript } from "./runtime-update";

type Connection = "connecting" | "live" | "disconnected" | "hidden";

/** Execute the browser script against a fake state client; nothing opens a socket. */
function page(version = "session-1:ready", options: { state?: boolean; loaded?: boolean } = {}) {
  let reloads = 0;
  const documentListeners = new Map<string, () => void>();
  class Element {
    className = "";
    textContent = "";
    type = "";
    value = "";
    hidden = false;
    inert = false;
    readonly children: Element[] = [];
    readonly attributes = new Map<string, string>();
    readonly listeners = new Map<string, () => void>();
    readonly tagName: string;
    constructor(tag: string) { this.tagName = tag.toUpperCase(); }
    append(...elements: Element[]) { this.children.push(...elements); }
    prepend(element: Element) { this.children.unshift(element); }
    setAttribute(name: string, value: string) { this.attributes.set(name, value); }
    removeAttribute(name: string) { this.attributes.delete(name); }
    addEventListener(name: string, callback: () => void) { this.listeners.set(name, callback); }
  }
  const root = new Element("html");
  const body = new Element("body");
  const main = new Element("main");
  const input = new Element("input");
  input.value = "An unsaved edit";
  main.append(input);
  body.append(new Element("header"), main, new Element("footer"));
  const listeners = new Set<(state: Connection) => void>();
  const state = {
    connection: "connecting" as Connection,
    generation: undefined as string | undefined,
    onConnection(listener: (state: Connection) => void) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const ht: { t: (key: string) => string; state?: typeof state } = { t: (key: string) => key };
  if (options.state !== false && options.loaded !== false) ht.state = state;
  const document = { body, documentElement: root, createElement: (tag: string) => new Element(tag), querySelector: () => main,
    addEventListener: (name: string, callback: () => void) => documentListeners.set(name, callback),
  };
  runInNewContext(runtimeUpdateScript(version), { location: { reload() { reloads++; } }, document, ht });
  return {
    main, input, connection: body.children[0]!,
    get notice() { return main.children.find(element => element.className === "bar runtime-update"); },
    get unavailable() { return root.attributes.get("data-runtime-state") === "unavailable"; },
    get heading() { return this.connection.children[0]!.textContent; },
    reloads: () => reloads,
    listeners,
    /** The module script runs, then DOMContentLoaded fires. */
    load: () => { if (options.state !== false) ht.state = state; documentListeners.get("DOMContentLoaded")?.(); },
    set: (connection: Connection, generation?: string) => {
      if (generation) state.generation = generation;
      state.connection = connection;
      for (const listener of [...listeners]) listener(connection);
    },
  };
}

test("the script opens no connection of its own; it follows the page's state stream", () => {
  const source = runtimeUpdateScript("session-1:ready");
  expect(source).not.toContain("EventSource");
  expect(source).not.toContain("_runtime/events");
  const browser = page();
  expect(browser.listeners.size).toBe(1);
});

test("fresh server HTML is usable immediately without a readiness check", () => {
  const browser = page();
  expect(browser.unavailable).toBe(false);
  expect(browser.connection.hidden).toBe(true);
  browser.set("live", "session-1");
  expect(browser.unavailable).toBe(false);
  expect(browser.notice).toBeUndefined();
});

test("a lost stream keeps the cached page and unsaved edits visible with a connection notice", () => {
  const browser = page();
  browser.set("live", "session-1");
  browser.set("disconnected");
  expect(browser.unavailable).toBe(true);
  expect(browser.main.inert).toBe(false);
  expect(browser.heading).toBe("status.serverConnecting");
  browser.set("live", "session-1");
  expect(browser.unavailable).toBe(false);
  expect(browser.input.value).toBe("An unsaved edit");
  expect(browser.reloads()).toBe(0);
});

test("hiding and showing a tab never flashes the connection notice", () => {
  const browser = page();
  browser.set("live", "session-1");
  browser.set("hidden");
  expect(browser.unavailable).toBe(false);
  browser.set("connecting");
  expect(browser.unavailable).toBe(false);
  browser.set("live", "session-1");
  expect(browser.unavailable).toBe(false);
});

test("a new worker generation shows one refresh notice and never navigates by itself", () => {
  const browser = page();
  browser.set("live", "session-1");
  for (let generation = 2; generation <= 50; generation++) browser.set("live", `session-${generation}`);
  expect(browser.reloads()).toBe(0);
  expect(browser.main.children).toHaveLength(2);
  const notice = browser.notice!;
  expect(notice.attributes.get("role")).toBe("status");
  expect(notice.children[0]!.textContent).toBe("status.pageUpdated");
  const refresh = notice.children[1]!;
  expect(refresh.hidden).toBe(false);
  refresh.listeners.get("click")!();
  expect(browser.unavailable).toBe(true);
  expect(browser.reloads()).toBe(1);
  browser.set("live", "session-50");
  expect(browser.unavailable).toBe(true);
});

test("a page rendered while services started says so, then asks for a refresh once ready", () => {
  const browser = page("session-2:ui");
  expect(browser.notice!.children[0]!.textContent).toBe("status.serverStarting");
  expect(browser.notice!.children[1]!.hidden).toBe(true);
  browser.set("live", "session-2");
  expect(browser.notice!.children[0]!.textContent).toBe("status.pageUpdated");
  expect(browser.notice!.children[1]!.hidden).toBe(false);
  expect(browser.reloads()).toBe(0);
});

test("the script attaches after the theme module installs ht.state", () => {
  const browser = page("session-1:ready", { loaded: false });
  expect(browser.listeners.size).toBe(0);
  browser.load();
  expect(browser.listeners.size).toBe(1);
  browser.set("live", "session-1");
  expect(browser.unavailable).toBe(false);
});

test("a page whose module never loaded says the server is unavailable", () => {
  const browser = page("session-1:ready", { state: false });
  browser.load();
  expect(browser.unavailable).toBe(true);
  expect(browser.heading).toBe("status.serverUnavailable");
  browser.connection.children[2]!.listeners.get("click")!();
  expect(browser.reloads()).toBe(1);
});

test("the version cannot close the inline script", () => {
  expect(runtimeUpdateScript("</script>")).not.toContain("</script>");
});
