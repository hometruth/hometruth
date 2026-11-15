/** Server-side geometry for the graph viewer. ELK runs only in a bounded worker. */
import ELK, { type ELK as ElkEngine, type ElkNode, type ElkPoint } from "elkjs/lib/elk-api.js";
import type { GraphScene, SceneEdge, SceneNode } from "./scene";

export const GRAPH_CARD_WIDTH = 240;
export const GRAPH_CARD_HEIGHT = 120;
const PADDING = 28;
const MAX_NODES = 400;
const MAX_EDGES = 2_000;
const CACHE_LIMIT = 64;
const QUEUE_LIMIT = 16;
const TIMEOUT_MS = 10_000;

export interface GraphLayoutOptions { readonly direction?: "RIGHT" | "DOWN"; }
export interface GraphPoint { readonly x: number; readonly y: number; }
export interface GraphEdgeSection {
  readonly startPoint: GraphPoint;
  readonly bendPoints?: readonly GraphPoint[];
  readonly endPoint: GraphPoint;
}
export interface GraphEdgeLabel {
  readonly x: number; readonly y: number; readonly width: number; readonly height: number;
  readonly text: string;
}
export interface PlacedSceneNode extends SceneNode {
  readonly x: number; readonly y: number; readonly width: number; readonly height: number;
  readonly label: readonly string[];
}
export interface PlacedSceneEdge extends SceneEdge {
  readonly sections: readonly GraphEdgeSection[];
  readonly label?: GraphEdgeLabel;
}
export interface PlacedGraphScene extends GraphScene {
  readonly nodes: readonly PlacedSceneNode[];
  readonly edges: readonly PlacedSceneEdge[];
  readonly width: number;
  readonly height: number;
}

export type GraphLayoutErrorCode = "invalid_scene" | "invalid_layout" | "busy" | "timeout" | "worker_failed" | "closed";
export class GraphLayoutError extends Error {
  constructor(readonly code: GraphLayoutErrorCode, message: string) { super(message); this.name = "GraphLayoutError"; }
}

