/**
 * The ontology end to end, through the app: a room migrates out of YAML, gets a
 * friendly URL, can be renamed without losing what is in it, and cannot itself
 * be tagged.
 */
import { describe, expect, test } from "bun:test";
import { createApp } from "./app";
import { Site } from "../site";
import { TagStore } from "../tags/store";
import { elementKey } from "../tags/identity";
import { ROOM, tagPage } from "../tags/model";
import { tagNode } from "../graph/tag-graph";

const CONFIG = {
  schemaVersion: 2 as const,
  rooms: ["Master Bathroom", "Kitchen"],
  devices: [
    { id: "vanity", name: "Vanity lights", room: "Master Bathroom", model: "shelly-plus-1", config: { host: "127.0.0.1" } },
    { id: "fan", name: "Exhaust fan", room: "Master Bathroom", model: "shelly-plus-1", config: { host: "127.0.0.2" } },
    { id: "hob", name: "Hob", room: "Kitchen", model: "shelly-plus-1", config: { host: "127.0.0.3" } },
  ],
};

function fixture() {
  const tags = new TagStore();
  const site = Site.fromConfig(CONFIG);
  return { app: createApp(undefined, site, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, tags), tags, site };
}

const json = async (response: Response) => await response.json() as Record<string, unknown>;

describe("rooms are tags", () => {
  test("startup migrates every room out of the YAML, keeping what is in each", () => {
    const { tags } = fixture();
    expect(tags.rooms()).toEqual(["Kitchen", "Master Bathroom"]);
    expect(tags.roomOf(elementKey("device", "vanity"))).toBe("Master Bathroom");
    expect(tags.roomOf(elementKey("device", "hob"))).toBe("Kitchen");

    const bathroom = tags.byPair("Master Bathroom", ROOM)!;
    expect(tags.elementsWith(bathroom.id).sort())
      .toEqual([elementKey("device", "fan"), elementKey("device", "vanity")].sort());
  });

  test("a room has a friendly URL, and the old base64 element key redirects to it", async () => {
    const { app, tags } = fixture();
    const bathroom = tags.byPair("Master Bathroom", ROOM)!;
    expect(tagPage(bathroom)).toBe("/tags/room/master-bathroom");
    expect((await app.request("/tags/room/master-bathroom")).status).toBe(200);

    // The URL that started all this. It still resolves, and lands on the slug.
    const legacy = await app.request(`/elements/${elementKey("room", "Master Bathroom")}`);
    expect(legacy.status).toBe(301);
    expect(legacy.headers.get("location")).toBe("/tags/room/master-bathroom");
  });

  test("renaming a room keeps every device in it, and changes the URL", async () => {
    const { app, tags } = fixture();
    const before = tags.byPair("Master Bathroom", ROOM)!;
    const renamed = await app.request(`/api/tags/${before.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: ROOM, value: "Main Bathroom", color: before.color, description: "", revision: before.revision }),
    });
    expect(renamed.status).toBe(200);
    expect(await json(renamed)).toMatchObject({ page: "/tags/room/main-bathroom" });

    // The UUID never moved, so nothing was detached by the rename.
    expect(tags.get(before.id)!.value).toBe("Main Bathroom");
    expect(tags.roomOf(elementKey("device", "vanity"))).toBe("Main Bathroom");
    expect(tags.elementsWith(before.id)).toHaveLength(2);
    expect((await app.request("/tags/room/main-bathroom")).status).toBe(200);

    // Everything that shows a room shows the new one straight away: the room
    // is read from the ontology, not from the `room:` still in the YAML.
    expect(await json(await app.request("/api/rooms"))).toMatchObject({ rooms: ["Kitchen", "Main Bathroom"] });
    expect(await json(await app.request("/api/devices/vanity"))).toMatchObject({ room: "Main Bathroom" });
  });

  test("a device moves rooms rather than accumulating them", async () => {
    const { app, tags } = fixture();
    const moved = await app.request("/api/devices/vanity/room", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ room: "Kitchen" }),
    });
    expect(moved.status).toBe(200);
    expect(tags.roomOf(elementKey("device", "vanity"))).toBe("Kitchen");
    expect(tags.tagsFor(elementKey("device", "vanity")).filter(tag => tag.name === ROOM)).toHaveLength(1);
  });

  test("a tag is not an element: it is not listed, and it cannot be tagged", async () => {
    const { app, tags } = fixture();
    const bathroom = tags.byPair("Master Bathroom", ROOM)!;

    const elements = await json(await app.request("/api/elements?limit=200"));
    const keys = (elements.elements as { key: string }[]).map(element => element.key);
    expect(keys).not.toContain(tagNode(bathroom));
    expect(keys).not.toContain(elementKey("room", "Master Bathroom"));

    // Not on any page of the list, and not offered as a type to filter by:
    // a `side !== "instance"` test would quietly file tags under the schema
    // side, where they would be listed and tagged like anything else.
    expect(elements.kinds).not.toContain("tag");
    expect(elements.kinds).not.toContain("tag-name");
    for (const kind of ["tag", "tag-name"]) {
      expect(await json(await app.request(`/api/elements?kind=${kind}&limit=50`))).toMatchObject({ total: 0 });
    }
    expect((await app.request(`/api/elements/${tagNode(bathroom)}`)).status).toBe(404);

    // The page for a tag offers no editor, and the API refuses the attach.
    const page = await (await app.request(`/elements/${tagNode(bathroom)}`)).text();
    expect(page).not.toContain("data-tag-editor");
    const attach = await app.request(`/api/elements/${tagNode(bathroom)}/tags`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "nope" }),
    });
    // Refused, whether because the element is not one (404) or the key is not
    // taggable (400). What matters is that no tag was attached to a tag.
    expect(attach.status).toBeGreaterThanOrEqual(400);
    expect(tags.tagsFor(tagNode(bathroom))).toHaveLength(0);
  });

  test("the ontology exports as YAML and restores into an empty database", async () => {
    const { app } = fixture();
    const exported = await (await app.request("/api/tags/export")).text();
    expect(exported).toContain("Master Bathroom");

    const restored = new TagStore();
    const { app: other } = { app: createApp(undefined, Site.fromConfig({ schemaVersion: 2 as const, devices: [] }), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, restored) };
    const result = await other.request("/api/tags/import", { method: "POST", headers: { "content-type": "text/yaml" }, body: exported });
    expect(result.status).toBe(200);
    expect(restored.rooms()).toEqual(["Kitchen", "Master Bathroom"]);
    expect(restored.roomOf(elementKey("device", "vanity"))).toBe("Master Bathroom");
    restored.close();
  });
});
