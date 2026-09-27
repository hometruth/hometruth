import { DetectionPreviews, PreviewAccessError } from "./previews";

interface ProtectPreviewConfig {
  baseUrl: string; username: string; password: string; skipTlsVerify: boolean;
  cameras: Readonly<Record<string, string>>;
}
type ProtectFetch = (url: URL, init: RequestInit & { tls: { rejectUnauthorized: boolean } }) => Promise<Response>;

export function protectPreviewConfig(value: unknown, cameras: Readonly<Record<string, string>> | undefined,
  username: string | undefined, password: string | undefined): ProtectPreviewConfig | undefined {
  if (!username || !password || !cameras || !value || typeof value !== "object") return;
  const v = value as Record<string, unknown>;
  if (typeof v.baseUrl !== "string") throw new Error("Protect preview base URL is missing");
  const url = new URL(v.baseUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/"
    || Object.values(cameras).some(id => !/^[a-f0-9]{24}$/.test(id))) throw new Error("Invalid Protect preview configuration");
  return { baseUrl: url.origin, username, password, skipTlsVerify: v.skipTlsVerify === true, cameras };
}

/** Protect's recording-snapshot API requires a local login; integration API keys only expose live snapshots. */
export function createProtectPreviews(config: ProtectPreviewConfig, fetcher: ProtectFetch = fetch): DetectionPreviews {
  let cookie = "", csrf = "", authenticatedAt = 0, retryAfter = 0;
  let login: Promise<void> | undefined;
  const request = (path: string, init: RequestInit, signal: AbortSignal) => fetcher(new URL(path, config.baseUrl), {
    ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]), redirect: "error",
    tls: { rejectUnauthorized: !config.skipTlsVerify },
  });
  const authenticate = async () => {
    if (cookie && Date.now() - authenticatedAt < 30 * 60_000) return;
    if (!login) {
      if (Date.now() < retryAfter) throw new PreviewAccessError("Protect recording access is unavailable");
      login = (async () => {
        try {
          const response = await request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username: config.username, password: config.password, rememberMe: false }) }, AbortSignal.timeout(10_000));
          await response.body?.cancel();
          if (!response.ok) throw new PreviewAccessError("Protect recording login failed");
          cookie = response.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
          csrf = response.headers.get("x-csrf-token") ?? "";
          if (!cookie) throw new PreviewAccessError("Protect recording login failed");
          authenticatedAt = Date.now();
        } catch {
          cookie = ""; retryAfter = Date.now() + 30_000;
          throw new PreviewAccessError("Protect recording access is unavailable");
        }
      })().finally(() => { login = undefined; });
    }
    return login;
  };
  return new DetectionPreviews(async (camera, time, signal) => {
    const id = Object.hasOwn(config.cameras, camera) ? config.cameras[camera] : undefined;
    if (!id) return;
    await authenticate(); signal.throwIfAborted();
    const response = await request(`/proxy/protect/api/cameras/${id}/recording-snapshot?ts=${time * 1000}&w=480`,
      { headers: { Cookie: cookie, ...(csrf ? { "X-CSRF-Token": csrf } : {}), Accept: "image/jpeg" } }, signal);
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel(); cookie = ""; retryAfter = Date.now() + 30_000;
      throw new PreviewAccessError("Protect recording access is unavailable");
    }
    if (response.status === 404) { await response.body?.cancel(); return; }
    if (!response.ok || !response.headers.get("content-type")?.startsWith("image/jpeg")) {
      await response.body?.cancel(); throw new Error("Protect preview unavailable");
    }
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length;
        if (size > 256 * 1024) throw new Error("Protect preview frame too large");
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    return Buffer.concat(chunks);
  });
}
