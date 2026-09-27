/** HTML embeds its worker generation and must never outlive that generation in a browser cache. */
export function uncachedPage(response: Response): Response {
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/html")) return response;
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.delete("etag");
  headers.delete("last-modified");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
