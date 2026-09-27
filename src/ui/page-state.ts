/** The query string describes the view; paths identify the underlying page. */
export const API_TABS = [
  { value: "api", label: "API" }, { value: "rest", label: "REST" },
  { value: "cli", label: "CLI" }, { value: "skill", label: "SKILL.md" },
] as const;

export function activeApiTab(path: string): string | undefined {
  const value = new URL(path, "http://hometruth.local").searchParams.get("tab");
  return API_TABS.find(tab => tab.value === value)?.value;
}

export function pageStateHref(path: string, key: string, value?: string): string {
  const url = new URL(path, "http://hometruth.local");
  if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
  return url.pathname + url.search + url.hash;
}

/** Shared by page scripts. Watches react only when their own query fields change. */
export const PAGE_STATE_SCRIPT = String.raw`
window.ht.pageState = (() => {
  const watchers = new Set();
  const params = () => new URL(location.href).searchParams;
  const notify = () => {
    const query = params();
    for (const watcher of watchers) {
      const signature = watcher.keys ? JSON.stringify(watcher.keys.map(key => query.getAll(key))) : location.href;
      if (signature === watcher.signature) continue;
      watcher.signature = signature;
      watcher.callback(query);
    }
  };
  const watch = (keys, callback) => {
    const watcher = { keys, callback, signature: undefined };
    watchers.add(watcher); notify();
    return () => watchers.delete(watcher);
  };
  const update = (values, options = {}) => {
    const url = new URL(location.href);
    for (const [key, value] of Object.entries(values)) {
      const items = (Array.isArray(value) ? value : [value]).filter(item => item !== null && item !== undefined && item !== '').map(String);
      if (JSON.stringify(url.searchParams.getAll(key)) === JSON.stringify(items)) continue;
      url.searchParams.delete(key);
      for (const item of items) url.searchParams.append(key, item);
    }
    if (url.href === location.href) return;
    history[options.replace ? 'replaceState' : 'pushState'](history.state, '', url.pathname + url.search + url.hash);
    notify();
  };
  const bind = (input, key, changed, options = {}) => {
    if (!input) return;
    const initial = input.value;
    watch([key], query => {
      const value = query.get(key) ?? initial;
      input.value = input.tagName === 'SELECT' && ![...input.options].some(option => option.value === value) ? initial : value;
      changed();
    });
    input.addEventListener(options.event || (input.type === 'search' ? 'input' : 'change'), () => {
      update({ [key]: input.value === initial ? null : input.value }, { replace: options.replace ?? input.type === 'search' });
    });
  };
  window.addEventListener('popstate', notify);
  window.addEventListener('hashchange', notify);
  watch(null, () => {
    const input = document.querySelector('form[data-preferences] input[name="return"]');
    if (input) input.value = location.pathname + location.search + location.hash;
  });
  return { get: (key, fallback = '') => params().get(key) ?? fallback, all: key => params().getAll(key), update, watch, bind };
})();
`;

/** Remember disclosure state without serializing form values or executing actions. */
export const PAGE_DISCLOSURE_SCRIPT = String.raw`
(() => {
  document.querySelectorAll('main details').forEach((details, index) => {
    const key = 'detail.' + (details.dataset.pageDisclosure || details.id || String(index + 1));
    const initial = details.open;
    const expected = () => ht.pageState.get(key, initial ? 'open' : 'closed') === 'open';
    ht.pageState.watch([key], () => { details.open = expected(); });
    details.addEventListener('toggle', () => {
      if (details.open === expected()) return;
      ht.pageState.update({ [key]: details.open === initial ? null : details.open ? 'open' : 'closed' });
    });
  });
})();
`;
