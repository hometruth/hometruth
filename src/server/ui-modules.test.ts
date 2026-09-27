import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { posix, resolve } from "node:path";
import { Hono } from "hono";
import type { AppEnvironment } from "./http";
import { assetVersion } from "./http";
import { isAllowedModulePath, MODULE_ROOTS, uiModuleRoutes } from "./ui-modules";

const SCRATCH = process.env.CLAUDE_SCRATCHPAD ?? tmpdir();
const REAL_UI = resolve(import.meta.dir, "../ui");
let root: string;
let outside: string;
let app: Hono<AppEnvironment>;

const files: Record<string, string> = {
  "browser/x.ts": `export const X = 1;\nexport type Only = { a: number };\n`,
  "browser/uses.ts": [
    `import type { Only } from "./x.ts";`,
    `import { X } from "./x.ts";`,
    `import { Only as Untagged } from "./x.ts";`,
    `export interface Shape { readonly n: number }`,
    `export function f(input: Only, other: Untagged): number { return X + input.a + other.a; }`,
    `export class K { constructor(private readonly z: number) {} }`,
    "",
  ].join("\n"),
  "browser/nested/deep.ts": `export const deep: string = "deep";\n`,
  "themes/euclid/index.ts": `import { deep } from "../../browser/nested/deep.ts";\nexport const theme: string = deep;\n`,
  "browser/broken.ts": `export const x: number = ;\n`,
  "browser/notes.txt": `not a module`,
  "server.ts": `export const secret: string = "server";\n`,
};