/** Conservative 16px text widths, independent of browser fonts or installed server fonts. */
function textWidth(text: string): number {
  return Array.from(text).reduce((width, char) => width + (/\s/u.test(char) ? 5 : /[il.,'!:;|]/u.test(char) ? 5 : /[MW@#]/u.test(char) ? 14 : /[^\x00-\x7f]/u.test(char) ? 16 : 9.5), 0);
}

function shorten(text: string, width: number): string {
  if (textWidth(text) <= width) return text;
  let output = "";
  let measured = textWidth("…");
  for (const character of text) {
    const next = textWidth(character);
    if (measured + next > width) break;
    output += character; measured += next;
  }
  return output.trimEnd() + "…";
}

/** Names remain complete on the canonical node; only their three drawn lines are abbreviated. */
export function wrapGraphLabel(name: string): string[] {
  const width = GRAPH_CARD_WIDTH - 40;
  const characters = Array.from(name.replace(/\s+/gu, " ").trim());
  if (!characters.length) return [""];
  const lines: string[] = [];
  while (characters.length && lines.length < 3) {
    if (lines.length === 2) { lines.push(shorten(characters.join(""), width)); break; }
    let count = 0;
    let measured = 0;
    while (count < characters.length && measured + textWidth(characters[count]!) <= width) measured += textWidth(characters[count++]!);
    if (count < characters.length) {
      const space = characters.slice(0, count + 1).lastIndexOf(" ");
      if (space > count / 2) count = space;
    }
    lines.push(characters.splice(0, Math.max(1, count)).join("").trim());
    while (characters[0] === " ") characters.shift();
  }
  return lines;
}

interface LayoutNode { id: string; group: string; label: string[]; }
interface LayoutEdge { id: string; from: string; to: string; text: string; width: number; }
interface LayoutInput { home: boolean; direction: "RIGHT" | "DOWN"; nodes: LayoutNode[]; edges: LayoutEdge[]; }
interface NodeGeometry { id: string; x: number; y: number; width: number; height: number; label: string[]; }
interface EdgeGeometry { id: string; sections: GraphEdgeSection[]; label?: GraphEdgeLabel; }
interface Geometry { nodes: NodeGeometry[]; edges: EdgeGeometry[]; width: number; height: number; }
type LayoutWorker = Worker & Pick<Bun.Worker, "unref">;
const compareId = (a: { id: string }, b: { id: string }) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

function inputFor(scene: GraphScene, options: GraphLayoutOptions): LayoutInput {
  if (scene.nodes.length > MAX_NODES || scene.edges.length > MAX_EDGES) throw new GraphLayoutError("invalid_scene", "Graph scene exceeds the layout limit.");
  const direction = options.direction ?? "RIGHT";
  if (direction !== "RIGHT" && direction !== "DOWN") throw new GraphLayoutError("invalid_scene", "Unknown graph layout direction.");
  const nodes = scene.nodes.map(node => ({ id: node.id, group: node.group ?? "", label: wrapGraphLabel(node.node.name) })).sort(compareId);
  const ids = new Set(nodes.map(node => node.id));
  if (ids.size !== nodes.length || ids.has("")) throw new GraphLayoutError("invalid_scene", "Graph scene has duplicate or empty node IDs.");
  const edges = scene.edges.map(edge => {
    if (!ids.has(edge.from) || !ids.has(edge.to)) throw new GraphLayoutError("invalid_scene", "Graph edge has a missing endpoint.");
    const relation = edge.edge.relation.replace(/([a-z])([A-Z])/gu, "$1 $2").toLowerCase();
    const text = shorten([relation, edge.edge.label].filter(Boolean).join(" · "), 300);
    // Edge labels are 12px; node names use the 16px measurement above.
    return { id: edge.id, from: edge.from, to: edge.to, text, width: Math.max(40, Math.ceil(textWidth(text) * .75) + 12) };
  }).sort(compareId);
  if (new Set(edges.map(edge => edge.id)).size !== edges.length || edges.some(edge => !edge.id)) throw new GraphLayoutError("invalid_scene", "Graph scene has duplicate or empty edge IDs.");
  return { home: scene.query.view === "home", direction, nodes, edges };
}

function elkInput(input: LayoutInput): ElkNode {
  // Renderer IDs are opaque; internal ELK IDs cannot collide with the root or its ports.
  const ids = new Map(input.nodes.map((node, index) => [node.id, `n${index}`]));
  return {
    id: "scene",
    layoutOptions: {
      "elk.algorithm": "layered", "elk.direction": input.direction, "elk.edgeRouting": "ORTHOGONAL",
      "elk.padding": `[top=${PADDING},left=${PADDING},bottom=${PADDING},right=${PADDING}]`,
      // Edge labels occupy their own ELK layer, so this gap is paid on both sides.
      "elk.spacing.nodeNode": "44", "elk.layered.spacing.nodeNodeBetweenLayers": "20",
      "elk.spacing.edgeNode": "16", "elk.spacing.edgeEdge": "18", "elk.spacing.labelNode": "12",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES", "elk.randomSeed": "1",
      "elk.layered.mergeEdges": "false", "elk.separateConnectedComponents": "true",
    },
    children: input.nodes.map((node, index) => ({ id: `n${index}`, width: GRAPH_CARD_WIDTH, height: GRAPH_CARD_HEIGHT })),
    edges: input.edges.map((edge, index) => ({
      id: `e${index}`, sources: [ids.get(edge.from)!], targets: [ids.get(edge.to)!],
      labels: [{ id: `l${index}`, text: edge.text, width: edge.width, height: 22 }],
    })),
  };
}

function finite(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) throw new GraphLayoutError("invalid_layout", "Graph layout returned invalid geometry.");
  return value;
}
function point(value: ElkPoint): GraphPoint { return { x: finite(value.x), y: finite(value.y) }; }

function geometryFrom(input: LayoutInput, result: ElkNode): Geometry {
  const children = new Map(result.children?.map(node => [node.id, node]));
  const routed = new Map(result.edges?.map(edge => [edge.id, edge]));
  const nodes = input.nodes.map((node, index): NodeGeometry => {
    const placed = children.get(`n${index}`);
    if (!placed) throw new GraphLayoutError("invalid_layout", "Graph layout omitted a node.");
    return { id: node.id, label: node.label, x: finite(placed.x), y: finite(placed.y), width: finite(placed.width), height: finite(placed.height) };
  });
  const edges = input.edges.map((edge, index): EdgeGeometry => {
    const placed = routed.get(`e${index}`);
    if (!placed?.sections?.length) throw new GraphLayoutError("invalid_layout", "Graph layout omitted an edge route.");
    const sections = placed.sections.map(section => ({ startPoint: point(section.startPoint), endPoint: point(section.endPoint), ...(section.bendPoints?.length ? { bendPoints: section.bendPoints.map(point) } : {}) }));
    const label = placed.labels?.[0];
    if (!label) throw new GraphLayoutError("invalid_layout", "Graph layout omitted an edge label.");
    return { id: edge.id, sections, label: { x: finite(label.x), y: finite(label.y), width: finite(label.width), height: finite(label.height), text: edge.text } };
  });
  return { nodes, edges, width: Math.max(1, finite(result.width)), height: Math.max(1, finite(result.height)) };
}

function homeGeometry(input: LayoutInput): Geometry {
  const ordered = [...input.nodes].sort((a, b) => a.group < b.group ? -1 : a.group > b.group ? 1 : compareId(a, b));
  const columns = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(ordered.length))));
  const nodes = ordered.map((node, index) => ({ id: node.id, label: node.label, x: PADDING + index % columns * (GRAPH_CARD_WIDTH + 24), y: PADDING + Math.floor(index / columns) * (GRAPH_CARD_HEIGHT + 24), width: GRAPH_CARD_WIDTH, height: GRAPH_CARD_HEIGHT }));
  // Home is an HTML grouped overview. Its relationships remain inspectable,
  // but there are intentionally no drawn routes between the room cards.
  return { nodes, edges: input.edges.map(edge => ({ id: edge.id, sections: [] })), width: PADDING * 2 + columns * GRAPH_CARD_WIDTH + (columns - 1) * 24, height: PADDING * 2 + Math.ceil(nodes.length / columns) * (GRAPH_CARD_HEIGHT + 24) - 24 };
}

