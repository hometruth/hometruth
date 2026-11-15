/**
 * HTTPS client for one IQ Gateway on the LAN. The gateway serves a
 * self-signed certificate, so certificate verification is switched off for
 * this client only, and only after the host has been checked to be a private
 * LAN address. Every authenticated request carries `Authorization: Bearer`.
 */
import { isSafeCameraUri } from "../../camera-media";
import { parseInfo, type EnvoyInfo } from "./local-api";
import { EnphaseTokenError, type EnphaseFetch, type OwnerTokenSource } from "./token";

export type EnvoyErrorCode = "invalid_host" | "unreachable" | "unauthorized" | "protocol";

export class EnvoyError extends Error {
  constructor(message: string, readonly code: EnvoyErrorCode) {
    super(message);
    this.name = "EnvoyError";
  }
}

/** Bun's fetch with `tls.rejectUnauthorized: false`; used only for URLs this client built from its checked LAN host. */
function lanSelfSignedFetch(url: URL, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, tls: { rejectUnauthorized: false } } as RequestInit);
}

export interface EnvoyClientOptions {
  readonly host: string;
  /** How a token is obtained; absent means only unauthenticated calls (`/info`) work. */
  readonly tokens?: OwnerTokenSource;
  /** Fetch for the gateway itself; defaults to one that accepts the gateway's self-signed certificate. */
  readonly fetch?: EnphaseFetch;
  readonly timeoutMs?: number;
}

export class EnvoyClient {
  readonly host: string;
  private readonly fetchImpl: EnphaseFetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: EnvoyClientOptions) {
    const host = options.host.trim();
    if (!/^[A-Za-z0-9.-]+$/u.test(host) || !isSafeCameraUri(`https://${host}/`)) {
      throw new EnvoyError("Enphase gateway host must be a private LAN address", "invalid_host");
    }
    this.host = host;
    this.fetchImpl = options.fetch ?? lanSelfSignedFetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
  }

  private url(path: string): URL {
    const url = new URL(path, `https://${this.host}/`);
    if (url.hostname !== this.host.toLowerCase()) throw new EnvoyError("Enphase request left the gateway host", "invalid_host");
    return url;
  }

  private async send(path: string, headers: Record<string, string>): Promise<Response> {
    try {
      return await this.fetchImpl(this.url(path), { method: "GET", redirect: "manual", headers, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      if (error instanceof EnvoyError) throw error;
      const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "is unreachable";
      throw new EnvoyError(`Enphase gateway at ${this.host} ${reason}`, "unreachable");
    }
  }

  /** `GET /info`: serial, part number and firmware. Needs no token on any firmware. */
  async info(): Promise<EnvoyInfo> {
    const response = await this.send("/info", { accept: "application/xml, text/xml" });
    if (!response.ok) throw new EnvoyError(`Enphase gateway answered HTTP ${response.status} for /info`, "protocol");
    try { return parseInfo(await response.text()); }
    catch (error) { throw new EnvoyError(error instanceof Error ? error.message : "Invalid Enphase /info", "protocol"); }
  }

  /**
   * An authenticated JSON read. Resolves `undefined` on 404, which is how a
   * gateway without that subsystem (no batteries, no meters) answers. A 401 is
   * retried once when the token source can offer a different token.
   */
  async json(path: string): Promise<unknown> {
    const tokens = this.options.tokens;
    if (!tokens) throw new EnvoyError("No Enphase owner token or Enlighten login is configured", "unauthorized");
    for (let attempt = 0; ; attempt++) {
      let token: string;
      try { token = await tokens.token(); }
      catch (error) {
        throw new EnvoyError(error instanceof EnphaseTokenError ? error.message : "Could not obtain an Enphase owner token", "unauthorized");
      }
      const response = await this.send(path, { accept: "application/json", authorization: `Bearer ${token}` });
      // Unauthenticated requests are answered 401, or on some builds redirected to the login page.
      if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) {
        await response.body?.cancel().catch(() => undefined);
        if (attempt === 0 && tokens.rejected(token)) continue;
        throw new EnvoyError("Enphase gateway refused the owner token", "unauthorized");
      }
      if (response.status === 404) {
        await response.body?.cancel().catch(() => undefined);
        return undefined;
      }
      if (!response.ok) throw new EnvoyError(`Enphase gateway answered HTTP ${response.status} for ${path.split("?")[0]}`, "protocol");
      try { return await response.json(); }
      catch { throw new EnvoyError(`Enphase gateway returned invalid JSON for ${path.split("?")[0]}`, "protocol"); }
    }
  }
}
