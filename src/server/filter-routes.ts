import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { FilterStore } from "../models/filter-store";
import { errorJson, requestJson, type AppEnvironment } from "./http";

export function filterRoutes(store: FilterStore) {
  const app = new Hono<AppEnvironment>();
  app.use("/api/filters/*", bodyLimit({ maxSize: 128 * 1024, onError: c => errorJson(c, 413, "invalid_filter", "Filter definition is too large") }));
  app.use("/api/filters", bodyLimit({ maxSize: 128 * 1024, onError: c => errorJson(c, 413, "invalid_filter", "Filter definition is too large") }));
  app.use("/api/filters*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  app.get("/api/filters", c => c.json({ filters: store.list() }));
  app.get("/api/filters/:id", c => c.json(store.get(c.req.param("id"))));
  app.post("/api/filters", async c => c.json(store.create(await requestJson(c)), 201));
  app.put("/api/filters/:id", async c => c.json(store.update(c.req.param("id"), await requestJson(c))));
  app.delete("/api/filters/:id", c => {
    store.delete(c.req.param("id"), Number(c.req.query("revision")));
    return c.json({ deleted: true });
  });
  return app;
}