function place(scene: GraphScene, geometry: Geometry): PlacedGraphScene {
  // Copy cached geometry so callers cannot mutate a future request's scene.
  const copy = structuredClone(geometry);
  const nodes = new Map(copy.nodes.map(node => [node.id, node]));
  const edges = new Map(copy.edges.map(edge => [edge.id, edge]));
  return { ...scene, nodes: scene.nodes.map(node => ({ ...node, ...nodes.get(node.id)! })), edges: scene.edges.map(edge => ({ ...edge, ...edges.get(edge.id)! })), width: copy.width, height: copy.height };
}

interface Job {
  readonly key: string; readonly input: LayoutInput; readonly resolve: (geometry: Geometry) => void;
  readonly reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>;
}
export interface GraphSceneLayouter {
  layout(scene: GraphScene, options?: GraphLayoutOptions): Promise<PlacedGraphScene>;
  close(): void;
}
export interface GraphSceneLayouterOptions {
  /** Includes the active layout; identical requests share one job. */
  readonly maxPending?: number;
  /** Deadline from enqueue, including time waiting for the worker. */
  readonly timeoutMs?: number;
  readonly cacheSize?: number;
}

/** Each instance has one reusable worker. The application normally uses the singleton below. */
export function createGraphSceneLayouter(options: GraphSceneLayouterOptions = {}): GraphSceneLayouter {
  return new SceneLayouter(options);
}

class SceneLayouter implements GraphSceneLayouter {
  readonly #cache = new Map<string, Geometry>();
  readonly #pending = new Map<string, Promise<Geometry>>();
  readonly #queue: Job[] = [];
  readonly #limit: number;
  readonly #timeout: number;
  readonly #cacheLimit: number;
  #active: Job | undefined;
  #worker: LayoutWorker | undefined;
  #elk: ElkEngine | undefined;
  #closed = false;

