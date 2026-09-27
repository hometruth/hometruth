/** Listener settings are explicit; loopback must never silently become a LAN bind. */
export function listenerConfig(env: Record<string, string | undefined>) {
  const hostname = env.HOST ?? "127.0.0.1";
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be an integer from 0 to 65535");
  return { hostname, port, publicOrigin: parsePublicOrigin(env.HOMETRUTH_PUBLIC_ORIGIN) };
}

/** A configured origin, never client-supplied forwarding headers, defines HTTPS. */
export function parsePublicOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash || value.trim() !== value) throw new Error();
    return url.origin;
  } catch {
    throw new Error("HOMETRUTH_PUBLIC_ORIGIN must be an HTTP(S) origin without credentials, path, query or fragment");
  }
}

export function publicRequestUrl(requestUrl: string, publicOrigin: string | undefined): string {
  if (!publicOrigin) return requestUrl;
  const request = new URL(requestUrl);
  const result = new URL(publicOrigin);
  result.pathname = request.pathname;
  result.search = request.search;
  return result.href;
}
