import { homeTruthObjectSchema, sensorSchema, sensorDeviceSchema, binarySwitchSchema, type AutomaticGroupCriteria, type DeviceGroup, type DeviceGroupConfig } from "../schemas";
import { schemaCatalogEntries } from "../schema-catalog";
import type { Device, DeviceModel } from "./device";
import { elementKey } from "../tags/identity";

/**
 * What the site reads out of the tag store. Rooms live here too since the tag
 * ontology absorbed them: `roomOf` is the room tag on an element, and `rooms`
 * every value under the `room` name.
 */
export interface GroupTagSource {
  readonly revision: number;
  assignments(): ReadonlyMap<string, readonly string[]>;
  /** Every room, as the ontology knows them. */
  rooms?(): readonly string[];
  /** The room an element is in, or undefined when it is in none. */
  roomOf?(elementKey: string): string | undefined;
}

const capabilitySchemas = homeTruthObjectSchema.properties.capabilities.properties;
const titles = new Map<string, string>(schemaCatalogEntries.map(entry => [entry.schema.$id, entry.title]));

export interface GroupSchemaChoice { id: string; title: string; groupName?: string | undefined }

/** Match published contracts without probing hardware or depending on current availability. */
export function deviceSchemaIds(device: Device): Set<string> {
  return new Set([
    homeTruthObjectSchema.$id, device.model.objectSchemaId,
    ...Object.keys(device.capabilities).flatMap(kind => capabilitySchemas[kind as keyof typeof capabilitySchemas]?.$ref ?? []),
    ...device.sensors.map(sensor => sensor.schemaId),
    ...(device.sensors.length ? [sensorDeviceSchema.$id] : []),
    ...(device.sensors.length || ["sensor", "motionSensor", "occupancySensor", "contactSensor"].some(kind => kind in device.capabilities) ? [sensorSchema.$id] : []),
    // A light or string light has the same on/off/toggle power controls as a binary switch.
    ...(["light", "stringLight"].some(kind => kind in device.capabilities) ? [binarySwitchSchema.$id] : []),
  ]);
}

export function groupSchemaChoices(models: readonly DeviceModel[], devices: readonly Device[]): GroupSchemaChoice[] {
  const ids = new Set<string>([
    ...Object.values(capabilitySchemas).map(schema => schema.$ref),
    sensorSchema.$id, sensorDeviceSchema.$id,
    ...models.flatMap(model => [model.objectSchemaId, ...(model.sensors ?? []).map(sensor => sensor.schemaId)]),
    ...devices.flatMap(device => [...deviceSchemaIds(device)]),
  ]);
  return [...ids].map(id => ({ id, title: titles.get(id) ?? id.split("/").pop()!, groupName: builtIns.find(([, , kind]) => capabilitySchemas[kind].$ref === id)?.[1] })).sort((a, b) => a.title.localeCompare(b.title));
}

/** One device-to-device reference, as `Site.deviceReferences` reports them. */
export interface GroupReference { readonly from: string; readonly to: string; readonly relation: string }

/**
 * Which devices an automatic group covers.
 *
 * The pruning is what stops a command reaching the same hardware twice, and it
 * is now reachability over the recorded references rather than a list of model
 * ids. A device that fans a command out to members stands for them and is left
 * out; a device that is reached by another matched device is already covered by
 * it. That works for composites nobody has written yet, which the old list
 * could not.
 */
export function automaticGroupMembers(
  devices: readonly Device[],
  criteria: AutomaticGroupCriteria,
  assignments?: ReadonlyMap<string, readonly string[]>,
  references: readonly GroupReference[] = [],
): string[] {
  const matches = devices.filter(device => (!criteria.room || device.room === criteria.room)
    && (!criteria.schemaId || deviceSchemaIds(device).has(criteria.schemaId))
    && (!criteria.tagIds || criteria.tagIds.every(id => assignments?.get(elementKey("device", device.id))?.includes(id))));
  // A fan-out composite stands for its members, so it never joins a group itself:
  // a matching string controller already covers its bulbs.
  const fansOut = new Set(references.filter(reference => reference.relation === "members").map(reference => reference.from));
  const candidates = matches.filter(device => !fansOut.has(device.id));
  const ids = new Set(candidates.map(device => device.id));
  return candidates.filter(device => {
    if (device.parent && ids.has(device.parent.id)) return false;
    // Something this device drives is already in the group; it would be commanded twice.
    return !references.some(reference => reference.from === device.id && ids.has(reference.to));
  }).map(device => device.id);
}

const builtIns = [
  ["switches", "All Switches", "binarySwitch"],
  ["lights", "All Lights", "light"],
  ["cameras", "All Cameras", "camera"],
  ["speakers", "All Speakers", "speaker"],
  ["buttons", "All Buttons", "button"],
  ["string-lights", "All String Lights", "stringLight"],
  ["motion-sensors", "All Motion Sensors", "motionSensor"],
  ["occupancy-sensors", "All Occupancy Sensors", "occupancySensor"],
  ["contact-sensors", "All Contact Sensors", "contactSensor"],
  ["hubs", "All Hubs", "hub"],
] as const;

export function resolveDeviceGroups(devices: readonly Device[], configured: readonly DeviceGroupConfig[], assignments?: ReadonlyMap<string, readonly string[]>, references: readonly GroupReference[] = []): DeviceGroup[] {
  const defaults: DeviceGroup[] = builtIns.map(([id, name, kind]) => {
    const criteria = { schemaId: capabilitySchemas[kind].$ref };
    return { id: `automatic:${id}`, name, criteria, members: automaticGroupMembers(devices, criteria, undefined, references), builtIn: true };
  });
  const sensorCriteria = { schemaId: sensorSchema.$id };
  defaults.push({ id: "automatic:sensors", name: "All Sensors", criteria: sensorCriteria, members: automaticGroupMembers(devices, sensorCriteria, undefined, references), builtIn: true });
  return [...configured.map(group => ({ ...group, members: group.criteria ? automaticGroupMembers(devices, group.criteria, assignments, references) : [...group.members!] })), ...defaults];
}

/**
 * Why a criteria cannot be accepted, or undefined when it can.
 *
 * Shared by the group builder and by an API token's subject: both are the same
 * definition in the same syntax, so both are refused for the same reasons.
 */
export function criteriaProblem(
  criteria: AutomaticGroupCriteria,
  models: readonly DeviceModel[],
  devices: readonly Device[],
  tagExists: (id: string) => boolean,
): string | undefined {
  if (criteria.schemaId && !groupSchemaChoices(models, devices).some(schema => schema.id === criteria.schemaId)) {
    return "Choose a published device or capability schema";
  }
  if (criteria.tagIds?.some(id => !tagExists(id))) return "Choose existing tags";
  return undefined;
}
