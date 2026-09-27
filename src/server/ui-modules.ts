import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { Hono } from "hono";
import { assetVersion, type AppEnvironment } from "./http";

/** The folders under src/ui whose .ts files the browser may load as modules; everything else is server code. */
export const MODULE_ROOTS = ["browser", "themes"] as const;


export interface UiModuleOptions {
  /** Where the allowlisted folders live; defaults to src/ui. */
  readonly root?: string;
  /** The version that earns immutable caching; anything else is served current source with no-store. */
  readonly version?: () => string;
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/** A relative path is allowed when it is <root>/…/<name>.ts with plain segments and no "..". */
export function isAllowedModulePath(relative: string): boolean {
  const segments = relative.split("/");
  const [first] = segments;
  if (segments.length < 2 || !first || !(MODULE_ROOTS as readonly string[]).includes(first)) return false;
  if (!relative.endsWith(".ts")) return false;
  return segments.every(segment => segment !== ".." && SEGMENT.test(segment));
}

/** Strips types once per path; sources cannot change inside one worker generation, so the result lives as long as the process. */
export function createModuleTranspiler(): (relative: string, source: string) => string {
  const transpiler = new Bun.Transpiler({ loader: "ts", target: "browser", trimUnusedImports: true });
  const cache = new Map<string, string>();
  return (relative, source) => {
    const cached = cache.get(relative);
    if (cached !== undefined) return cached;
    const code = transpiler.transformSync(source);
    cache.set(relative, code);
    return code;
  };
}

function transpileMessage(error: unknown): string {
  const errors = (error as { errors?: unknown } | null)?.errors;
  if (Array.isArray(errors) && errors.length > 0) return errors.map(entry => String((entry as { message?: unknown })?.message ?? entry)).join("; ");
  return error instanceof Error ? error.message : String(error);
}

/** GET /ui/:version/<browser|themes>/…/*.ts served type-stripped as an ES module. */
export function uiModuleRoutes(options: UiModuleOptions = {}): Hono<AppEnvironment> {
  const root = resolve(options.root ?? resolve(import.meta.dir, "../ui"));
  const version = options.version ?? assetVersion;
  const transpile = createModuleTranspiler();
  const app = new Hono<AppEnvironment>();
  app.get("/ui/:version/*", async c => {
    const notFound = () => c.text("Not found", 404);
    const match = /^\/ui\/[^/]+\/(.+)$/u.exec(c.req.path);
    const relative = match?.[1];
    if (!relative || !isAllowedModulePath(relative)) return notFound();
    const file = resolve(root, relative);
    let source: string;
    try {
      // realpath follows symlinks, so a link out of src/ui is refused like a ".." segment.
      const rootReal = realpathSync(root);
      if (!realpathSync(file).startsWith(rootReal + sep)) return notFound();
      source = await readFile(file, "utf8");
    } catch {
      return notFound();
    }
    let code: string;
    try {
      code = transpile(relative, source);
    } catch (error) {
      const detail = transpileMessage(error);
      console.error(JSON.stringify({ event: "ui_module_failed", path: relative, detail }));
      return c.text(`${relative}: ${detail}`, 500);
    }
    const current = c.req.param("version") === version();
    return c.body(code, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "x-content-type-options": "nosniff",
      "cache-control": current ? "public, max-age=31536000, immutable" : "no-store",
    });
  });
  return app;
}
