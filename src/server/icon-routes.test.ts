import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { iconRoutes, safeIconName } from "./icon-routes";

// A one-pixel PNG, so the served bytes are a real image.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function serve() {
  const directory = await mkdtemp(join(tmpdir(), "hometruth-icons-"));
  await writeFile(join(directory, "relay.png"), PNG);
  const app = new Hono();
  app.route("/", iconRoutes(directory));
  return { app, directory };
}

describe("icon names", () => {
  test("accepts a plain file with a renderable extension", () => {
    expect(safeIconName("relay.png")).toBe("relay.png");
    expect(safeIconName("a-b_c.webp")).toBe("a-b_c.webp");
  });

  test("refuses anything that climbs out, hides, or is not an image", () => {
    for (const name of ["../secrets.yml", "..%2Fsecrets", "a/b.png", "/etc/passwd", ".hidden.png", "relay.svg", "relay.txt", "relay"]) {
      expect(safeIconName(name), name).toBeUndefined();
    }
  });
});

describe("icon route", () => {
  test("serves a stored image with its type and a cache header", async () => {
    const { app } = await serve();
    const response = await app.request("/icons/relay.png");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toContain("max-age");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(PNG));
  });

  test("a missing icon is a 404, and so is an attempt to read outside the directory", async () => {
    const { app } = await serve();
    expect((await app.request("/icons/nope.png")).status).toBe(404);
    expect((await app.request("/icons/..%2F..%2Fpackage.json")).status).toBe(404);
  });
});
