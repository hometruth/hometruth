/**
 * Moving rooms into the ontology, once.
 *
 * A room used to exist only as the distinct `room:` strings scraped off devices
 * and groups. That is why a room could not be renamed: its identity *was* its
 * name, so renaming one orphaned every tag attached to the old element key.
 * After this runs, a room is the tag `room = <name>` with a UUID, and renaming
 * is an ordinary tag edit.
 *
 * The `room:` lines stay in `devices.yml`. They are no longer read as the
 * source of truth, but deleting someone's configuration as part of a migration
 * is not a thing to do to them — and while they are there, this function can
 * reconstruct every room from scratch if the database is ever lost. That is the
 * safety net, and the reason leaving them is deliberate rather than untidy.
 */
import { elementKey } from "./identity";
import { DEFAULT_TAG_COLOR, ROOM } from "./model";
import type { TagStore } from "./store";

/** Recorded in the database so the migration runs exactly once. */
export const ROOM_MIGRATION = "rooms-to-tags@1";

export interface RoomSource {
  /** Every room configuration declares, including ones nothing is in yet. */
  readonly configuredRooms: readonly string[];
  readonly devices: readonly { readonly id: string; readonly room?: string | undefined }[];
  readonly groups: readonly { readonly id: string; readonly room?: string | undefined }[];
}

export interface RoomMigrationResult {
  /** False when it had already run, in which case nothing was written. */
  readonly ran: boolean;
  readonly rooms: number;
  readonly assignments: number;
}

/**
 * Create a tag per room and attach it to whatever was in it. Idempotent in two
 * senses: it is recorded so it will not run twice, and re-running it by hand
 * would converge anyway, because creating a tag that exists is a no-op and
 * `room` is single-valued so attaching cannot duplicate.
 */
export function migrateRoomsToTags(store: TagStore, source: RoomSource, force = false): RoomMigrationResult {
  if (!force && store.migrated(ROOM_MIGRATION)) return { ran: false, rooms: 0, assignments: 0 };

  const named = [
    ...source.devices.map(device => ({ key: elementKey("device", device.id), room: device.room })),
    ...source.groups.map(group => ({ key: elementKey("group", group.id), room: group.room })),
  ].filter((entry): entry is { key: string; room: string } => Boolean(entry.room));

  const rooms = [...new Set([...source.configuredRooms, ...named.map(entry => entry.room)])];

  return store.transaction(() => {
    for (const room of rooms) {
      if (!store.byPair(room, ROOM)) store.create({ name: ROOM, value: room, color: DEFAULT_TAG_COLOR, description: "" });
    }
    for (const entry of named) store.attach(entry.key, { name: ROOM, value: entry.room });
    store.markMigrated(ROOM_MIGRATION);
    return { ran: true, rooms: rooms.length, assignments: named.length };
  });
}
