/**
 * `GET /api/state/stream`: one Server-Sent Events connection per page that
 * carries the records of the nodes it names. The first frame says hello,
 * the snapshot follows in request order, then one `state` frame per changed
 * node per flush and one `observed` frame per flush for the polls that
 * changed nothing. A recoverable condition never answers non-200: a worker
 * at capacity still says hello, explains itself in an `error` frame, asks
 * for a long retry and closes. Only a malformed request is a 400.
 */
import { Hono } from "hono";
import { REAL_TIMERS, type ObserverTimers } from "../state/observer";
import { parseNode, STREAM_LIMITS, type NodeId, type StreamHello } from "../state/protocol";
import type { StateHub } from "../state/hub";
import { encodeFrame, KEEPALIVE_COMMENT, parseStreamRequest, retryLine } from "../state/stream";
import { errorJson, type AppEnvironment } from "./http";

export interface StateRouteOptions {
  /** The keepalive clock; injected by tests. */
  readonly timers?: ObserverTimers;
  readonly keepaliveMs?: number;
  /** A group's members, so a group node can be checked against what a token reaches. */
  readonly groupMembers?: (groupId: string) => readonly string[] | undefined;
}

const SSE_HEADERS = { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } as const;

export function stateRoutes(hub: StateHub, options: StateRouteOptions = {}): Hono<AppEnvironment> {
  const timers = options.timers ?? REAL_TIMERS;
  const keepaliveMs = options.keepaliveMs ?? STREAM_LIMITS.keepaliveMs;
  const encoder = new TextEncoder();
  const app = new Hono<AppEnvironment>();

  app.get("/api/state", (context) => {
    const principal = context.get("principal");
    const requested = context.req.queries("node");
    if (requested?.some(node => !parseNode(node))) return errorJson(context, 400, "invalid_request", "Invalid state node");
    const records = hub.snapshot(requested as NodeId[] | undefined).filter(record => {
      if (!principal) return true;
      const parsed = parseNode(record.node)!;
      if (parsed.kind === "device") return principal.reaches(parsed.id);
      if (parsed.kind === "group") {
        const members = options.groupMembers?.(parsed.id);
        return Boolean(members && principal.reachesAll(members));
      }
      return principal.devices() === "all";
    });
    context.header("Cache-Control", "no-store");
    return context.json({ generation: hub.generation, records });
  });

  app.get("/api/state/stream", (context) => {
    const request = parseStreamRequest(new URL(context.req.url), hub.limits);
    if (!request.ok) return errorJson(context, 400, "invalid_request", request.message);
    const { tier } = request;
    /**
     * A page asks for the nodes its elements are bound to, and a token may not
     * reach all of them. Dropping the ones it cannot see is better than
     * refusing the stream: the rest of the page stays live, and the `hello`
     * frame names what is actually coming, so nothing waits for a record that
     * will never arrive.
     */
    const principal = context.get("principal");
    const nodes: readonly NodeId[] = principal
      ? request.nodes.filter(node => {
        const parsed = parseNode(node);
        if (!parsed) return false;
        if (parsed.kind === "device") return principal.reaches(parsed.id);
        if (parsed.kind === "group") return principal.reachesAll(options.groupMembers?.(parsed.id) ?? []);
        // An automation belongs to the site, not to any device.
        return principal.devices() === "all";
      })
      : request.nodes;
    const hello: StreamHello = { generation: hub.generation, tier, nodes, keepaliveMs };

    let cleanup: (() => void) | undefined;
    const handle = hub.streams.open(() => cleanup?.());
    if (!handle) {
      const body = retryLine(STREAM_LIMITS.retryWhenFullMs)
        + encodeFrame({ event: "hello", data: hello })
        + encodeFrame({ event: "error", data: { code: "too_many_streams", message: `This server already serves ${hub.limits.maxStreams} streams; retrying in ${STREAM_LIMITS.retryWhenFullMs / 1000} s` } });
      return new Response(body, { headers: SSE_HEADERS });
    }

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (text: string) => {
          // A write that fails is a client that left without a cancel: release its nodes now, not never.
          try { controller.enqueue(encoder.encode(text)); } catch { cleanup?.(); }
        };
        send(retryLine(STREAM_LIMITS.retryMs));
        send(encodeFrame({ event: "hello", data: hello }));
        // A write still in its microtask lands in the snapshot, not in a second frame.
        hub.graph.flush();
        for (const record of hub.graph.snapshot(nodes)) send(encodeFrame({ event: "state", data: record }));
        const subscription = hub.graph.subscribe(
          nodes,
          (record) => send(encodeFrame({ event: "state", data: record })),
          (observed) => send(encodeFrame({ event: "observed", data: observed })),
        );
        const releases = nodes.map((node) => hub.observer.retain(node, tier));
        let keepalive: unknown;
        const tick = () => {
          send(KEEPALIVE_COMMENT);
          keepalive = timers.set(tick, keepaliveMs);
        };
        keepalive = timers.set(tick, keepaliveMs);
        let done = false;
        cleanup = () => {
          if (done) return;
          done = true;
          timers.clear(keepalive);
          subscription.close();
          for (const release of releases) release();
          handle.close();
          try { controller.close(); } catch { /* Already closed by the client. */ }
        };
      },
      cancel() {
        cleanup?.();
      },
    });
    context.req.raw.signal.addEventListener("abort", () => cleanup?.(), { once: true });

    return new Response(stream, { headers: SSE_HEADERS });
  });

  return app;
}
