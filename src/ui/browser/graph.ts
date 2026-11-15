/** Enhance the complete server-rendered graph without changing its geometry. */
import { ht } from "./runtime.ts";
import { createStateClient, readSeed } from "./state.ts";
import type { NodeId } from "../../state/protocol.ts";

const root = document.querySelector<HTMLElement>("[data-graph-view]");
if (root) {
  ht.state ??= createStateClient({ EventSource, apiPath: path => ht.apiPath(path), fetch: (url, init) => fetch(url, init), document, window, setTimeout: (fn, ms) => window.setTimeout(fn, ms), clearTimeout: handle => window.clearTimeout(handle), seed: readSeed(document) });
  const panels = [...root.querySelectorAll<HTMLElement>("[data-graph-panel]")];
  const selectors = [...root.querySelectorAll<HTMLElement | SVGElement>("[data-graph-select]")];
  const connections = [...root.querySelectorAll<SVGElement>(".graph-connection")];
  const publicSelections = new Map(selectors.map(item => [item.dataset.graphSelect!, new URL(item.getAttribute("href")!, location.href).searchParams.get("selected")!]));
  const internalSelections = new Map([...publicSelections].map(([id, address]) => [address, id]));
  const select = (id: string, updateUrl: boolean) => {
    if (!panels.some(panel => panel.dataset.graphPanel === id)) return;
    root.dataset.graphSelected = id;
    for (const panel of panels) panel.hidden = panel.dataset.graphPanel !== id;
    for (const item of selectors) item.setAttribute("aria-current", String(item.dataset.graphSelect === id));
    for (const connection of connections) connection.dataset.related = String(connection.dataset.graphFrom === id || connection.dataset.graphTo === id);
    if (updateUrl) {
      const url = new URL(location.href);
      url.searchParams.set("selected", publicSelections.get(id)!);
      history.pushState(null, "", url);
    }
  };
  root.addEventListener("click", event => {
    if (!(event.target instanceof Element) || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.target.closest<HTMLElement | SVGElement>("[data-graph-select]");
    if (!target?.dataset.graphSelect) return;
    event.preventDefault();
    select(target.dataset.graphSelect, true);
  });
  const initial = root.dataset.graphSelected ?? "";
  select(initial, false);
  window.addEventListener("popstate", () => select(internalSelections.get(new URL(location.href).searchParams.get("selected")!) ?? initial, false));
  const stateNodes = new Map<string, (HTMLElement | SVGElement)[]>();
  for (const node of root.querySelectorAll<HTMLElement | SVGElement>("[data-graph-state]")) {
    const id = node.dataset.graphState!;
    stateNodes.set(id, [...stateNodes.get(id) ?? [], node]);
  }
  const releases = [...stateNodes].map(([id, elements]) => ht.state!.subscribe(id as NodeId, record => {
    const value = record.value as { status?: string } | undefined;
    const availability = record.fault ? "offline" : value?.status ?? "unknown";
    const label = record.fault?.code === "disabled" ? ht.t("graph.disabled") : ht.availability(availability);
    for (const element of elements) {
      element.dataset.availability = availability;
      const status = element.querySelector("[data-graph-status]");
      if (status) { status.textContent = record.stale ? ht.t("graph.snapshot", { status: label }) : label; ht.live(status, record.stale ? undefined : record.observedAt); }
      const observed = element.querySelector("[data-graph-observed]");
      if (observed) observed.textContent = record.observedAt ? ht.t("graph.observed", { time: ht.dateTime(record.observedAt) }) : ht.t("graph.notObserved");
    }
  }, "glance"));
  window.addEventListener("pagehide", event => { if (!event.persisted) releases.forEach(release => release()); });

  const viewport = root.querySelector<HTMLElement>(".graph-viewport");
  const svg = root.querySelector<SVGSVGElement>(".graph-canvas");
  const world = root.querySelector<SVGGElement>(".graph-world");
  if (viewport && svg && world) {
    const width = Number(svg.dataset.sceneWidth), height = Number(svg.dataset.sceneHeight);
    const readableScale = .85;
    let scale = 1, x = 0, y = 0;
    let autoFraming = true;
    const hasSize = () => viewport.clientWidth > 0 && viewport.clientHeight > 0;
    const paint = () => {
      if (!hasSize()) return;
      svg.setAttribute("viewBox", `0 0 ${viewport.clientWidth} ${viewport.clientHeight}`);
      world.setAttribute("transform", `translate(${x} ${y}) scale(${scale})`);
      const output = root.querySelector("[data-graph-scale]");
      if (output) output.textContent = `${Math.round(scale * 100)}%`;
    };
    const center = () => {
      if (!hasSize()) return;
      if (scale < readableScale) scale = 1;
      const node = selectors.find(node => node.classList.contains("graph-node") && node.dataset.graphSelect === root.dataset.graphSelected);
      x = viewport.clientWidth / 2 - (node ? Number(node.dataset.x) + Number(node.dataset.width) / 2 : width / 2) * scale;
      y = viewport.clientHeight / 2 - (node ? Number(node.dataset.y) + Number(node.dataset.height) / 2 : height / 2) * scale;
      paint();
    };
    const fitScale = () => Math.max(.08, Math.min(1, (viewport.clientWidth - 32) / Math.max(1, width), (viewport.clientHeight - 32) / Math.max(1, height)));
    const fit = () => { if (!hasSize()) return; scale = fitScale(); x = (viewport.clientWidth - width * scale) / 2; y = (viewport.clientHeight - height * scale) / 2; paint(); };
    const autoFrame = () => { if (!hasSize()) return; if (fitScale() >= readableScale) fit(); else { scale = 1; center(); } };
    const manual = (action: () => void) => () => { if (!hasSize()) return; autoFraming = false; action(); };
    const zoom = (factor: number, cx = viewport.clientWidth / 2, cy = viewport.clientHeight / 2) => { if (!hasSize()) return; autoFraming = false; const next = Math.max(.08, Math.min(2, scale * factor)); x = cx - (cx - x) * next / scale; y = cy - (cy - y) * next / scale; scale = next; paint(); };
    viewport.dataset.enhanced = "true";
    svg.setAttribute("width", "100%"); svg.setAttribute("height", "100%");
    root.querySelector<HTMLElement>("[data-graph-tools]")?.removeAttribute("hidden");
    root.querySelector("[data-graph-fit]")?.addEventListener("click", manual(fit));
    root.querySelector("[data-graph-center]")?.addEventListener("click", manual(center));
    root.querySelector("[data-graph-zoom=in]")?.addEventListener("click", () => zoom(1.2));
    root.querySelector("[data-graph-zoom=out]")?.addEventListener("click", () => zoom(1 / 1.2));
    viewport.addEventListener("wheel", event => { if (!(event.ctrlKey || event.metaKey)) return; event.preventDefault(); const rect = viewport.getBoundingClientRect(); zoom(Math.exp(-event.deltaY * .005), event.clientX - rect.left, event.clientY - rect.top); }, { passive: false });
    viewport.addEventListener("keydown", event => {
      if (event.target !== viewport || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "+" || event.key === "=") zoom(1.2);
      else if (event.key === "-") zoom(1 / 1.2);
      else if (event.key === "Home") manual(fit)();
      else if (event.key === "ArrowLeft") manual(() => { x += 48; paint(); })();
      else if (event.key === "ArrowRight") manual(() => { x -= 48; paint(); })();
      else if (event.key === "ArrowUp") manual(() => { y += 48; paint(); })();
      else if (event.key === "ArrowDown") manual(() => { y -= 48; paint(); })();
      else return;
      event.preventDefault();
    });
    let drag: { id: number; clientX: number; clientY: number; x: number; y: number } | undefined;
    viewport.addEventListener("pointerdown", event => { if (event.button || (event.target instanceof Element && event.target.closest("a"))) return; drag = { id: event.pointerId, clientX: event.clientX, clientY: event.clientY, x, y }; viewport.setPointerCapture(event.pointerId); viewport.dataset.panning = "true"; });
    viewport.addEventListener("pointermove", event => { if (!drag || drag.id !== event.pointerId) return; autoFraming = false; x = drag.x + event.clientX - drag.clientX; y = drag.y + event.clientY - drag.clientY; paint(); });
    const release = () => { drag = undefined; delete viewport.dataset.panning; };
    viewport.addEventListener("pointerup", release); viewport.addEventListener("pointercancel", release);
    new ResizeObserver(() => autoFraming ? autoFrame() : paint()).observe(viewport);
    autoFrame();
  }
}