  constructor(options: GraphSceneLayouterOptions) {
    this.#limit = options.maxPending ?? QUEUE_LIMIT;
    this.#timeout = options.timeoutMs ?? TIMEOUT_MS;
    this.#cacheLimit = options.cacheSize ?? CACHE_LIMIT;
    for (const value of [this.#limit, this.#timeout, this.#cacheLimit]) if (!Number.isInteger(value) || value < 1) throw new Error("Graph layout limits must be positive integers.");
    if (this.#limit > QUEUE_LIMIT || this.#cacheLimit > CACHE_LIMIT) throw new Error("Graph layout limits exceed the service maximum.");
  }

  async layout(scene: GraphScene, options: GraphLayoutOptions = {}): Promise<PlacedGraphScene> {
    if (this.#closed) throw new GraphLayoutError("closed", "Graph layout service is closed.");
    const input = inputFor(scene, options);
    if (!input.nodes.length) return place(scene, { nodes: [], edges: [], width: PADDING * 2, height: PADDING * 2 });
    if (input.home) return place(scene, homeGeometry(input));
    const key = JSON.stringify(input);
    const cached = this.#cache.get(key);
    if (cached) { this.#cache.delete(key); this.#cache.set(key, cached); return place(scene, cached); }
    const existing = this.#pending.get(key);
    if (existing) return place(scene, await existing);
    if (this.#pending.size >= this.#limit) throw new GraphLayoutError("busy", "Graph layout is busy. Try again shortly.");
    let job!: Job;
    const promise = new Promise<Geometry>((resolve, reject) => {
      job = { key, input, resolve, reject, timer: setTimeout(() => this.#expired(job), this.#timeout) };
    });
    this.#pending.set(key, promise);
    this.#queue.push(job);
    this.#pump();
    return place(scene, await promise);
  }

  close(): void {
    this.#closed = true;
    const jobs = [...this.#queue, ...(this.#active ? [this.#active] : [])];
    this.#queue.length = 0;
    this.#active = undefined;
    this.#resetWorker();
    for (const job of jobs) { clearTimeout(job.timer); job.reject(new GraphLayoutError("closed", "Graph layout service is closed.")); }
    this.#pending.clear(); this.#cache.clear();
  }

  #resetWorker(): void {
    const worker = this.#worker;
    this.#worker = undefined; this.#elk = undefined;
    worker?.terminate();
  }

  #engine(): ElkEngine {
    if (this.#elk) return this.#elk;
    const worker = new Worker(import.meta.resolve("elkjs/lib/elk-worker.min.js"), { ref: false }) as LayoutWorker;
    this.#worker = worker;
    const failed = () => {
      if (this.#worker !== worker) return;
      this.#resetWorker();
      if (this.#active) this.#finish(this.#active, undefined, new GraphLayoutError("worker_failed", "Graph layout worker stopped."));
    };
    worker.addEventListener("error", failed);
    worker.addEventListener("messageerror", failed);
    worker.addEventListener("close", failed);
    this.#elk = new ELK({ workerFactory: () => worker, algorithms: ["layered"] });
    // Bun 1.3 requires this after ELK installs its message listener: the
    // constructor option alone does not release the parent's event loop.
    worker.unref();
    return this.#elk;
  }

  #pump(): void {
    if (this.#closed || this.#active) return;
    const job = this.#queue.shift();
    if (!job) return;
    this.#active = job;
    try {
      void this.#engine().layout(elkInput(job.input)).then(result => {
        if (this.#active !== job) return;
        try { this.#finish(job, geometryFrom(job.input, result)); }
        catch (error) { this.#finish(job, undefined, error instanceof GraphLayoutError ? error : new GraphLayoutError("invalid_layout", "Graph layout returned invalid geometry.")); }
      }, () => {
        if (this.#active !== job) return;
        this.#resetWorker();
        this.#finish(job, undefined, new GraphLayoutError("worker_failed", "Graph layout could not be computed."));
      });
    } catch {
      this.#resetWorker();
      this.#finish(job, undefined, new GraphLayoutError("worker_failed", "Graph layout worker could not start."));
    }
  }

  #finish(job: Job, geometry?: Geometry, error?: Error): void {
    clearTimeout(job.timer);
    this.#pending.delete(job.key);
    if (this.#active === job) this.#active = undefined;
    this.#worker?.unref();
    if (geometry) {
      this.#cache.set(job.key, geometry);
      while (this.#cache.size > this.#cacheLimit) this.#cache.delete(this.#cache.keys().next().value!);
      job.resolve(geometry);
    } else job.reject(error ?? new GraphLayoutError("invalid_layout", "Graph layout returned no geometry."));
    this.#pump();
  }

  #expired(job: Job): void {
    if (this.#active === job) this.#resetWorker();
    else {
      const index = this.#queue.indexOf(job);
      if (index < 0) return;
      this.#queue.splice(index, 1);
    }
    this.#finish(job, undefined, new GraphLayoutError("timeout", "Graph layout took too long. Show fewer connections and try again."));
  }
}

let shared: GraphSceneLayouter | undefined;
export function layoutGraphScene(scene: GraphScene, options?: GraphLayoutOptions): Promise<PlacedGraphScene> {
  shared ??= createGraphSceneLayouter();
  return shared.layout(scene, options);
}
/** Release workers and cached geometry during shutdown or after tests. Later calls start fresh. */
export function closeGraphLayoutWorkers(): void { shared?.close(); shared = undefined; }
