/** Shared by every authenticated page; failures arrive without navigation or polling. */
export const HEALTH_NAVIGATION_SCRIPT = String.raw`
  (() => {
    const list = document.querySelector("[data-health-investigations]");
    if (!list) return;
    const announce = document.querySelector("[data-health-announcement]");
    const known = new Set([...list.querySelectorAll("a")].map(link => link.dataset.investigationId));
    let generation = 0;
    const render = items => {
      const links = [];
      for (const item of items) {
        if (!/^[a-f0-9-]{36}$/.test(item.id) || item.href !== "/health/investigations/" + item.id) continue;
        const link = document.createElement("a");
        link.href = item.href; link.dataset.investigationId = item.id;
        link.append(document.createTextNode(item.title));
        const state = document.createElement("small");
        state.textContent = ht.t("investigation." + item.status);
        link.append(state);
        if (location.pathname === item.href) link.setAttribute("aria-current", "page");
        if (!known.has(item.id)) announce.textContent = item.title + ". " + state.textContent;
        known.add(item.id); links.push(link);
      }
      list.replaceChildren(...links);
      document.dispatchEvent(new CustomEvent("health-investigations", { detail: items }));
    };
    const stream = new EventSource("/api/health/investigations/stream");
    stream.addEventListener("investigations", event => {
      try { generation++; render(JSON.parse(event.data)); } catch { /* Keep the last known links on a broken frame. */ }
    });
    const refresh = async () => {
      const current = ++generation;
      try {
        const response = await fetch("/api/health/investigations", { cache: "no-store", signal: AbortSignal.timeout(10000) });
        if (response.ok) { const items = await response.json(); if (current === generation) render(items); }
      } catch { /* The event stream reconnects automatically. */ }
    };
    document.addEventListener("health-action-failed", refresh);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });
    window.addEventListener("pagehide", () => stream.close(), { once: true });
  })();
`;
