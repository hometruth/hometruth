import type { Hono } from "hono";
import type { AppEnvironment } from "./http";
import { elementKey, type ElementKind } from "../tags/identity";

/** Route fixtures discover the current public target while keeping stored fixture IDs intact. */
export async function elementAddress(app: Hono<AppEnvironment>, kind: ElementKind, ...ids: string[]): Promise<string> {
  const response = await app.request("/api/inventory");
  const inventory = await response.json() as { elements: { key: string; address: string }[] };
  const key = elementKey(kind, ...ids);
  const entry = inventory.elements.find(element => element.key === key);
  if (!entry) throw new Error(`Fixture element was not published: ${kind} ${ids.join("/")}`);
  return encodeURIComponent(entry.address);
}

export async function groupPath(app: Hono<AppEnvironment>, id: string): Promise<string> {
  return `/api/device-groups/${await elementAddress(app, "group", id)}`;
}
