/** Read-only REVEAL cloud API, recovered from the official web app. See docs/REVEAL.md. */
export const REVEAL_API = "https://api.reveal.ishareit.net/v1/";
export const REVEAL_AUTH = "https://cognito-idp.us-east-1.amazonaws.com/";
export const REVEAL_CLIENT_ID = "6r9tpojvgvkci5trla0ip14mon";
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export type RevealFetch = (url: URL, init?: RequestInit) => Promise<Response>;
export interface RevealCredentials { readonly email: string; readonly password: string }
export interface RevealCamera { readonly cameraId: string; readonly name?: string }
export interface RevealPhoto {
  readonly photoId: string;
  readonly cameraId: string;
  /** A signed URL: keep this out of logs and public device documents. */
  readonly photoUrl: string;
  /** Preserve the camera's timestamp; the camera's time zone is not known here. */
  readonly photoTimestamp?: string | number;
  readonly createdTimestamp?: number;
}
export interface RevealPhotoPage { readonly photos: readonly RevealPhoto[]; readonly nextToken?: string }
type ObjectValue = Record<string, unknown>;

export class RevealError extends Error {
  constructor(message: string, readonly code: "authentication" | "challenge" | "unavailable" | "rate_limited" | "protocol" | "invalid_value") {
    super(message);
    this.name = "RevealError";
  }
}

function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RevealError("REVEAL returned an unexpected response", "protocol");
  return value as ObjectValue;
}
function string(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new RevealError("REVEAL omitted a required field", "protocol");
  return value;
}
function boundedInteger(value: number, max: number): number {
  if (!Number.isInteger(value) || value < 1 || value > max) throw new RevealError(`Expected an integer from 1 to ${max}`, "invalid_value");
  return value;
}
function photo(value: unknown): RevealPhoto {
  const p = object(value);
  return {
    photoId: string(p.photoId), cameraId: string(p.cameraId), photoUrl: string(p.photoUrl),
    ...(typeof p.photoTimestamp === "string" || typeof p.photoTimestamp === "number" ? { photoTimestamp: p.photoTimestamp } : {}),
    ...(typeof p.createdTimestamp === "number" ? { createdTimestamp: p.createdTimestamp } : {}),
  };
}

/** Restrict downloads to HTTPS vendor/CDN hosts; never send account tokens to media hosts. */
export function revealPhotoUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new RevealError("REVEAL returned an invalid image address", "protocol"); }
  const domains = ["amazonaws.com", "cloudfront.net", "ishareit.net", "revealcellcam.com", "tactacam.com"];
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")
    || !domains.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) {
    throw new RevealError("REVEAL returned an unrecognized image host", "protocol");
  }
  return url;
}

export class RevealClient {
  private readonly fetchImpl: RevealFetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private accessToken?: string;
  private refreshToken: string | undefined;
  private expiresAt = 0;
  private authentication: Promise<string> | undefined;

  constructor(private readonly credentials: RevealCredentials, options: { fetch?: RevealFetch; now?: () => number; timeoutMs?: number } = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = boundedInteger(options.timeoutMs ?? 30_000, 60_000);
  }

