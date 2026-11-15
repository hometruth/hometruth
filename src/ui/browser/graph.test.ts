import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import type { NodeRecord } from "../../state/protocol.ts";
import { FakeElement, installTestDom } from "./test-dom.ts";

const dom = installTestDom();
// Run the real entry point against the existing fake DOM, isolating its global
// listeners for each page. Its imported state factory must never run here.
const source = readFileSync(new URL("./graph.ts", import.meta.url), "utf8").replace(/^import .*;\n/gmu, "");
const controller = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
const AT = "2026-10-01T12:00:00.000Z";

function fixture(options: { viewportWidth?: number; viewportHeight?: number; sceneWidth?: number; sceneHeight?: number } = {}) {
  const client = dom.reset();
  const sceneWidth = options.sceneWidth ?? 900, sceneHeight = options.sceneHeight ?? 300;
  let viewportWidth = options.viewportWidth ?? 640, viewportHeight = options.viewportHeight ?? 380;
  let resized: (() => void) | undefined;
  dom.document.body.innerHTML = `<div data-graph-view="dependencies" data-graph-selected="a">
    <div data-graph-tools hidden><button data-graph-fit>Fit</button><button data-graph-center>Center</button><button data-graph-zoom="in">+</button><button data-graph-zoom="out">−</button><output data-graph-scale>100%</output></div>
    <div class="graph-viewport"><svg class="graph-canvas" data-scene-width="${sceneWidth}" data-scene-height="${sceneHeight}" width="${sceneWidth}" height="${sceneHeight}" viewBox="0 0 ${sceneWidth} ${sceneHeight}"><g class="graph-world">
      <g class="graph-connection" id="ab" data-graph-from="a" data-graph-to="b"><path class="graph-edge" d="M224 102 L280 102"></path><text>uses · on</text></g>
      <g class="graph-connection" id="ac" data-graph-from="a" data-graph-to="c"><path class="graph-edge" d="M224 120 L800 120"></path><text>uses · off</text></g>
      <g class="graph-connection" id="bc" data-graph-from="b" data-graph-to="c"><path class="graph-edge" d="M784 102 L800 102"></path><text>uses</text></g>
      <a id="a-first" class="graph-node" data-graph-select="a" data-graph-state="device/a" data-x="0" data-y="50" data-width="224" data-height="104" aria-current="true" transform="translate(0 50)" href="/graph?selected=desk-lamp"><text data-graph-status>A before stream</text></a>
      <a id="a-second" class="graph-node" data-graph-select="a" data-graph-state="device/a" data-x="280" data-y="50" data-width="224" data-height="104" aria-current="true" transform="translate(280 50)" href="/graph?selected=desk-lamp"><text data-graph-status>A before stream</text></a>
      <a id="b-card" class="graph-node" data-graph-select="b" data-graph-state="device/b" data-x="560" data-y="50" data-width="224" data-height="104" aria-current="false" transform="translate(560 50)" href="/graph?selected=ceiling-lamp"><text data-graph-status>B before stream</text></a>
    </g></svg></div>
    <aside>
      <section data-graph-panel="a" data-graph-state="device/a"><span data-graph-status>A before stream</span><span data-graph-observed></span><a href="/devices/a">Open element</a></section>
      <section data-graph-panel="b" data-graph-state="device/b" hidden><span data-graph-status>B before stream</span><span data-graph-observed></span><a href="/devices/b">Open element</a></section>
    </aside>
  </div>`;
  const root = dom.document.querySelector('[data-graph-view]')!;
  const viewport = root.querySelector('.graph-viewport')!;
  Object.defineProperties(viewport, {
    clientWidth: { get: () => viewportWidth }, clientHeight: { get: () => viewportHeight },
    setPointerCapture: { value() {} },
  });
  const events = new EventTarget();
  const location = new URL("https://example.test/graph?view=dependencies&focus=control");
  const pushes: string[] = [];
  const history = { pushState(_state: unknown, _title: string, url: URL | string) { location.href = new URL(url, location).href; pushes.push(location.href); } };
  const never = () => { throw new Error("Graph enhancement attempted to create network state instead of using ht.state"); };
  runInNewContext(controller, {
    document: dom.document, ht: dom.ht, Element: FakeElement, URL, location, history,
    window: { addEventListener: events.addEventListener.bind(events) },
    ResizeObserver: class { constructor(callback: () => void) { resized = callback; } observe() {} },
    createStateClient: never, readSeed: never, EventSource: never, fetch: never,
  });
  const element = (selector: string) => root.querySelector(selector)!;
  const geometry = () => ({
    world: element('.graph-world').getAttribute('transform'),
    viewBox: element('.graph-canvas').getAttribute('viewBox'),
    edges: root.querySelectorAll('.graph-edge').map(edge => edge.getAttribute('d')),
    nodes: root.querySelectorAll('.graph-node').map(node => ({
      transform: node.getAttribute('transform'),
      x: node.dataset.x, y: node.dataset.y, width: node.dataset.width, height: node.dataset.height,
    })),
  });
  const camera = () => {
    const transform = element('.graph-world').getAttribute('transform');
    const values = transform?.match(/^translate\(([-+\d.e]+) ([-+\d.e]+)\) scale\(([-+\d.e]+)\)$/u);
    return values ? { x: Number(values[1]), y: Number(values[2]), scale: Number(values[3]) } : null;
  };
  return { root, client, location, pushes, element, geometry, camera,
    resize(width: number, height: number) { viewportWidth = width; viewportHeight = height; resized?.(); },
    key(key: string) { const event = new Event('keydown', { cancelable: true }); Object.defineProperty(event, 'key', { value: key }); viewport.dispatchEvent(event); },
    drag(dx: number, dy: number) {
      for (const [type, clientX, clientY] of [['pointerdown', 20, 20], ['pointermove', 20 + dx, 20 + dy], ['pointerup', 20 + dx, 20 + dy]] as const) {
        const event = new Event(type); Object.defineProperties(event, { pointerId: { value: 1 }, clientX: { value: clientX }, clientY: { value: clientY }, button: { value: 0 } }); viewport.dispatchEvent(event);
      }
    },
    pop(url: string) { location.href = new URL(url, location).href; events.dispatchEvent(new Event('popstate')); },
    hide(persisted = false) { const event = new Event('pagehide'); Object.defineProperty(event, 'persisted', { value: persisted }); events.dispatchEvent(event); },
  };
}

