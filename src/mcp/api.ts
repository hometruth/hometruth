import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CLIENT_ADDRESS_HEADER } from "../auth/network";
import type { OpenApiDocument } from "../openapi/document";

export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type QueryValue = string | number | boolean;
export interface ApiRequest {
  method: ApiMethod;
  path: string;
  query?: Record<string, QueryValue | QueryValue[]> | undefined;
  body?: unknown;
}
export type AppFetch = (request: Request) => Response | Promise<Response>;
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const OPERATION_TIMEOUT_MS = 120000;
const BODY_TIMEOUT_MS = 30000;
const responseSignals = new WeakMap<Response, AbortSignal>();

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function toolResult(data: unknown, status = 200): CallToolResult {
  const result = { status, data };
  return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, ...(status >= 400 ? { isError: true } : {}) };
}

/** A path is data, never an origin, a redirect, or a second interpretation of a route. */
export function apiPath(path: string): boolean {
  if (!path.startsWith("/api/") || /[\\?#\s\u0000-\u001f\u007f]/u.test(path)) return false;
  return path.slice(1).split("/").every(part => {
    if (!part) return false;
    try {
      const decoded = decodeURIComponent(part);
      return decoded !== "." && decoded !== ".." && !/[\\/%\u0000-\u001f\u007f]/u.test(decoded);
    } catch { return false; }
  });
}

/** Exact literal routes win over parameterized ones, as they do in the application. */
export function documentedOperation(document: OpenApiDocument, method: ApiMethod, path: string) {
  if (!apiPath(path)) return undefined;
  const parts = path.split("/");
  const matching = Object.entries(document.paths).filter(([pattern]) => {
    const template = pattern.split("/");
    return template.length === parts.length && template.every((part, index) => /^\{[^{}]+\}$/u.test(part) || part === parts[index]);
  }).sort(([a], [b]) => a.split("{").length - b.split("{").length);
  const entry = matching[0];
  const operation = entry && object(entry[1])[method.toLowerCase()];
  return operation ? { path: entry![0], operation: object(operation) } : undefined;
}

/** Media downloads are bounded; streams, video and binary uploads retain their native REST transport. */
export function finiteOperation(operation: Record<string, unknown>): boolean {
  const request = object(operation.requestBody);
  if (Object.keys(request).length && !("application/json" in object(request.content))) return false;
  const successes = Object.entries(object(operation.responses)).filter(([status]) => /^2\d\d$/u.test(status));
  return successes.length > 0 && successes.every(([, response]) => {
    const content = object(object(response).content);
    return !Object.keys(content).length || Object.keys(content).every(type => /^(?:application\/json|text\/(?:plain|yaml|x-yaml)|image\/(?:jpeg|png|gif|webp)|audio\/[\w.+-]+)(?:;|$)/u.test(type));
  });
}

/**
 * Each operation re-enters the application guard with this request's actual
 * credentials and supervisor-established peer. Never substitute a server token
 * or a loopback peer, and never accept headers from a tool argument.
 */
export function apiDispatcher(request: Request, dispatch: AppFetch) {
  return async ({ method, path, query, body }: ApiRequest): Promise<Response> => {
    if (!apiPath(path)) throw new Error("Use a canonical /api/... path without a query string, traversal or encoded separators");
    const url = new URL(path, request.url);
    for (const [name, value] of Object.entries(query ?? {})) {
      for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(name, String(item));
    }
    const headers = new Headers({ accept: "application/json" });
    for (const name of ["authorization", "cookie", "origin", "user-agent", CLIENT_ADDRESS_HEADER]) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    const change = method !== "GET";
    if (change) headers.set("content-type", "application/json");
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(OPERATION_TIMEOUT_MS)]);
    signal.throwIfAborted();
    const dispatched = Promise.resolve(dispatch(new Request(url, { method, headers, redirect: "error", signal,
      ...(change ? { body: JSON.stringify(body === undefined ? {} : body) } : {}),
    }))).then(response => {
      // A handler may not observe cancellation until after it finishes.
      if (signal.aborted) void response.body?.cancel().catch(() => {});
      return response;
    });
    const response = await abortable(dispatched, signal);
    responseSignals.set(response, signal);
    return response;
  };
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  const cancelled = () => new Error("HomeTruth request was cancelled or timed out. A change may already have happened; inspect its state before retrying.");
  if (signal.aborted) {
    // The operation can reject synchronously while the caller cancels it.
    void promise.catch(() => {});
    throw cancelled();
  }
  let interrupted: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    interrupted = () => reject(cancelled());
    signal.addEventListener("abort", interrupted, { once: true });
  });
  try { return await Promise.race([promise, aborted]); }
  finally { if (interrupted) signal.removeEventListener("abort", interrupted); }
}

/** Content-Length is only an early check; the actual bytes and read deadline are always enforced. */
export async function responseBytes(response: Response, limit = MAX_RESPONSE_BYTES, signal = responseSignals.get(response) ?? AbortSignal.timeout(OPERATION_TIMEOUT_MS)): Promise<Uint8Array> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(BODY_TIMEOUT_MS)]);
  if (Number(response.headers.get("content-length") ?? 0) > limit) {
    void response.body?.cancel().catch(() => {});
    throw new Error(`HomeTruth response exceeds the ${limit}-byte MCP limit; use the REST endpoint directly`);
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const next = await abortable(reader.read(), deadline);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) throw new Error(`HomeTruth response exceeds the ${limit}-byte MCP limit; use the REST endpoint directly`);
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function responseJson<T>(response: Response): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await responseBytes(response))) as T;
}

export async function responseResult(response: Response): Promise<CallToolResult> {
  if (response.status === 204) { void response.body?.cancel().catch(() => {}); return toolResult(null, response.status); }
  const type = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  if (type === "application/json") return toolResult(await responseJson(response), response.status);
  const image = /^image\/(?:jpeg|png|gif|webp)$/u.test(type);
  const audio = type.startsWith("audio/");
  const text = ["text/plain", "text/yaml", "text/x-yaml"].includes(type);
  // Audio endpoints may stream indefinitely. Require a finite declared length.
  if ((!image && !audio && !text) || audio && !/^\d+$/u.test(response.headers.get("content-length") ?? "")) {
    void response.body?.cancel().catch(() => {});
    return toolResult({ error: "This response requires its native REST media or streaming endpoint" }, 415);
  }
  const bytes = await responseBytes(response);
  if (text || !response.ok) return toolResult(new TextDecoder().decode(bytes), response.status);
  return { content: [{ type: image ? "image" : "audio", data: Buffer.from(bytes).toString("base64"), mimeType: type }], structuredContent: { status: response.status, mimeType: type, bytes: bytes.length } };
}
