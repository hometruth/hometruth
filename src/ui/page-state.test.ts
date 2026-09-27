import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { activeApiTab, pageStateHref, PAGE_STATE_SCRIPT, PAGE_DISCLOSURE_SCRIPT } from "./page-state";

interface PageState {
  get(key: string, fallback?: string): string;
  all(key: string): string[];
  update(values: Record<string, unknown>, options?: { replace?: boolean }): void;
  watch(keys: string[] | null, callback: (query: URLSearchParams) => void): () => void;
  bind(input: Input, key: string, changed: () => void): void;
}
class Input extends EventTarget {
  value = "";
  type = "search";
  tagName = "INPUT";
  options: { value: string }[] = [];
}
class Disclosure extends EventTarget {
  open = false;
  id = "";
  dataset: { pageDisclosure?: string } = {};
}

function browser(path = '/switches/fan', details: Disclosure[] = []) {
  const location = new URL(path, 'http://localhost');
  const entries = [location.href];
  let position = 0;
  const events = new EventTarget();
  const preferences = { value: '' };
  const ht = {} as { pageState: PageState };
  const state = { retained: 'other page state' };
  const context = {
    URL, location, ht,
    window: { ht, addEventListener: events.addEventListener.bind(events) },
    document: { querySelector: () => preferences, querySelectorAll: () => details },
    history: {
      state,
      pushState(next: unknown, _title: string, path: string) {
        expect(next).toBe(state);
        location.href = new URL(path, location).href;
        entries.splice(++position); entries.push(location.href);
      },
      replaceState(next: unknown, _title: string, path: string) {
        expect(next).toBe(state);
        location.href = new URL(path, location).href; entries[position] = location.href;
      },
    },
  };
  runInNewContext(PAGE_STATE_SCRIPT, context);
  return {
    state: ht.pageState, location, entries, preferences,
    move(delta: number) { position += delta; location.href = entries[position]!; events.dispatchEvent(new Event('popstate')); },
    disclosures() { runInNewContext(PAGE_DISCLOSURE_SCRIPT, context); },
  };
}

test('tab links preserve page paths, repeated filters and fragments', () => {
  expect(pageStateHref('/switches/fan/graph?expand=root&hidden=&label=a&label=b#graph', 'tab', 'rest'))
    .toBe('/switches/fan/graph?expand=root&hidden=&label=a&label=b&tab=rest#graph');
  expect(pageStateHref('/?tab=api&example=read', 'tab')).toBe('/?example=read');
  expect(activeApiTab('/?tab=skill')).toBe('skill');
  expect(activeApiTab('/?tab=unknown')).toBeUndefined();
});

test('URL state restores views on Back and Forward without duplicate entries or lost fields', () => {
  const page = browser('/switches/fan/graph?expand=root&label=a&label=b#graph');
  const selected: string[] = [];
  page.state.watch(['tab'], query => selected.push(query.get('tab') ?? 'page'));
  page.state.update({ tab: 'rest' });
  page.state.update({ 'rest-search': 'toggle' }, { replace: true });
  page.state.update({ tab: 'rest' });
  expect(page.entries).toHaveLength(2);
  expect(selected).toEqual(['page', 'rest']);
  expect(page.state.all('label')).toEqual(['a', 'b']);
  expect(page.location.hash).toBe('#graph');
  expect(page.preferences.value).toContain('tab=rest');
  page.state.update({ tab: 'cli' });
  page.move(-1);
  expect(page.state.get('tab')).toBe('rest');
  expect(page.state.get('rest-search')).toBe('toggle');
  page.move(-1);
  expect(page.state.get('tab')).toBe('');
  page.move(1);
  expect(selected).toEqual(['page', 'rest', 'cli', 'rest', 'page', 'rest']);
  expect(page.entries).toHaveLength(3);
  expect(browser(page.location.href).state.get('tab')).toBe('rest');
});

test('bound filters restore from a shared URL and clear on history navigation', () => {
  const page = browser('/api-docs?rest-search=toggle&rest-group=Devices');
  const search = new Input();
  const group = Object.assign(new Input(), { type: 'select-one', tagName: 'SELECT', value: 'all', options: [{ value: 'all' }, { value: 'Devices' }] });
  let renders = 0;
  page.state.bind(search, 'rest-search', () => renders++);
  page.state.bind(group, 'rest-group', () => renders++);
  expect(search.value).toBe('toggle');
  expect(group.value).toBe('Devices');
  search.value = 'status'; search.dispatchEvent(new Event('input'));
  expect(page.entries).toHaveLength(1);
  group.value = 'all'; group.dispatchEvent(new Event('change'));
  expect(page.state.get('rest-group')).toBe('');
  page.move(-1);
  expect(group.value).toBe('Devices');
  expect(search.value).toBe('status');
  page.state.update({ 'rest-group': 'not-a-group' });
  expect(group.value).toBe('all');
  expect(renders).toBe(6);
});

test('expanded sections round-trip in URLs and history without feedback loops', () => {
  const details = Object.assign(new Disclosure(), { dataset: { pageDisclosure: 'GET /api/devices/fan' } });
  const page = browser('/switches/fan?tab=rest', [details]);
  page.disclosures();
  details.open = true; details.dispatchEvent(new Event('toggle'));
  expect(page.state.get('detail.GET /api/devices/fan')).toBe('open');
  const restored = Object.assign(new Disclosure(), { dataset: details.dataset });
  browser(page.location.href, [restored]).disclosures();
  expect(restored.open).toBe(true);
  page.move(-1);
  expect(details.open).toBe(false);
  details.dispatchEvent(new Event('toggle'));
  expect(page.entries).toHaveLength(2);
  page.move(1);
  expect(details.open).toBe(true);
  details.open = false; details.dispatchEvent(new Event('toggle'));
  expect(page.location.search).toBe('?tab=rest');
});
