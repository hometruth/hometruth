import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { TAG_MANAGER_SCRIPT, renderTagsPage } from "./tags-page";
import { TAG_EDITOR_SCRIPT, renderTagEditor } from "./tag-editor";
import { testPageContext } from "./test-context";
import { PAGE_STATE_SCRIPT } from "./page-state";
import { TagStore } from "../tags/store";
import { elementKey } from "../tags/identity";
import { tagPage } from "../tags/model";

/** A minimal DOM harness exercises startup and local filtering without sockets or a server. */
class Element {
  textContent = ""; value = ""; hidden = false; disabled = false; className = "";
  readonly children: Element[] = [];
  readonly dataset: Record<string, string> = {};
  readonly fields = new Map<string, Element>();
  readonly listeners = new Map<string, (event?: unknown) => unknown>();
  readonly style = { setProperty() {}, borderInlineStart: "", paddingInlineStart: "" };
  get options() { return this.children; }
  append(node: Element) { this.children.push(node); }
  replaceChildren(...nodes: Element[]) { this.children.splice(0, this.children.length, ...nodes); }
  querySelector(key: string) { return this.fields.get(key) ?? null; }
  setAttribute() {} removeAttribute() {} focus() {}
  addEventListener(name: string, fn: (event?: unknown) => unknown) { this.listeners.set(name, fn); }
}
const tags = [{ id: "office", name: "room", value: "Office", color: "#123456", description: "", revision: 1, page: "/rooms/office" }];
const elements = Array.from({ length: 130 }, (_, i) => ({ key: `device-${i}`, name: `Device ${i}`, context: "", kind: "device" as const, page: `/elements/device-${i}`, tagIds: i === 129 ? ["office"] : [] }));
function harness(selectors: string[], script: string, seed: unknown, seedKey: string, request?: (path: string, init?: RequestInit) => Promise<unknown>) {
  const root = new Element();
  for (const key of selectors) root.fields.set(key, new Element());
  root.fields.get('[data-room-picker]')?.fields.set('button[type=submit]', new Element());
  root.fields.set(seedKey, Object.assign(new Element(), { textContent: JSON.stringify(seed) }));
  const requests: string[] = [];
  const ht = { locale: "en", t: (key: string, params?: { count?: number }) => `${key}:${params?.count ?? ""}`, say(node: Element, message: string) { node.textContent = message; }, request: (path: string, init?: RequestInit) => { requests.push(path); if (request) return request(path, init); throw new Error("Startup attempted I/O"); } };
  const location = new URL('http://localhost/tags');
  const context = { document: { querySelector: (selector: string) => selector.startsWith('form[') ? null : root, createElement: () => new Element() }, ht, URL, location,
    CustomEvent, window: { ht, addEventListener() {}, dispatchEvent() {} }, history: { state: null, pushState: (_data: unknown, _title: string, url: string) => { location.href = new URL(url, location).href; }, replaceState: (_data: unknown, _title: string, url: string) => { location.href = new URL(url, location).href; } } };
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

const editorSelectors = ['[data-tag-element-search]', '[data-tag-element]', '[data-tag-chips]', '[data-tag-input]', '[role=listbox]', '[data-tag-feedback]', '[data-tag-refresh]', '[data-room-picker]', '[name=room]', '[name=newRoom]', '[data-room-feedback]', '[data-room-current]'];

test("element editor ships a distinct room field and hydrates without fetching", () => {
  const data = { tags, elements: [elements[129]!] };
  const html = renderTagEditor(testPageContext(), data);
  expect(html).toContain('href="/rooms/office"');
  expect(html).toContain('>Office</a>');
  expect(html).toContain('<option value="room:Office" selected>Office</option>');
  expect(html).toContain('id="element-room-title">Room</h2>');
  expect(html).not.toContain('>room = Office</a>');
  expect(html).not.toContain('data-remove-tag="office"');
  expect(html).not.toContain('data-tag-editor hidden');
  const { requests, start } = harness(editorSelectors, TAG_EDITOR_SCRIPT, data, '[data-tag-editor-data]');
  start();
  expect(requests).toEqual([]);
});

test("room editing replaces and clears only the room while tags stay separate through refresh and element changes", async () => {
  const store = new TagStore();
  try {
    const key = elementKey('device', 'reading-lamp');
    const otherKey = elementKey('device', 'desk-lamp');
    store.attach(key, { name: 'room', value: 'Office' });
    const ordinary = store.create({ value: 'reading', color: '#123456', description: '' });
    store.attach(key, { tagId: ordinary.id });
    store.attach(otherKey, { name: 'room', value: 'Kitchen' });
    const rows = () => store.list().map(tag => ({ ...tag, page: tagPage(tag) }));
    let fail = false;
    const { root, start } = harness(editorSelectors, TAG_EDITOR_SCRIPT, {
      tags: rows(), elements: [
        { ...elements[0], key, tagIds: store.tagsFor(key).map(tag => tag.id) },
        { ...elements[1], key: otherKey, tagIds: store.tagsFor(otherKey).map(tag => tag.id) },
      ],
    }, '[data-tag-editor-data]', async (path, init) => {
      if (fail) throw new Error('Could not save room');
      if (path === '/api/tags') return { tags: rows() };
      const target = path.includes(otherKey) ? otherKey : key;
      if (init?.method === 'POST') store.attach(target, JSON.parse(String(init.body)));
      if (init?.method === 'DELETE') store.detach(target, path.split('/').at(-1)!);
      return { tags: store.tagsFor(target).map(tag => ({ ...tag, page: tagPage(tag) })) };
    });
    const field = (selector: string) => root.fields.get(selector)!;
    const submit = () => field('[data-room-picker]').listeners.get('submit')!({ preventDefault() {} });
    const selected = field('[data-tag-element]'); selected.value = key;
    start();
    field('[data-tag-input]').listeners.get('focus')!();
    expect(field('[role=listbox]').children).toHaveLength(0);
    field('[name=room]').value = 'room:Kitchen';
    await submit();
    expect(store.roomOf(key)).toBe('Kitchen');
    expect(store.tagsFor(key).filter(tag => tag.name === 'room')).toHaveLength(1);
    expect(field('[data-tag-chips]').children.map(chip => chip.children[0]?.textContent)).toEqual(['reading']);
    expect(field('[data-room-current]').children[0]?.textContent).toBe('Kitchen');

    field('[name=room]').value = 'new';
    field('[name=room]').listeners.get('change')!();
    field('[name=newRoom]').value = '  Living Room  ';
    fail = true; await submit();
    expect(field('[data-room-feedback]').textContent).toBe('Could not save room');
    expect(field('[name=newRoom]').value).toBe('  Living Room  ');
    expect(field('[name=newRoom]').disabled).toBe(false);
    expect(store.roomOf(key)).toBe('Kitchen');
    fail = false; await submit();
    expect(store.roomOf(key)).toBe('Living Room');
    expect(field('[name=room]').value).toBe('room:Living Room');

    field('[name=room]').value = ''; await submit();
    expect(store.tagsFor(key).map(tag => tag.id)).toEqual([ordinary.id]);
    await field('[data-tag-refresh]').listeners.get('click')!();
    expect(field('[name=room]').value).toBe('');
    expect(field('[data-tag-chips]').children.map(chip => chip.children[0]?.textContent)).toEqual(['reading']);
    selected.value = otherKey; selected.listeners.get('change')!();
    expect(field('[name=room]').value).toBe('room:Kitchen');
    selected.value = key; selected.listeners.get('change')!();
    expect(field('[name=room]').value).toBe('');
  } finally { store.close(); }
});
