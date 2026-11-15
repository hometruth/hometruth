import { afterEach, expect, test } from "bun:test";
import { createApp } from "./app";
import { Site } from "../site";
import { TagStore } from "../tags/store";
import { StateHub } from "../state/hub";
import { elementKey } from "../tags/identity";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()));
function fixture() {
  const tags = new TagStore(), hub = new StateHub();
  const app = createApp(undefined, new Site([]), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, tags, hub);
  cleanups.push(() => { hub.stop(); tags.close(); });
  const room = tags.create({ name: "room", value: "Reading Room", color: "#224488", description: "Upstairs" });
  const ordinary = tags.create({ value: "reading", color: "#224488", description: "" });
  const category = tags.create({ name: "category", value: "lighting", color: "#224488", description: "" });
  tags.attach(elementKey("catalog", "switches"), { tagId: room.id });
  tags.attach(elementKey("catalog", "switches"), { tagId: ordinary.id });
  return { app, room, ordinary, category };
}
const seed = (html: string) => JSON.parse(html.match(/data-tag-data>(.*?)<\/script>/s)![1]!);
const rows = (html: string) => html.match(/<ul class="rows" data-tag-rows[^>]*>(.*?)<\/ul>/s)![1]!;

test("Tags excludes rooms from server results, counts, search data and element chips", async () => {
  const { app, ordinary, category } = fixture();
  const html = await (await app.request("/tags")).text();
  expect(seed(html).tags.map((tag: { id: string }) => tag.id).sort()).toEqual([ordinary.id, category.id].sort());
  expect(rows(html)).toContain("category = lighting");
  expect(rows(html)).not.toContain("Reading Room");
  expect(html).toContain('data-tag-count>2 tags</p>');
  const elements = await (await app.request("/tags?view=elements")).text();
  expect(rows(elements)).not.toContain("room =");
  expect(seed(elements).tags.every((tag: { name: string }) => tag.name !== "room")).toBe(true);
  expect((await (await app.request("/api/tags")).json()).tags).toHaveLength(3);
});

test("Rooms has its own navigation, creation form, search data and assigned elements", async () => {
  const { app, room } = fixture();
  const html = await (await app.request("/rooms")).text();
  expect(html).toContain('<h1>Rooms</h1>');
  expect(html).toContain('href="/rooms" aria-current="page">Rooms</a>');
  expect(html).toContain('data-tag-count>1 room</p>');
  expect(html).toContain('type="hidden" name="name" value="room"');
  expect(html).toContain('Create room');
  expect(html).toContain('Find rooms');
  expect(seed(html).tags.map((tag: { id: string }) => tag.id)).toEqual([room.id]);
  expect(rows(html)).toContain('href="/rooms/reading-room"');
  expect(rows(html)).not.toContain('room =');
  const detail = await (await app.request("/rooms/reading-room")).text();
  expect(detail).toContain('<h1>Reading Room</h1>');
  expect(detail).toContain('Elements in this room');
  expect(detail).toContain('Save room');
  expect(rows(detail)).toContain('Switches');
  expect(rows(detail)).not.toContain('room =');
  for (const path of ["/rooms/openapi.json", "/rooms/reading-room/openapi.json"]) expect((await app.request(path)).status).toBe(200);
  for (const path of ["/tags/room", "/tags/room/reading-room", "/rooms/missing", "/rooms/Reading%20Room", "/rooms/Reading-Room"]) expect((await app.request(path)).status).toBe(404);
});
