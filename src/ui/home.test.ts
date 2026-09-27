import { describe, expect, test } from "bun:test";
import type { RegisteredDevice } from "../site";
import { speakerSchema } from "../schemas";
import { groupPagePath, groupRowDevice, groupSlug, partitionDevicesIntoGroups, renderHomePage } from "./home";
import { testPageContext } from "./test-context";

function speaker(id: string, name: string, groupLabel?: string): RegisteredDevice {
  return {
    id,
    name,
    kind: "speaker",
    model: "sonos",
    modelTitle: "Sonos speaker",
    capabilities: ["speaker"],
    host: "10.77.0.170",
    page: `/devices/${id}`,
    schemaId: speakerSchema.$id,
    enabled: true,
    ...(groupLabel ? { groupLabel } : {}),
  };
}

function speakerGroupDevice(id: string, name: string, groupLabel: string): RegisteredDevice {
  return {
    id,
    name,
    kind: "speaker-group",
    model: "sonos-group",
    modelTitle: "Sonos group",
    capabilities: ["speaker"],
    host: "10.77.0.142",
    page: `/devices/${id}`,
    schemaId: speakerSchema.$id,
    enabled: true,
    groupLabel,
  };
}

describe("groupSlug", () => {
  test("lowercases, strips punctuation, and hyphenates", () => {
    expect(groupSlug("Living Room (Arc Ultra)")).toBe("living-room-arc-ultra");
    expect(groupSlug("  Kitchen!!  ")).toBe("kitchen");
  });

  test("falls back to a stable placeholder for an all-punctuation label", () => {
    expect(groupSlug("***")).toBe("group");
  });
});

describe("groupPagePath", () => {
  test("encodes the slug into /groups/:slug", () => {
    expect(groupPagePath("Living Room (Arc Ultra)")).toBe("/groups/living-room-arc-ultra");
  });
});

describe("partitionDevicesIntoGroups", () => {
  test("devices with no groupLabel stay standalone", () => {
    const kitchen = speaker("sonos-kitchen", "Kitchen Sonos");
    const { standalone, groups } = partitionDevicesIntoGroups([kitchen]);
    expect(standalone).toEqual([kitchen]);
    expect(groups).toEqual([]);
  });

  test("devices sharing a groupLabel collapse into one group, in first-seen order", () => {
    const left = speaker("sonos-left", "Left", "Living Room");
    const right = speaker("sonos-right", "Right", "Living Room");
    const kitchen = speaker("sonos-kitchen", "Kitchen");
    const { standalone, groups } = partitionDevicesIntoGroups([left, kitchen, right]);

    expect(standalone).toEqual([kitchen]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ label: "Living Room", slug: "living-room" });
    expect(groups[0]!.members).toEqual([left, right]);
  });

  test("labels that differ only in case/punctuation collapse to the same group", () => {
    const a = speaker("sonos-a", "A", "Living Room!");
    const b = speaker("sonos-b", "B", "living room");
    const { groups } = partitionDevicesIntoGroups([a, b]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.members.map((m) => m.id)).toEqual(["sonos-a", "sonos-b"]);
  });

  test("multiple distinct groups preserve first-seen order", () => {
    const kitchenA = speaker("k-a", "Kitchen A", "Kitchen");
    const livingA = speaker("l-a", "Living A", "Living Room");
    const kitchenB = speaker("k-b", "Kitchen B", "Kitchen");
    const { groups } = partitionDevicesIntoGroups([kitchenA, livingA, kitchenB]);

    expect(groups.map((g) => g.label)).toEqual(["Kitchen", "Living Room"]);
    expect(groups[0]!.members.map((m) => m.id)).toEqual(["k-a", "k-b"]);
  });
});

describe("groupRowDevice", () => {
  test("a group's row reads its control device when one is configured, else its first member", () => {
    const left = speaker("sonos-left", "Left", "Living Room");
    const right = speaker("sonos-right", "Right", "Living Room");
    const control = speakerGroupDevice("sonos-living", "Living Room", "Living Room");
    expect(groupRowDevice(partitionDevicesIntoGroups([left, right]).groups[0]!)).toBe(left);
    expect(groupRowDevice(partitionDevicesIntoGroups([left, control, right]).groups[0]!)).toBe(control);
    expect(groupRowDevice({ label: "Empty", slug: "empty", members: [] })).toBeUndefined();
  });
});

describe("renderHomePage grouping", () => {
  test("renders one card per group, linking to its group page, and one per standalone device", () => {
    const left = speaker("sonos-left", "Left", "Living Room");
    const right = speaker("sonos-right", "Right", "Living Room");
    const kitchen = speaker("sonos-kitchen", "Kitchen");
    const html = renderHomePage({ ctx: testPageContext(), devices:[left, kitchen, right] });

    expect(html).toContain('href="/groups/living-room"');
    expect(html).toContain(">Living Room<");
    expect(html).toContain('href="/devices/sonos-kitchen"');
    expect(html).not.toContain('href="/devices/sonos-left"');
    expect(html).not.toContain('href="/devices/sonos-right"');
    expect(html).toContain('<ht-status node="device/sonos-left">');
    expect(html).not.toContain('node="device/sonos-right"');
    expect(html).toContain('<ht-status node="device/sonos-kitchen">');
    expect(html).not.toContain("data-rescan");
  });

  test("a group with a control device shows that device's status on its row", () => {
    const left = speaker("sonos-left", "Left", "Living Room");
    const control = speakerGroupDevice("sonos-living", "Living Room", "Living Room");
    const html = renderHomePage({ ctx: testPageContext(), devices: [left, control] });
    expect(html).toContain('<ht-status node="device/sonos-living">');
    expect(html).not.toContain('node="device/sonos-left"');
  });

  test("offers a network rescan only when the server can look devices up and rewrite their addresses", () => {
    const html = renderHomePage({ ctx: testPageContext(), devices: [speaker("sonos-kitchen", "Kitchen")], canRescan: true });
    expect(html).toContain('<button type="button" class="btn" data-rescan>Rescan network</button>');
    expect(html).toContain('data-rescan-results');
    expect(html).toContain('"rescan.moved"');
    expect(renderHomePage({ ctx: testPageContext(), devices: [], canRescan: true })).not.toContain("data-rescan");
  });
});