beforeAll(async () => {
  root = await mkdtemp(resolve(SCRATCH, "ui-modules-"));
  outside = await mkdtemp(resolve(SCRATCH, "ui-modules-outside-"));
  for (const [relative, source] of Object.entries(files)) {
    const file = resolve(root, relative);
    await mkdir(resolve(file, ".."), { recursive: true });
    await writeFile(file, source);
  }
  await writeFile(resolve(outside, "escape.ts"), `export const escaped: number = 1;\n`);
  await symlink(resolve(outside, "escape.ts"), resolve(root, "browser/link.ts"));
  app = new Hono<AppEnvironment>().route("/", uiModuleRoutes({ root, version: () => "gen-1:ready" }));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

const get = (path: string) => app.request(path);

describe("ui module routes", () => {
  test("serves a .ts file as JavaScript with types and type-only imports stripped", async () => {
    const response = await get("/ui/gen-1:ready/browser/uses.ts");
    expect(response.status).toBe(200);
    const code = await response.text();
    expect(code).not.toContain("import type");
    expect(code).not.toContain("interface Shape");
    expect(code).not.toContain(": number");
    expect(code).toContain("export function f(input, other)");
    expect(code).toContain("this.z = z");
  });

  test("preserves relative .ts import specifiers verbatim and drops a type-only import written without `type`", async () => {
    const code = await (await get("/ui/gen-1:ready/browser/uses.ts")).text();
    expect(code).toContain(`import { X } from "./x.ts";`);
    // `Only as Untagged` is used only as a type; trimUnusedImports removes the binding so the browser never asks for it.
    expect(code).not.toContain("Untagged");
    expect(code.match(/^import /gmu)?.length).toBe(1);
  });

  test("answers with the module content type, nosniff, and immutable caching for the current version", async () => {
    const response = await get("/ui/gen-1:ready/browser/x.ts");
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  test("serves current source with no-store for a stale version", async () => {
    const response = await get("/ui/gen-0:ready/browser/x.ts");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toContain("export const X = 1;");
  });

  test("serves nested browser files and theme entries", async () => {
    expect((await get("/ui/gen-1:ready/browser/nested/deep.ts")).status).toBe(200);
    const theme = await (await get("/ui/gen-1:ready/themes/euclid/index.ts")).text();
    expect(theme).toContain(`import { deep } from "../../browser/nested/deep.ts";`);
  });

  test("refuses traversal, folders outside the allowlist, non-.ts files, and symlinks that leave the root", async () => {
    for (const path of [
      "/ui/gen-1:ready/browser/../server.ts",
      "/ui/gen-1:ready/browser/%2e%2e/server.ts",
      "/ui/gen-1:ready/server.ts",
      "/ui/gen-1:ready/i18n/en.ts",
      "/ui/gen-1:ready/browser/notes.txt",
      "/ui/gen-1:ready/browser",
      "/ui/gen-1:ready/browser/",
      "/ui/gen-1:ready/browser/missing.ts",
      "/ui/gen-1:ready/browser/link.ts",
    ]) {
      const response = await get(path);
      expect(`${path} ${response.status}`).toBe(`${path} 404`);
      expect(response.headers.get("content-type")).toStartWith("text/plain");
      expect(await response.text()).toBe("Not found");
    }
  });

  test("a syntax error is a 500 naming the file, logged as ui_module_failed", async () => {
    const logged: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
    try {
      const response = await get("/ui/gen-1:ready/browser/broken.ts");
      expect(response.status).toBe(500);
      const body = await response.text();
      expect(body).toStartWith("browser/broken.ts: ");
      expect(body.length).toBeGreaterThan("browser/broken.ts: ".length);
    } finally {
      console.error = original;
    }
    const entry = logged.map(line => JSON.parse(line) as { event: string; path: string; detail: string }).find(line => line.event === "ui_module_failed");
    expect(entry?.path).toBe("browser/broken.ts");
    expect(entry?.detail.length).toBeGreaterThan(0);
  });

  test("the cache returns identical bytes on the second request", async () => {
    const first = await (await get("/ui/gen-1:ready/browser/x.ts")).text();
    await writeFile(resolve(root, "browser/x.ts"), `export const X = 2;\n`);
    const second = await (await get("/ui/gen-1:ready/browser/x.ts")).text();
    expect(second).toBe(first);
  });

  test("assetVersion follows HOMETRUTH_RELOAD_VERSION and falls back to dev", () => {
    const saved = process.env.HOMETRUTH_RELOAD_VERSION;
    try {
      delete process.env.HOMETRUTH_RELOAD_VERSION;
      expect(assetVersion()).toBe("dev");
      process.env.HOMETRUTH_RELOAD_VERSION = "7:ui";
      expect(assetVersion()).toBe("7:ui");
    } finally {
      if (saved === undefined) delete process.env.HOMETRUTH_RELOAD_VERSION; else process.env.HOMETRUTH_RELOAD_VERSION = saved;
    }
  });

  test("the allowlist is exactly browser/** and themes/** .ts files with plain segments", () => {
    expect([...MODULE_ROOTS]).toEqual(["browser", "themes"]);
    expect(isAllowedModulePath("browser/x.ts")).toBe(true);
    expect(isAllowedModulePath("themes/euclid/index.ts")).toBe(true);
    expect(isAllowedModulePath("browser/../x.ts")).toBe(false);
    expect(isAllowedModulePath("browser/.hidden.ts")).toBe(false);
    expect(isAllowedModulePath("browser")).toBe(false);
    expect(isAllowedModulePath("browser/x.js")).toBe(false);
    expect(isAllowedModulePath("shell.ts")).toBe(false);
  });
});

describe("real browser module graph", () => {
  const list = (pattern: string) => [...new Bun.Glob(pattern).scanSync({ cwd: REAL_UI })].sort();

  test("every theme entry bundles for the browser without an unresolved import or missing export", async () => {
    const entrypoints = list("themes/*/index.ts").map(relative => resolve(REAL_UI, relative));
    if (entrypoints.length === 0) {
      console.log("ui-modules: no src/ui/themes/*/index.ts yet; the bundle check passes trivially");
      return;
    }
    // No outdir means nothing is written; `throw: false` turns a missing export into logs instead of a rejection.
    const result = await Bun.build({ entrypoints, target: "browser", external: [], throw: false });
    expect(result.logs.map(String)).toEqual([]);
    expect(result.success).toBe(true);
  });

  test("every browser and theme module transpiles and imports only relative .ts modules", async () => {
    const modules = [...list("browser/**/*.ts"), ...list("themes/**/*.ts")].filter(relative => !relative.endsWith(".test.ts"));
    if (modules.length === 0) {
      console.log("ui-modules: no src/ui/browser or src/ui/themes modules yet; the import check passes trivially");
      return;
    }
    const routes = new Hono<AppEnvironment>().route("/", uiModuleRoutes({ version: () => "v" }));
    const scanner = new Bun.Transpiler({ loader: "js" });
    for (const relative of modules) {
      const response = await routes.request(`/ui/v/${relative}`);
      expect(`${relative} ${response.status}`).toBe(`${relative} 200`);
      const code = await response.text();
      for (const { path } of scanner.scanImports(code)) {
        expect(`${relative} imports ${path}`).toMatch(/ imports \.\.?\/.*\.ts$/u);
        // A relative import that climbs out of browser/ or themes/ resolves outside /ui/<version>/ and 404s in the browser.
        const target = posix.normalize(posix.join(posix.dirname(relative), path));
        expect(`${relative} imports ${target} ${isAllowedModulePath(target)}`).toBe(`${relative} imports ${target} true`);
      }
    }
  });
});