  private async request(url: URL, init: RequestInit = {}): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {
      // fetch errors can include signed URLs or request bodies; never propagate them.
      throw new RevealError("REVEAL cloud request failed or timed out", "unavailable");
    }
  }

  private async json(response: Response): Promise<ObjectValue> {
    try { return object(await response.json()); }
    catch { throw new RevealError("REVEAL returned an invalid JSON response", "protocol"); }
  }

  private async authenticate(): Promise<string> {
    if (!this.credentials.email.trim() || !this.credentials.password) throw new RevealError("Configure the REVEAL email and password in .env.local or the device secrets", "authentication");
    let refreshing = Boolean(this.refreshToken);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await this.request(new URL(REVEAL_AUTH), {
        method: "POST",
        headers: { "Content-Type": "application/x-amz-json-1.1", "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth" },
        body: JSON.stringify({ ClientId: REVEAL_CLIENT_ID,
          AuthFlow: refreshing ? "REFRESH_TOKEN_AUTH" : "USER_PASSWORD_AUTH",
          AuthParameters: refreshing ? { REFRESH_TOKEN: this.refreshToken } : { USERNAME: this.credentials.email.trim(), PASSWORD: this.credentials.password },
        }),
      });
      const body = await this.json(response);
      const type = typeof body.__type === "string" ? body.__type.split("#").at(-1) : undefined;
      if (response.status === 429 || type === "TooManyRequestsException") throw new RevealError("REVEAL rate limited login; try again later", "rate_limited");
      if (refreshing && type === "NotAuthorizedException") { this.refreshToken = undefined; refreshing = false; continue; }
      if (!response.ok) throw new RevealError("REVEAL login failed; check the account credentials and account status", "authentication");
      if (body.ChallengeName) throw new RevealError("REVEAL requires interactive sign-in or MFA, which this adapter does not support yet", "challenge");
      const result = object(body.AuthenticationResult);
      const token = string(result.AccessToken);
      if (typeof result.ExpiresIn !== "number" || result.ExpiresIn <= 0) throw new RevealError("REVEAL omitted the token lifetime", "protocol");
      this.accessToken = token;
      if (typeof result.RefreshToken === "string") this.refreshToken = result.RefreshToken;
      this.expiresAt = this.now() + Math.max(0, result.ExpiresIn - 60) * 1000;
      return token;
    }
    throw new RevealError("REVEAL login failed", "authentication");
  }

  private async token(): Promise<string> {
    if (this.accessToken && this.now() < this.expiresAt) return this.accessToken;
    if (!this.authentication) this.authentication = this.authenticate().finally(() => { this.authentication = undefined; });
    return this.authentication;
  }

  private async get(path: string, params: Record<string, string> = {}): Promise<ObjectValue> {
    const url = new URL(path, REVEAL_API);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.token();
      const response = await this.request(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json", "Reveal-User-Agent": "RevealWeb/5.10.0" } });
      if (response.status === 401 && attempt === 0) {
        if (this.accessToken === token) this.expiresAt = 0;
        await response.body?.cancel();
        continue;
      }
      if (response.status === 429) throw new RevealError("REVEAL rate limited requests; try again later", "rate_limited");
      if (response.status === 401 || response.status === 403) throw new RevealError("REVEAL denied access to this account or camera", "authentication");
      if (!response.ok) throw new RevealError(`REVEAL cloud returned HTTP ${response.status}`, "unavailable");
      const body = await this.json(response);
      if (body.success === false) throw new RevealError("REVEAL reported an unsuccessful request", "protocol");
      return object(body.response);
    }
    throw new RevealError("REVEAL authentication failed", "authentication");
  }

  /** The official camera list endpoint, using the web app's default query. */
  async listCameras(): Promise<readonly RevealCamera[]> {
    const response = await this.get("cameras");
    if (!Array.isArray(response.cameras)) throw new RevealError("REVEAL omitted its camera list", "protocol");
    return response.cameras.map(value => {
      const camera = object(value);
      return { cameraId: string(camera.cameraId), ...(typeof camera.name === "string" ? { name: camera.name } : {}) };
    });
  }

  async listPhotos(options: { cameraId: string; size?: number; paginationKey?: string }): Promise<RevealPhotoPage> {
    const cameraId = options.cameraId.trim();
    if (!cameraId || cameraId.includes(",")) throw new RevealError("Provide one REVEAL camera ID", "invalid_value");
    const response = await this.get("photos/v2", { cameraIds: cameraId, size: String(boundedInteger(options.size ?? 100, 100)), ...(options.paginationKey ? { paginationKey: options.paginationKey } : {}) });
    if (!Array.isArray(response.photos)) throw new RevealError("REVEAL omitted its photo list", "protocol");
    const photos = response.photos.map(photo);
    if (photos.some(p => p.cameraId !== cameraId)) throw new RevealError("REVEAL returned photos for a different camera", "protocol");
    if (response.nextToken != null && typeof response.nextToken !== "string") throw new RevealError("REVEAL returned an invalid pagination token", "protocol");
    return { photos, ...(response.nextToken ? { nextToken: response.nextToken as string } : {}) };
  }

  /** Feed order is the official app's order; deduplicate overlapping pages and bound traversal. */
  async *photos(cameraId: string, maxPages: number | "all" = 100): AsyncGenerator<RevealPhoto> {
    if (maxPages !== "all") boundedInteger(maxPages, 10_000);
    const seen = new Set<string>();
    const tokens = new Set<string>();
    let paginationKey: string | undefined;
    for (let page = 0; maxPages === "all" || page < maxPages; page++) {
      const result = await this.listPhotos({ cameraId, ...(paginationKey ? { paginationKey } : {}) });
      for (const photo of result.photos) if (!seen.has(photo.photoId)) { seen.add(photo.photoId); yield photo; }
      if (!result.nextToken) return;
      if (tokens.has(result.nextToken)) throw new RevealError("REVEAL repeated a pagination token", "protocol");
      tokens.add(result.nextToken);
      paginationKey = result.nextToken;
    }
    throw new RevealError("REVEAL photo download reached its page limit; increase --max-pages to continue", "invalid_value");
  }

  async downloadPhoto(value: RevealPhoto): Promise<Uint8Array> {
    let current = value;
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await this.request(revealPhotoUrl(current.photoUrl));
      if ((response.status === 401 || response.status === 403) && attempt === 0) {
        await response.body?.cancel();
        current = photo((await this.get(`photos/${encodeURIComponent(value.photoId)}`)).photo);
        if (current.photoId !== value.photoId || current.cameraId !== value.cameraId) throw new RevealError("REVEAL refreshed a different photo", "protocol");
        continue;
      }
      if (!response.ok) throw new RevealError(`REVEAL image download returned HTTP ${response.status}`, "unavailable");
      const type = response.headers.get("content-type")?.split(";")[0]?.trim();
      if (type && type !== "image/jpeg" && type !== "application/octet-stream") throw new RevealError("REVEAL did not return a JPEG image", "protocol");
      const reader = response.body?.getReader();
      if (!reader) throw new RevealError("REVEAL returned an empty image", "protocol");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > MAX_IMAGE_BYTES) throw new RevealError("REVEAL image exceeds the 20 MiB download limit", "protocol");
          chunks.push(chunk.value);
        }
      } catch (error) {
        if (error instanceof RevealError) throw error;
        throw new RevealError("REVEAL image download failed or timed out", "unavailable");
      } finally { await reader.cancel().catch(() => {}); }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new RevealError("REVEAL returned invalid JPEG data", "protocol");
      return bytes;
    }
    throw new RevealError("REVEAL image is unavailable", "unavailable");
  }
}
