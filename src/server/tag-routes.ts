import { pageCatalog } from "./page-catalog";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { Hono } from "hono";
import { ROOM, tagAssignmentSchema, tagCreateSchema, tagUpdateSchema, tagPage, type TagFields } from "../tags/model";
import { parseElementKey } from "../tags/identity";
import type { TagStore } from "../tags/store";
import { type Element } from "../tags/elements";
import type { StateHub } from "../state/hub";
import { parseViewState, renderGraphPage } from "../ui/graph-page";
import type { Site } from "../site";
import { renderElementTagsPage, renderTagNamePage, renderTagsPage } from "../ui/tags-page";
import { exportTagsYaml, importTags } from "../tags/export";
import { errorJson, pageContext, requestJson, type AppEnvironment } from "./http";

const ajv = new Ajv2020({ strict: true, allErrors: true }); addFormats(ajv);
const createValid = ajv.compile<TagFields>(tagCreateSchema);
const updateValid = ajv.compile<TagFields & { revision: number }>(tagUpdateSchema);
const assignmentValid = ajv.compile<{ tagId?: string; slug?: string }>(tagAssignmentSchema);

export function tagRoutes(site: Site, store: TagStore, hub: StateHub) {
  const app = new Hono<AppEnvironment>();
  /**
   * A room used to be an element with a base64 key. It is a tag now, so that
   * key is an alias: every bookmark and every stored link still resolves, and
   * lands on the friendly URL.
   */
  const tagPageFor = (key: string): string | undefined => {
    const parsed = parseElementKey(key);
    if (parsed?.kind === "room" && parsed.ids[0]) {
      const tag = store.byPair(parsed.ids[0], ROOM);
      if (tag) return tagPage(tag);
    }
    if (parsed?.kind === "tag" && parsed.ids[1] !== undefined) {
      const tag = store.byPair(parsed.ids[1], parsed.ids[0] ?? "");
      if (tag) return tagPage(tag);
    }
    return undefined;
  };
  const all = () => pageCatalog(hub).elements;
  const find = (key: string) => pageCatalog(hub).byKey.get(key);
  /**
   * The graph is memoised per site generation, and a tag edit does not change
   * the site. Without this a rename would keep serving the old name for the
   * cache's lifetime, which is exactly the stale swap the UI must never show.
   */
  const changed = <T>(result: T): T => { hub.data.invalidate(); return result; };

  /** Every tag carries its own page, so no caller has to rebuild the URL. */
  const withPages = () => store.list().map(tag => ({ ...tag, page: tagPage(tag) }));
  const withTags = (elements: Element[]) => {
    const assignments = store.assignments();
    return elements.map(element => ({ ...element, tagIds: assignments.get(element.key) ?? [] }));
  };
  const pageData = () => pageCatalog(hub);
  app.get("/tags", c => c.html(renderTagsPage(pageContext(c), c.req.query("view") === "elements" ? "elements" : "tags", undefined, pageData())));
  app.get("/tags/:slug", c => {
    const slug = c.req.param("slug");
    // A bare name with no value is the name's own index: every room, for `room`.
    const named = store.nameOf(slug);
    const tag = store.bySlug(slug);
    if (!tag && named) return c.html(renderTagNamePage(pageContext(c), named, store.listNamed(named.name).map(entry => ({ ...entry, page: tagPage(entry) }))));
    return tag ? c.html(renderTagsPage(pageContext(c), "elements", tag, pageData())) : errorJson(c, 404, "not_found", "Tag not found");
  });
  app.get("/tags/:name/:slug", c => {
    const tag = store.bySlug(c.req.param("slug"), c.req.param("name"));
    return tag ? c.html(renderTagsPage(pageContext(c), "elements", tag, pageData())) : errorJson(c, 404, "not_found", "Tag not found");
  });
  // Every element has a graph, not only the ones with a device page.
  app.get("/elements/:key/graph", async c => {
    const key = c.req.param("key");
    const graph = hub.data.topology();
    const url = new URL(c.req.url);
    const page = renderGraphPage({
      ctx: pageContext(c), graph, focus: key, nav: "tags",
      state: parseViewState(url.searchParams), base: url.pathname,
    });
    return page ? c.html(page) : errorJson(c, 404, "not_found", "Element not found");
  });
  app.get("/elements/:key", async c => {
    const redirect = tagPageFor(c.req.param("key"));
    if (redirect) return c.redirect(redirect, 301);
    const element = find(c.req.param("key"));
    return element ? c.html(renderElementTagsPage(pageContext(c), element)) : errorJson(c, 404, "not_found", "Element not found");
  });
  app.get("/api/tags", c => {
    const counts: Record<string, number> = {};
    for (const ids of store.assignments().values()) for (const id of ids) counts[id] = (counts[id] ?? 0) + 1;
    return c.json({ tags: withPages(), names: store.names(), counts });
  });
  app.post("/api/tags", async c => {
    const input = await requestJson(c);
    if (!createValid(input)) return errorJson(c, 400, "invalid_request", "Enter a tag containing only letters (A–Z, a–z), numbers (0–9), and dashes, a six-digit hex color, and a description");
    const tag = changed(store.create(input)); return c.json({ tag, page: tagPage(tag) }, 201);
  });
  // The ontology as a file: `.hometruth/` is git-ignored and nothing backs it
  // up, so this is how a person keeps a readable, diffable copy of every room
  // and every assignment.
  app.get("/api/tags/export", c => {
    c.header("Content-Type", "text/yaml; charset=utf-8");
    c.header("Content-Disposition", 'attachment; filename="hometruth-tags.yaml"');
    return c.body(exportTagsYaml(store));
  });
  app.post("/api/tags/import", async c => {
    const text = await c.req.text();
    let document: unknown;
    try { document = Bun.YAML.parse(text); }
    catch { return errorJson(c, 400, "invalid_request", "Send the YAML from a tag export"); }
    const result = changed(importTags(store, document));
    return c.json(result);
  });

  app.get("/api/tags/:id", c => {
    const tag = store.get(c.req.param("id"));
    return tag ? c.json({ tag, page: tagPage(tag) }) : errorJson(c, 404, "not_found", "Tag not found");
  });
  app.patch("/api/tags/:id", async c => {
    const input = await requestJson(c);
    if (!updateValid(input)) return errorJson(c, 400, "invalid_request", "Enter a tag containing only letters (A–Z, a–z), numbers (0–9), and dashes, valid details, and the current revision");
    const tag = changed(store.update(c.req.param("id"), { name: input.name ?? "", value: input.value, color: input.color, description: input.description }, input.revision));
    return c.json({ tag, page: tagPage(tag) });
  });
  app.get("/api/elements", async c => {
    let elements = withTags(all());
    const kinds = [...new Set(elements.map(element => element.kind))].sort();
    const path = c.req.query("path");
    if (path) {
      const match = site.pages().resolve(path);
      const base = match?.entry.page ?? path;
      // A page can expose its own element and every nested primitive, including its individual sensors and scenes.
      elements = elements.filter(element => element.sourcePage === base || element.sourcePage === path);
    }
    const query = c.req.query("q")?.toLocaleLowerCase() ?? "";
    if (query) elements = elements.filter(element => `${element.name} ${element.context} ${element.kind}`.toLocaleLowerCase().includes(query));
    if (c.req.query("kind")) elements = elements.filter(element => element.kind === c.req.query("kind"));
    if (c.req.query("tagId")) elements = elements.filter(element => element.tagIds.includes(c.req.query("tagId")!));
    const limit = path ? elements.length : Math.min(200, Math.max(1, Number(c.req.query("limit")) || 100));
    const offset = Math.max(0, Number(c.req.query("offset")) || 0);
    return c.json({ elements: elements.slice(offset, offset + limit), total: elements.length, kinds, tags: withPages() });
  });
  app.get("/api/elements/:key", async c => {
    const element = find(c.req.param("key"));
    return element ? c.json({ element: withTags([element])[0] }) : errorJson(c, 404, "not_found", "Element not found");
  });
  app.get("/api/elements/:key/tags", async c => {
    const element = find(c.req.param("key"));
    return element ? c.json({ element, tags: store.tagsFor(element.key) }) : errorJson(c, 404, "not_found", "Element not found");
  });
  app.post("/api/elements/:key/tags", async c => {
    const element = find(c.req.param("key"));
    if (!element) return errorJson(c, 404, "not_found", "Element not found; tags cannot be tagged");
    const input = await requestJson(c);
    if (!assignmentValid(input)) return errorJson(c, 400, "invalid_request", "Choose a tag UUID or enter a tag containing only letters (A–Z, a–z), numbers (0–9), and dashes");
    return c.json({ element, tags: changed(store.attach(element.key, input)).map(tag => ({ ...tag, page: tagPage(tag) })) });
  });
  app.delete("/api/elements/:key/tags/:id", async c => {
    const element = find(c.req.param("key"));
    return element ? c.json({ element, tags: changed(store.detach(element.key, c.req.param("id"))).map(tag => ({ ...tag, page: tagPage(tag) })) }) : errorJson(c, 404, "not_found", "Element not found");
  });
  return app;
}