function record(node: NodeRecord["node"], status: string, extra: Partial<NodeRecord> = {}): NodeRecord {
  return { node, version: 1, updatedAt: AT, observedAt: AT, value: { status }, ...extra };
}

describe("graph controller", () => {
  test("initial framing only fits readable scenes, otherwise centering the selected node at full size", () => {
    const compact = fixture({ viewportWidth: 800 });
    expect(compact.camera()?.scale).toBeCloseTo((800 - 32) / 900);
    expect(compact.camera()?.x).toBeCloseTo(16);
    const smaller = fixture({ viewportWidth: 790 });
    expect(smaller.camera()).toEqual({ x: 790 / 2 - 112, y: 380 / 2 - 102, scale: 1 });
    const tall = fixture({ sceneHeight: 8_000 });
    expect(tall.camera()).toEqual({ x: 208, y: 88, scale: 1 });
    expect(tall.element('[data-graph-scale]').textContent).toBe('100%');
  });

  test("automatic framing follows resize and waits for a visible viewport", () => {
    const h = fixture({ viewportWidth: 0, viewportHeight: 0 });
    expect(h.camera()).toBeNull(); expect(h.geometry().viewBox).toBe('0 0 900 300');
    h.resize(640, 380);
    expect(h.camera()).toEqual({ x: 208, y: 88, scale: 1 });
    h.resize(800, 380);
    expect(h.camera()?.scale).toBeCloseTo(768 / 900);
    h.resize(1_000, 500);
    expect(h.camera()).toEqual({ x: 50, y: 100, scale: 1 });
    const visible = h.geometry();
    h.resize(0, 0);
    expect(h.geometry()).toEqual(visible);
  });

  test("Center restores readable size after an explicit overview and keeps the selected node centered", () => {
    const h = fixture({ sceneHeight: 4_000 });
    h.element('[data-graph-fit]').click();
    expect(h.camera()?.scale).toBeCloseTo(348 / 4_000);
    h.element('#b-card').click();
    h.element('[data-graph-center]').click();
    expect(h.camera()).toEqual({ x: 320 - 672, y: 88, scale: 1 });
    expect(h.element('[data-graph-scale]').textContent).toBe('100%');
    const camera = h.camera();
    h.resize(1_100, 600);
    expect(h.camera()).toEqual(camera);
    expect(h.geometry().viewBox).toBe('0 0 1100 600');
  });

  test("user pan, zoom and fit disable automatic reframing without changing node or edge geometry", () => {
    for (const action of ['drag', 'key', 'zoom', 'fit'] as const) {
      const h = fixture();
      const before = h.geometry();
      if (action === 'drag') h.drag(70, -35);
      else if (action === 'key') h.key('ArrowRight');
      else h.element(action === 'zoom' ? '[data-graph-zoom="in"]' : '[data-graph-fit]').click();
      if (action === 'drag') expect(h.camera()).toEqual({ x: 278, y: 53, scale: 1 });
      const camera = h.camera();
      h.resize(1_200, 600);
      expect(h.camera()).toEqual(camera);
      expect(h.geometry().nodes).toEqual(before.nodes); expect(h.geometry().edges).toEqual(before.edges);
    }
  });

  test("incident edge highlighting follows selection and browser history without moving the camera", () => {
    const h = fixture();
    const related = () => ['ab', 'ac', 'bc'].map(id => h.element(`#${id}`).dataset.related);
    expect(related()).toEqual(['true', 'true', 'false']);
    const before = h.geometry();
    h.element('#b-card').click();
    expect(related()).toEqual(['true', 'false', 'true']);
    expect(h.geometry()).toEqual(before);
    h.pop('/graph?view=dependencies&focus=control&selected=desk-lamp');
    expect(related()).toEqual(['true', 'true', 'false']);
    expect(h.geometry()).toEqual(before);
  });

  test("clicking a node selects its inspector and updates the URL without moving geometry", () => {
    const h = fixture();
    const before = h.geometry();
    const target = h.element('#b-card').querySelector('text')!;
    const click = new Event('click', { bubbles: true, cancelable: true });
    target.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(h.root.dataset.graphSelected).toBe('b');
    expect(h.element('[data-graph-panel="a"]').hidden).toBe(true);
    expect(h.element('[data-graph-panel="b"]').hidden).toBe(false);
    expect(h.element('#b-card').getAttribute('aria-current')).toBe('true');
    expect(h.element('#a-first').getAttribute('aria-current')).toBe('false');
    expect(h.location.searchParams.get('selected')).toBe('ceiling-lamp');
    expect(h.location.searchParams.get('focus')).toBe('control');
    expect(h.location.pathname).toBe('/graph');
    expect(h.pushes).toHaveLength(1);
    expect(h.geometry()).toEqual(before);
  });

  test("duplicate canonical cards and their inspector share one glance subscription", () => {
    const h = fixture();
    expect(h.client.subscriptions.map(entry => ({ node: entry.node, tier: entry.tier }))).toEqual([
      { node: 'device/a', tier: 'glance' }, { node: 'device/b', tier: 'glance' },
    ]);
    h.client.push(record('device/a', 'online'));
    for (const element of h.root.querySelectorAll('[data-graph-state="device/a"]')) {
      expect(element.dataset.availability).toBe('online');
      expect(element.querySelector('[data-graph-status]')!.textContent).toBe(dom.ht.availability('online'));
    }
    expect(h.client.invocations).toEqual([]);
  });

  test("an observation updates only matching cards and never changes topology or selection", () => {
    const h = fixture();
    const geometry = h.geometry();
    const unrelatedCard = h.element('#b-card').outerHTML;
    const unrelatedPanel = h.element('[data-graph-panel="b"]').outerHTML;
    h.client.push(record('device/a', 'online', { fault: { code: 'timeout', message: 'Synthetic timeout' } }));
    for (const element of h.root.querySelectorAll('[data-graph-state="device/a"]')) {
      expect(element.dataset.availability).toBe('offline');
      expect(element.querySelector('[data-graph-status]')!.textContent).toBe(dom.ht.availability('offline'));
      expect(element.querySelector('[data-graph-status]')!.getAttribute('data-live')).toBe(AT);
    }
    expect(h.element('#b-card').outerHTML).toBe(unrelatedCard);
    expect(h.element('[data-graph-panel="b"]').outerHTML).toBe(unrelatedPanel);
    expect(h.geometry()).toEqual(geometry);
    expect(h.root.dataset.graphSelected).toBe('a'); expect(h.pushes).toEqual([]);
  });

  test("stale records retain explicit snapshot wording and remove the live marker", () => {
    const h = fixture();
    h.client.push(record('device/a', 'online'));
    h.client.push(record('device/a', 'online'), true);
    const status = h.element('#a-first').querySelector('[data-graph-status]')!;
    expect(status.textContent).toBe(dom.ht.t('graph.snapshot', { status: dom.ht.availability('online') }));
    expect(status.hasAttribute('data-live')).toBe(false);
  });

  test("popstate restores selection without pushing history or altering the scene", () => {
    const h = fixture();
    h.element('#b-card').click();
    const geometry = h.geometry();
    h.pop('/graph?view=dependencies&focus=control');
    expect(h.root.dataset.graphSelected).toBe('a');
    expect(h.element('[data-graph-panel="a"]').hidden).toBe(false);
    expect(h.element('[data-graph-panel="b"]').hidden).toBe(true);
    expect(h.element('#a-first').getAttribute('aria-current')).toBe('true');
    expect(h.element('#a-second').getAttribute('aria-current')).toBe('true');
    h.pop('/graph?view=dependencies&focus=control&selected=ceiling-lamp');
    expect(h.root.dataset.graphSelected).toBe('b');
    expect(h.element('[data-graph-panel="b"]').hidden).toBe(false);
    expect(h.pushes).toHaveLength(1);
    expect(h.geometry()).toEqual(geometry);
  });

  test("modified clicks remain native, and page departure releases subscriptions", () => {
    const h = fixture();
    const click = new Event('click', { bubbles: true, cancelable: true });
    Object.defineProperty(click, 'ctrlKey', { value: true });
    h.element('#b-card').dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false); expect(h.pushes).toEqual([]);
    h.hide(true);
    expect(h.client.subscriptions.every(entry => !entry.released)).toBe(true);
    h.hide(false);
    expect(h.client.subscriptions.every(entry => entry.released)).toBe(true);
  });
});
