/**
 * How `ht` reaches an install: one base URL, one token, JSON in and out, and
 * an event stream for the live view. Nothing here knows what a device is —
 * only how to ask one install a question and how to say what went wrong.
 *
 * Every request carries the token, so a 401 is always about the token and
 * never about the route. That is the only way a person can act on the answer.
 */
import type { SecretStore } from "../config/secrets";

export class UsageError extends Error {}

export interface StreamFrame {
  readonly event: string;
  readonly data: unknown;
}

export interface Client {
  /** The install this client talks to, for messages that name it. */
  readonly baseUrl: string;
  get(path: string): Promise<unknown>;
  request(method: string, path: string, body?: string, contentType?: string): Promise<unknown>;
  post(path: string, body: unknown, timeoutMs?: number): Promise<unknown>;
  /** A response that is not JSON, such as the YAML tag export. */
  getText(path: string): Promise<string>;
  /** A request whose body is not JSON, such as a tag export being restored. */
  postText(path: string, body: string, contentType: string): Promise<unknown>;
  /** Server-sent events, one frame at a time, until the caller stops reading. */
  stream(path: string, signal: AbortSignal): AsyncIterable<StreamFrame>;
}

export const NO_TOKEN = 'HomeTruth refused this request. Set HOMETRUTH_TOKEN, or store one with "ht secrets set api.cli.token"';

export function client(fetchImpl: typeof fetch, baseUrl: string, token: () => Promise<string | undefined>): Client {
  const authorized = async (headers: Record<string, string>): Promise<Record<string, string>> => {
    const value = await token();
    return value ? { ...headers, authorization: `Bearer ${value}` } : headers;
  };
  const unreachable = (error: unknown) => new Error(
    `HomeTruth is not reachable at ${baseUrl} (${error instanceof Error ? error.message : String(error)}); start it with "bun run dev" or set HOMETRUTH_URL`,
  );
  const refusal = (status: number, payload: { error?: { message?: string; code?: string } } | undefined): string =>
    status === 401 || status === 403
      ? `HomeTruth answered ${status}: ${payload?.error?.message ?? "not allowed"}. ${NO_TOKEN}`
      : `HomeTruth answered ${status}${payload?.error?.code ? ` ${payload.error.code}` : ""}: ${payload?.error?.message ?? "no detail"}`;
  const request = async (path: string, init: RequestInit, timeout: number): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetchImpl(new URL(path, baseUrl), {
        ...init,
        headers: await authorized((init.headers ?? {}) as Record<string, string>),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      throw unreachable(error);
    }
    const payload = await response.json().catch(() => undefined) as { error?: { message?: string; code?: string } } | undefined;
    if (!response.ok) throw new HttpError(response.status, refusal(response.status, payload), payload?.error?.code);
    return payload;
  };
  return {
    baseUrl,
    request: async (method, path, body, contentType = "application/json") => {
      const url = new URL(path, baseUrl);
      if (!url.pathname.startsWith("/api/") || url.origin !== new URL(baseUrl).origin) throw new UsageError("Use a path on this install beginning /api/");
      const response = await fetchImpl(url, {
        method, headers: await authorized({ accept: "application/json", ...(!["GET", "HEAD"].includes(method) ? { "content-type": contentType } : {}) }),
        ...(body !== undefined ? { body } : {}), signal: AbortSignal.timeout(30_000),
      });
      const type = response.headers.get("content-type") ?? "";
      if (response.ok && type.includes("event-stream")) return response.body;
      if (response.ok && type.startsWith("multipart/")) return response.body?.pipeThrough(new TransformStream({
        transform(chunk, controller) { controller.enqueue(new TextEncoder().encode(Buffer.from(chunk).toString("base64") + "\n")); },
      }));
      const result = type.includes("json") ? await response.json() : type.startsWith("text/") ? await response.text() : { contentType: type, base64: Buffer.from(await response.arrayBuffer()).toString("base64") };
      if (!response.ok) throw new HttpError(response.status, refusal(response.status, result as { error?: { message?: string } }));
      return result;
    },
    get: (path) => request(path, { headers: { accept: "application/json" } }, 15_000),
    getText: async (path) => {
      let response: Response;
      try {
        response = await fetchImpl(new URL(path, baseUrl), { headers: await authorized({ accept: "text/yaml" }), signal: AbortSignal.timeout(15_000) });
      } catch (error) {
        throw unreachable(error);
      }
      if (!response.ok) throw new HttpError(response.status, refusal(response.status, undefined));
      return await response.text();
    },
    postText: (path, body, contentType) => request(path, {
      method: "POST", headers: { accept: "application/json", "content-type": contentType }, body,
    }, 30_000),
    post: (path, body, timeout = 30_000) => request(path, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
    }, timeout),
    async *stream(path, signal) {
      let response: Response;
      try {
        response = await fetchImpl(new URL(path, baseUrl), { headers: await authorized({ accept: "text/event-stream" }), signal });
      } catch (error) {
        if (signal.aborted) return;
        throw unreachable(error);
      }
      if (!response.ok || !response.body) throw new HttpError(response.status, refusal(response.status, undefined));
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        // SSE frames are separated by a blank line; a keepalive comment is one too.
        let split = buffer.indexOf("\n\n");
        for (; split >= 0; split = buffer.indexOf("\n\n")) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const parsed = parseFrame(frame);
          if (parsed) yield parsed;
        }
      }
    },
  };
}

/**
 * Carries the status and the install's own error code, so a caller can tell
 * "there is no such device" (`not_found`) from "that device has no such
 * control" (`unknown_control`) — both of which are 404.
 */
export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
    this.name = "HttpError";
  }
}

function parseFrame(frame: string): StreamFrame | undefined {
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":") || line === "") continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /u, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0) return undefined;
  try {
    return { event, data: JSON.parse(data.join("\n")) as unknown };
  } catch {
    return undefined;
  }
}

/**
 * The token this client presents: `HOMETRUTH_TOKEN` when set, else
 * `api.cli.token` from the secrets file. Read lazily and once, so a command
 * that never reaches the install never opens the file.
 */
export function cliToken(
  env: Record<string, string | undefined>,
  store?: SecretStore,
): () => Promise<string | undefined> {
  let cached: Promise<string | undefined> | undefined;
  return () => (cached ??= (async () => {
    const fromEnv = env.HOMETRUTH_TOKEN?.trim();
    if (fromEnv) return fromEnv;
    try {
      const { FileSecretStore, secretsFor } = await import("../config/secrets");
      const secrets = await (store ?? new FileSecretStore(env.HOMETRUTH_SECRETS?.trim() || undefined)).load();
      const value = secretsFor(secrets, "api", "cli").token;
      return typeof value === "string" && value ? value : undefined;
    } catch {
      // No readable secrets file is not an error here: the request will be
      // refused by the install, which gives the better message.
      return undefined;
    }
  })());
}
