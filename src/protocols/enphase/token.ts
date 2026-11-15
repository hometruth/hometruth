/**
 * Owner tokens for IQ Gateway firmware 7 and later. The gateway accepts a JWT
 * issued by Enphase's cloud for one gateway serial; owner tokens last about a
 * year. A token source either holds a token the user pasted in or logs in to
 * Enlighten to fetch one, keeping it only in memory.
 *
 * No message here ever contains a token, password or session id.
 */

export type EnphaseFetch = (url: URL, init?: RequestInit) => Promise<Response>;

export type EnphaseTokenErrorCode = "token_expired" | "token_rejected" | "login_failed" | "cloud_unreachable" | "cloud_protocol" | "retry_later";

export class EnphaseTokenError extends Error {
  constructor(message: string, readonly code: EnphaseTokenErrorCode) {
    super(message);
    this.name = "EnphaseTokenError";
  }
}

export interface OwnerTokenSource {
  /** A token to send, fetching one first when needed. */
  token(): Promise<string>;
  /**
   * The gateway answered 401 to `rejected`. Returns true when a different
   * token can be tried, so the caller retries once; false when nothing better
   * is available.
   */
  rejected(rejected: string): boolean;
}

export const JWT_PATTERN = "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]*$";
const JWT = new RegExp(JWT_PATTERN, "u");

/** The `exp` claim of a JWT, unverified; undefined when there is none or the token is not a JWT. */
export function tokenExpiry(token: string): Date | undefined {
  if (!JWT.test(token)) return undefined;
  try {
    const payload: unknown = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
    const exp = (payload as { exp?: unknown } | null)?.exp;
    return typeof exp === "number" && Number.isFinite(exp) ? new Date(exp * 1000) : undefined;
  } catch {
    return undefined;
  }
}

/** A token from the secrets file. It cannot be renewed here; when it expires or is refused, the user replaces it. */
export class StaticOwnerToken implements OwnerTokenSource {
  constructor(private readonly value: string, private readonly now: () => number = Date.now) {
    if (!JWT.test(value)) throw new EnphaseTokenError("The Enphase owner token is not a JWT", "token_rejected");
  }

  async token(): Promise<string> {
    const expiry = tokenExpiry(this.value);
    if (expiry && expiry.getTime() <= this.now()) {
      throw new EnphaseTokenError(`The Enphase owner token expired on ${expiry.toISOString().slice(0, 10)}; replace it in the secrets file`, "token_expired");
    }
    return this.value;
  }

  rejected(): boolean { return false; }
}

export const ENLIGHTEN_LOGIN_URL = "https://enlighten.enphaseenergy.com/login/login.json";
export const ENTREZ_TOKENS_URL = "https://entrez.enphaseenergy.com/tokens";

export interface EnlightenOwnerTokenOptions {
  readonly username: string;
  readonly password: string;
  /** The gateway serial the token is issued for, read from the gateway when not configured. */
  readonly serialNumber: () => Promise<string>;
  /** Fetch for the two Enphase cloud calls; verifies TLS normally. */
  readonly fetch?: EnphaseFetch;
  readonly now?: () => number;
  /** After a failed login, wait this long before asking the cloud again. */
  readonly retryAfterMs?: number;
  /** Renew a cached token this long before its `exp`. */
  readonly renewBeforeMs?: number;
  readonly timeoutMs?: number;
}

/**
 * Logs in to Enlighten and asks Entrez for an owner token for this gateway:
 * `POST login.json` (form `user[email]`, `user[password]`) → `session_id`,
 * then `POST /tokens` (JSON `session_id`, `serial_num`, `username`) → the
 * token as plain text. The token is cached in memory and refreshed when it
 * nears expiry or the gateway refuses it. Failed logins are not retried for
 * `retryAfterMs`, so a wrong password does not hammer the cloud on every poll.
 */
