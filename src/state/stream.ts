/**
 * The stream side of the state graph: what a `GET /api/state/stream` request
 * asks for, how many streams one process serves, and how a frame is spelled
 * on the wire. Frames are validated against `src/state/schemas.ts` under
 * test so a malformed record fails the test that produced it instead of a
 * browser.
 */
import { isTier, NODE_ID_PATTERN, STREAM_LIMITS, type NodeId, type StreamFrame, type Tier } from "./protocol";
import { stateValidators } from "./schemas";

export type StreamRequest =
  | { readonly ok: true; readonly nodes: readonly NodeId[]; readonly tier: Tier }
  | { readonly ok: false; readonly code: "invalid_node" | "too_many_nodes" | "invalid_tier"; readonly message: string };

/**
 * `?node=device/<id>&node=group/<id>&tier=live|glance`; nodes deduped in request order, tier defaults to glance.
 * No nodes is a valid stream: a page without device elements still holds its one connection, whose
 * `hello` names the worker generation and whose loss marks the page disconnected.
 */
export function parseStreamRequest(url: URL, limits: { readonly maxNodes: number } = STREAM_LIMITS): StreamRequest {
  const nodes: NodeId[] = [];
  for (const value of url.searchParams.getAll("node")) {
    if (!NODE_ID_PATTERN.test(value)) return { ok: false, code: "invalid_node", message: `"${value}" is not a node id; use device/<id> or group/<id>` };
    if (!nodes.includes(value as NodeId)) nodes.push(value as NodeId);
  }
  if (nodes.length > limits.maxNodes) {
    return { ok: false, code: "too_many_nodes", message: `At most ${limits.maxNodes} nodes per stream; this request names ${nodes.length}` };
  }
  const tier = url.searchParams.get("tier") ?? "glance";
  if (!isTier(tier)) return { ok: false, code: "invalid_tier", message: `"${tier}" is not a tier; use live or glance` };
  return { ok: true, nodes, tier };
}

export const KEEPALIVE_COMMENT = ": keepalive\n\n";

export function retryLine(ms: number): string {
  return `retry: ${ms}\n\n`;
}

const FRAME_VALIDATORS = { hello: "streamHello", state: "nodeRecord", observed: "streamObserved", error: "streamError" } as const;

/** One SSE frame. Under test every frame is checked against its schema before it leaves. */
export function encodeFrame(frame: StreamFrame): string {
  if (process.env.NODE_ENV === "test") {
    const validate = stateValidators[FRAME_VALIDATORS[frame.event]];
    if (!validate(frame.data)) {
      throw new Error(`Invalid ${frame.event} frame: ${(validate.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join("; ")}`);
    }
  }
  return `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
}

export interface StreamHandle {
  /** Idempotent: the route calls it when the client goes, the hub when it rebinds. */
  close(): void;
}

/** Open connections of one process, capped so a misbehaving page cannot exhaust the worker. */
export class Streams {
  readonly #open = new Map<number, () => void>();
  #next = 1;

  constructor(private readonly limits: { readonly maxStreams: number } = STREAM_LIMITS) {}

  get count(): number {
    return this.#open.size;
  }

  /** Register a connection; `onClose` runs once, whoever closes it. Undefined at capacity. */
  open(onClose: () => void): StreamHandle | undefined {
    if (this.#open.size >= this.limits.maxStreams) return undefined;
    const id = this.#next++;
    this.#open.set(id, onClose);
    return { close: () => this.#close(id) };
  }

  closeAll(): void {
    for (const id of [...this.#open.keys()]) this.#close(id);
  }

  #close(id: number): void {
    const onClose = this.#open.get(id);
    if (!onClose) return;
    this.#open.delete(id);
    onClose();
  }
}
