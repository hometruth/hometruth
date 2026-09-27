/**
 * Serving icon images.
 *
 * A node's icon is an emoji or a local image, and the image half was typed,
 * rendered and validated end to end from the start so that adopting real
 * artwork would be a data change rather than a code change. This is the half
 * that makes it true: drop a file in `.hometruth/icons/` and name it from a
 * device entry's `icon`, and it renders.
 *
 * Local only, and deliberately so. `PRODUCT.md` forbids external assets and the
 * CSP is nonce-only with no external origins, so an icon is a path under
 * `/icons/`, never a URL. `parseIcon` already refuses anything with a scheme;
 * this refuses anything that tries to climb out of the directory.
 */
import { Hono } from "hono";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { errorJson, type AppEnvironment } from "./http";

export const DEFAULT_ICON_DIRECTORY = ".hometruth/icons";

/** Only formats a browser renders inline, and SVG only after it has been sanitised. */
const TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
};

const MAX_BYTES = 512 * 1024;

/** One path segment, a known extension, and nothing that climbs out. */
export function safeIconName(name: string): string | undefined {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) return undefined;
  if (name.includes("..")) return undefined;
  const dot = name.lastIndexOf(".");
  const extension = dot < 0 ? "" : name.slice(dot).toLowerCase();
  return TYPES[extension] ? name : undefined;
}

export function iconRoutes(directory = DEFAULT_ICON_DIRECTORY) {
  const app = new Hono<AppEnvironment>();
  const root = resolve(directory);

  app.get("/icons/:name", async (context) => {
    const name = safeIconName(context.req.param("name"));
    if (!name) return errorJson(context, 404, "not_found", "No such icon");
    const path = join(root, name);
    // Belt and braces: the name pattern already forbids a separator, but the
    // resolved path is checked against the root regardless.
    if (!resolve(path).startsWith(`${root}/`)) return errorJson(context, 404, "not_found", "No such icon");
    try {
      const details = await stat(path);
      if (!details.isFile() || details.size > MAX_BYTES) return errorJson(context, 404, "not_found", "No such icon");
    } catch {
      return errorJson(context, 404, "not_found", "No such icon");
    }
    const extension = name.slice(name.lastIndexOf(".")).toLowerCase();
    context.header("Content-Type", TYPES[extension]!);
    context.header("Cache-Control", "public, max-age=86400");
    return context.body(await Bun.file(path).arrayBuffer());
  });

  return app;
}