export class EnlightenOwnerToken implements OwnerTokenSource {
  private cached: string | undefined;
  private fetchedAt: number | undefined;
  private pending: Promise<string> | undefined;
  private failure: { at: number; error: EnphaseTokenError } | undefined;
  private readonly fetchImpl: EnphaseFetch;
  private readonly now: () => number;
  private readonly retryAfterMs: number;
  private readonly renewBeforeMs: number;
  private readonly timeoutMs: number;

  constructor(private readonly options: EnlightenOwnerTokenOptions) {
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? Date.now;
    this.retryAfterMs = options.retryAfterMs ?? 5 * 60_000;
    this.renewBeforeMs = options.renewBeforeMs ?? 24 * 60 * 60_000;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async token(): Promise<string> {
    if (this.cached) {
      const expiry = tokenExpiry(this.cached);
      if (!expiry || expiry.getTime() - this.renewBeforeMs > this.now()) return this.cached;
      this.cached = undefined;
    }
    if (this.pending) return this.pending;
    if (this.failure && this.now() - this.failure.at < this.retryAfterMs) {
      throw new EnphaseTokenError(`${this.failure.error.message}; retrying later`, "retry_later");
    }
    this.pending = this.fetchToken()
      .then((token) => { this.cached = token; this.fetchedAt = this.now(); this.failure = undefined; return token; })
      .catch((error: unknown) => {
        const failure = error instanceof EnphaseTokenError ? error : new EnphaseTokenError("Could not fetch an Enphase owner token", "cloud_protocol");
        this.failure = { at: this.now(), error: failure };
        throw failure;
      })
      .finally(() => { this.pending = undefined; });
    return this.pending;
  }

  rejected(rejected: string): boolean {
    if (this.cached === rejected) {
      this.cached = undefined;
      // A token the cloud just issued and the gateway still refuses will not
      // improve by asking again on every poll: back off like a failed login.
      if (this.fetchedAt !== undefined && this.now() - this.fetchedAt < this.retryAfterMs) {
        this.failure = { at: this.now(), error: new EnphaseTokenError("The gateway refused a newly issued owner token", "token_rejected") };
        return false;
      }
      return !this.failure || this.now() - this.failure.at >= this.retryAfterMs;
    }
    // Someone already replaced the refused token, or is fetching one.
    return this.cached !== undefined || this.pending !== undefined;
  }

  private async post(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(new URL(url), { ...init, method: "POST", redirect: "error", signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {
      throw new EnphaseTokenError(`Could not reach ${new URL(url).hostname}`, "cloud_unreachable");
    }
  }

  private async fetchToken(): Promise<string> {
    const serialNumber = await this.options.serialNumber();
    const form = new URLSearchParams({ "user[email]": this.options.username, "user[password]": this.options.password });
    const login = await this.post(ENLIGHTEN_LOGIN_URL, { headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: form.toString() });
    if (login.status === 401 || login.status === 403) throw new EnphaseTokenError("Enlighten refused the username or password", "login_failed");
    if (!login.ok) throw new EnphaseTokenError(`Enlighten login answered HTTP ${login.status}`, "cloud_protocol");
    const session = await login.json().catch(() => undefined) as { session_id?: unknown; message?: unknown } | undefined;
    const sessionId = session?.session_id;
    if (typeof sessionId !== "string" || !sessionId) {
      // Enlighten answers 200 with `{"message":"failure"}` for bad credentials.
      throw new EnphaseTokenError("Enlighten refused the username or password", "login_failed");
    }
    const issued = await this.post(ENTREZ_TOKENS_URL, {
      headers: { accept: "text/plain", "content-type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, serial_num: serialNumber, username: this.options.username }),
    });
    if (issued.status === 401 || issued.status === 403) throw new EnphaseTokenError("Enphase would not issue a token for this gateway; check that the account owns it", "login_failed");
    if (!issued.ok) throw new EnphaseTokenError(`Enphase token service answered HTTP ${issued.status}`, "cloud_protocol");
    const token = (await issued.text().catch(() => "")).trim();
    if (!JWT.test(token)) throw new EnphaseTokenError("Enphase token service returned something that is not a token", "cloud_protocol");
    return token;
  }
}
