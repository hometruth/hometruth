/**
 * An HTTPS relay for a vendor host an isolated device insists on reaching:
 * HomeTruth terminates the device's TLS (with the stand-in certificate),
 * forwards each request to the real host over its own, unblocked, path,
 * hands the real answer back, and keeps a private copy of both. It is how
 * the vendor's HTTPS protocol gets learned before it can be emulated, and
 * how a device that treats a dead API as a dead network is kept content
 * while everything it says and hears is captured.
 *
 * The real host is resolved through a public resolver, never the gateway,
 * because the gateway answers with HomeTruth's own address while the
 * override is on. Exchanges are written, owner-only, under
 * `.hometruth/captures/https/<host>/`; they may carry tokens, so they are
 * never logged, only counted.
 */
import { chmod, mkdir, writeFile } from "node:fs/promises";
import https from "node:https";
import { Resolver } from "node:dns/promises";
import { join, resolve } from "node:path";
import type { CaptureSource, HttpInterceptor } from "./isolation";

export interface HttpsRelayOptions {
  readonly hostnames: readonly string[];
  /** Resolves the real host; default: Google's public resolvers, which are not subject to the gateway's overrides. */
  readonly resolve?: (hostname: string) => Promise<readonly string[]>;
  /** Where exchanges are kept; empty string keeps none. Default `.hometruth/captures/https`. */
  readonly captureDirectory?: string;
  /** Replaced in tests: forwards one request and returns the upstream response. */
  readonly forward?: (address: string, hostname: string, request: Request, body: Uint8Array) => Promise<Response>;
  /** Called after each exchange with structural facts only. */
  readonly onExchange?: (exchange: RelayExchange) => void;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

export interface RelayExchange {
  readonly at: string;
  readonly hostname: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly source: CaptureSource;
  readonly file?: string;
}

const MAX_BODY = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;

export async function publicResolve(hostname: string): Promise<readonly string[]> {
  const resolver = new Resolver({ timeout: 3_000, tries: 2 });
  resolver.setServers(["8.8.8.8", "1.1.1.1"]);
  return await resolver.resolve4(hostname);
}

/** Headers that belong to one hop and must not be copied across. */
const HOP_HEADERS = new Set(["connection", "keep-alive", "transfer-encoding", "proxy-connection", "upgrade", "te", "trailer"]);

function forwardWithNodeHttps(address: string, hostname: string, request: Request, body: Uint8Array, timeoutMs: number): Promise<Response> {
  const url = new URL(request.url);
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    if (!HOP_HEADERS.has(name.toLowerCase())) headers[name] = value;
  });
  headers.host = hostname;
  if (body.length > 0) headers["content-length"] = String(body.length);
  return new Promise((resolvePromise, reject) => {
    const upstream = https.request({
      host: address,
      servername: hostname,
      port: 443,
      method: request.method,
      path: `${url.pathname}${url.search}`,
      headers,
      timeout: timeoutMs,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (value === undefined || HOP_HEADERS.has(name.toLowerCase()) || name.toLowerCase() === "content-length") continue;
          responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
        resolvePromise(new Response(Buffer.concat(chunks), { status: response.statusCode ?? 502, headers: responseHeaders }));
      });
      response.on("error", reject);
    });
    upstream.on("timeout", () => upstream.destroy(new Error(`${hostname} did not answer within ${timeoutMs} ms`)));
    upstream.on("error", reject);
    if (body.length > 0) upstream.write(body);
    upstream.end();
  });
}

export class HttpsRelay implements HttpInterceptor {
  readonly id: string;
  readonly hostnames: readonly string[];
  private readonly resolveHost: (hostname: string) => Promise<readonly string[]>;
  private readonly directory: string | undefined;
  private readonly forward: (address: string, hostname: string, request: Request, body: Uint8Array) => Promise<Response>;
  private readonly onExchange: ((exchange: RelayExchange) => void) | undefined;
  private readonly now: () => number;
  private readonly addresses = new Map<string, { addresses: readonly string[]; at: number }>();
  private sequence = 0;
  count = 0;

  constructor(options: HttpsRelayOptions) {
    this.hostnames = options.hostnames.map((name) => name.toLowerCase());
    this.id = `https-relay:${this.hostnames.join(",")}`;
    this.resolveHost = options.resolve ?? publicResolve;
    const directory = options.captureDirectory ?? ".hometruth/captures/https";
    this.directory = directory ? resolve(directory) : undefined;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.forward = options.forward ?? ((address, hostname, request, body) => forwardWithNodeHttps(address, hostname, request, body, timeoutMs));
    this.onExchange = options.onExchange;
    this.now = options.now ?? Date.now;
  }

  private async upstreamAddress(hostname: string): Promise<string> {
    const cached = this.addresses.get(hostname);
    if (cached && this.now() - cached.at < 5 * 60_000 && cached.addresses.length > 0) return cached.addresses[Math.floor(Math.random() * cached.addresses.length)]!;
    const addresses = await this.resolveHost(hostname);
    if (addresses.length === 0) throw new Error(`${hostname} has no public address`);
    this.addresses.set(hostname, { addresses, at: this.now() });
    return addresses[0]!;
  }

  async handle(request: Request, source: CaptureSource): Promise<Response | undefined> {
    const url = new URL(request.url);
    const hostname = (request.headers.get("host") ?? url.host).split(":")[0]!.toLowerCase();
    if (!this.hostnames.includes(hostname)) return undefined;
    if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return new Response("", { status: 413 });
    const body = new Uint8Array(await request.arrayBuffer());
    const address = await this.upstreamAddress(hostname);
    const response = await this.forward(address, hostname, request, body);
    const responseBody = new Uint8Array(await response.arrayBuffer());
    this.count += 1;
    const file = this.directory ? await this.keep(hostname, source, request, body, response, responseBody).catch(() => undefined) : undefined;
    const exchange: RelayExchange = {
      at: new Date(this.now()).toISOString(),
      hostname,
      method: request.method,
      path: `${url.pathname}${url.search}`,
      status: response.status,
      requestBytes: body.length,
      responseBytes: responseBody.length,
      source,
      ...(file ? { file } : {}),
    };
    this.onExchange?.(exchange);
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(responseBody, { status: response.status, headers });
  }

  private async keep(hostname: string, source: CaptureSource, request: Request, body: Uint8Array, response: Response, responseBody: Uint8Array): Promise<string> {
    const directory = join(this.directory!, hostname.replace(/[^a-z0-9.-]/giu, "_"));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    this.sequence += 1;
    const url = new URL(request.url);
    const path = join(directory, `${new Date(this.now()).toISOString().replace(/[:.]/gu, "-")}-${String(this.sequence).padStart(4, "0")}.json`);
    const asText = (bytes: Uint8Array): string | { base64: string } => {
      const text = new TextDecoder("utf8", { fatal: false }).decode(bytes);
      return /^[\x09\x0a\x0d\x20-\x7e -￿]*$/u.test(text) ? text : { base64: Buffer.from(bytes).toString("base64") };
    };
    await writeFile(path, JSON.stringify({
      source: source.address,
      device: source.device?.id,
      request: { method: request.method, path: `${url.pathname}${url.search}`, headers: Object.fromEntries(request.headers), body: asText(body) },
      response: { status: response.status, headers: Object.fromEntries(response.headers), body: asText(responseBody) },
    }, null, 2), { mode: 0o600 });
    await chmod(path, 0o600);
    return path;
  }
}
