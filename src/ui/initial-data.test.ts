import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { TAG_MANAGER_SCRIPT, renderTagsPage } from "./tags-page";
import { TAG_EDITOR_SCRIPT, renderTagEditor } from "./tag-editor";
import { testPageContext } from "./test-context";
import { PAGE_STATE_SCRIPT } from "./page-state";

/** A minimal DOM harness exercises startup and local filtering without sockets or a server. */
class Element {
  textContent = ""; value = ""; hidden = false; disabled = false; className = "";
  readonly children: Element[] = [];
  readonly dataset: Record<string, string> = {};
  readonly fields = new Map<string, Element>();
  readonly listeners = new Map<string, (event?: unknown) => void>();
  readonly style = { setProperty() {}, borderInlineStart: "", paddingInlineStart: "" };
  get options() { return this.children; }
  append(node: Element) { this.children.push(node); }
  replaceChildren(...nodes: Element[]) { this.children.splice(0, this.children.length, ...nodes); }
  querySelector(key: string) { return this.fields.get(key) ?? null; }
  setAttribute() {} removeAttribute() {} focus() {}
  addEventListener(name: string, fn: (event?: unknown) => void) { this.listeners.set(name, fn); }
}
const tags = [{ id: "office", name: "room", value: "Office", color: "#123456", description: "", revision: 1, page: "/tags/room/office" }];
const elements = Array.from({ length: 130 }, (_, i) => ({ key: `device-${i}`, name: `Device ${i}`, context: "", kind: "device" as const, page: `/elements/device-${i}`, tagIds: i === 129 ? ["office"] : [] }));
function harness(selectors: string[], script: string, seed: unknown, seedKey: string) {
  const root = new Element();
  for (const key of selectors) root.fields.set(key, new Element());
  root.fields.set(seedKey, Object.assign(new Element(), { textContent: JSON.stringify(seed) }));
  const requests: string[] = [];
  const ht = { locale: "en", t: (key: string, params?: { count?: number }) => `${key}:${params?.count ?? ""}`, say() {}, request: (path: string) => { requests.push(path); throw new Error("Startup attempted I/O"); } };
  const location = new URL('http://localhost/tags');
  const context = { document: { querySelector: (selector: string) => selector.startsWith('form[') ? null : root, createElement: () => new Element() }, ht, URL, location,
    window: { ht, addEventListener() {} }, history: { state: null, pushState: (_data: unknown, _title: string, url: string) => { location.href = new URL(url, location).href; }, replaceState: (_data: unknown, _title: string, url: string) => { location.href = new URL(url, location).href; } } };
  return { root, requests, start: () => runInNewContext(PAGE_STATE_SCRIPT + script, context) };
}

test("Tags ships all search data, filter choices and pagination before JS runs", () => {
  const html = renderTagsPage(testPageContext(), "elements", undefined, { tags, elements });
  const seed = JSON.parse(html.match(/data-tag-data>(.*?)<\/script>/s)![1]!);
  expect(seed.elements).toHaveLength(130);
  expect(html).toContain('<option value="device">');
  expect(html).toContain('data-tag-more>');
  expect(html).not.toContain("ht.t('feedback.loading')");
  expect(html).toContain('href="/elements/device-99"');
});

test("Tags startup preserves SSR, and searching and paging never fetch", () => {
  const { root, requests, start } = harness(['[data-tag-manager-feedback]', '[data-tag-rows]', '[data-tag-search]', '[data-element-kind]', '[data-tag-more]', '[data-tag-count]'], TAG_MANAGER_SCRIPT, { tags, elements, counts: { office: 1 } }, '[data-tag-data]');
  root.dataset.view = "elements";
  const rows = root.fields.get('[data-tag-rows]')!;
  const original = new Element(); rows.append(original);
  start();
  expect(rows.children).toEqual([original]);
  root.fields.get('[data-tag-search]')!.value = "Device 129";
  root.fields.get('[data-tag-search]')!.listeners.get('input')!();
  expect(rows.children).toHaveLength(1);
  root.fields.get('[data-tag-search]')!.value = "";
  root.fields.get('[data-tag-search]')!.listeners.get('input')!();
  expect(rows.children).toHaveLength(100);
  root.fields.get('[data-tag-more]')!.listeners.get('click')!();
  expect(rows.children).toHaveLength(130);
  expect(requests).toEqual([]);
});

test("tag editor ships assigned chips and available tags, then hydrates without fetching", () => {
  const data = { tags, elements: [elements[129]!] };
  const html = renderTagEditor(testPageContext(), data);
  expect(html).toContain('href="/tags/room/office"');
  expect(html).toContain('>room = Office</a>');
  expect(html).not.toContain('data-tag-editor hidden');
  const { requests, start } = harness(['[data-tag-element-search]', '[data-tag-element]', '[data-tag-chips]', '[data-tag-input]', '[role=listbox]', '[data-tag-feedback]', '[data-tag-refresh]'], TAG_EDITOR_SCRIPT, data, '[data-tag-editor-data]');
  start();
  expect(requests).toEqual([]);
});
