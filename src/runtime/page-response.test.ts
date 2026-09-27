import { expect, test } from "bun:test";
import { uncachedPage } from "./page-response";

test("HTML cannot be cached or revalidated against a previous worker generation", async () => {
  const response = uncachedPage(new Response("<h1>Current page</h1>", { status: 200, headers: {
    "content-type": "text/html; charset=UTF-8", "cache-control": "max-age=600", etag: '"old-generation"',
    "last-modified": "Sat, 12 Sep 2026 10:00:00 GMT", "content-security-policy": "script-src 'nonce-current'", "set-cookie": "theme=swiss",
  } }));
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.has("etag")).toBe(false);
  expect(response.headers.has("last-modified")).toBe(false);
  expect(response.headers.get("content-security-policy")).toBe("script-src 'nonce-current'");
  expect(response.headers.get("set-cookie")).toBe("theme=swiss");
  expect(await response.text()).toBe("<h1>Current page</h1>");
});

test("API, event stream, and media response policies are preserved", () => {
  for (const contentType of ["application/json", "text/event-stream", "image/jpeg", "video/mp4"]) {
    const response = new Response("body", { headers: { "content-type": contentType, "cache-control": "private, max-age=60" } });
    expect(uncachedPage(response)).toBe(response);
  }
});
