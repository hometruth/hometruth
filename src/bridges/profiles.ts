import catalog from "./homekit-catalog.json";
import { elementKey, parseElementKey } from "../tags/identity";
import { BridgeError, type AccessoryMapping, type AccessoryProfile, type BridgeProtocol, type CharacteristicDefinition, type ExportAccessory, type Value } from "./model";

export const ACCESSORY_PROFILES: AccessoryProfile[] = [
  ...catalog as AccessoryProfile[],
  { ...structuredClone(catalog.find(profile => profile.id === "Switch")!) as AccessoryProfile,
    id: "MomentarySwitch", name: "Button (tap to run)", protocols: ["homekit"] },
];
export function profileFor(id: string): AccessoryProfile {
  const profile = ACCESSORY_PROFILES.find(profile => profile.id === id);
  if (!profile) throw new BridgeError("Unknown Apple Home accessory type");
  return profile;
}

export function validateCharacteristic(value: unknown, definition: CharacteristicDefinition): Value {
  if (definition.format === "bool") {
    if (typeof value !== "boolean") throw new BridgeError(`${definition.name} requires true or false`);
  } else if (["float", "int", "uint8", "uint16", "uint32", "uint64"].includes(definition.format)) {
    if (typeof value !== "number" || !Number.isFinite(value)
      || definition.format !== "float" && !Number.isInteger(value)
      || definition.minimum !== undefined && value < definition.minimum
      || definition.maximum !== undefined && value > definition.maximum
      || definition.values && !definition.values.includes(value)) throw new BridgeError(`${definition.name} is outside its supported values`);
  } else if (typeof value !== "string" || value.length > 65536) throw new BridgeError(`${definition.name} requires text`);
  return value as Value;
}

export function validateMapping(mapping: AccessoryMapping, protocol: BridgeProtocol, exists: (key: string, control: boolean) => boolean): void {
  const profile = profileFor(mapping.profile);
  if (!profile.protocols.includes(protocol)) throw new BridgeError(`${profile.name} needs a ${profile.protocols.join(" or ")} bridge`);
  if (["Camera", "VideoDoorbell"].includes(profile.id) && !mapping.camera) throw new BridgeError("Choose a camera media source");
  if (profile.id === "MomentarySwitch" && !mapping.characteristics.On?.trigger) throw new BridgeError("Choose a button trigger for On");
  for (const [key, binding] of Object.entries(mapping.characteristics)) {
    const definition = profile.characteristics.find(characteristic => characteristic.key === key);
    if (!definition) throw new BridgeError(`Unknown ${profile.name} characteristic: ${key}`);
    if (binding.trigger) {
      if (profile.id !== "MomentarySwitch" || key !== "On" || Object.keys(binding).some(key => key !== "trigger")) {
        throw new BridgeError("A button trigger can only be the sole On binding of Button (tap to run)");
      }
      const source = parseElementKey(binding.trigger.element);
      if (source?.kind !== "capability" || source.ids.length !== 2 || source.ids[1] !== "button"
        || !exists(binding.trigger.element, false) || !exists(elementKey("control", source.ids[0]!, "button", "press"), true)) {
        throw new BridgeError("Choose an available button capability as the trigger");
      }
    }
    if (binding.constant !== undefined) {
      if (!definition.configuration) throw new BridgeError(`${definition.name} must use observed state, not a fixed value`);
      validateCharacteristic(binding.constant, definition);
    }
    if (binding.event && (key !== "ProgrammableSwitchEvent" || !exists(binding.event.element, false))) throw new BridgeError("Choose a button event source");
    if (binding.read && !exists(binding.read.element, false)) throw new BridgeError(`${definition.name} refers to a missing readable element`);
    const controls = [...(binding.write ? [binding.write] : []), ...Object.values(binding.commands ?? {})];
    if (controls.length && !definition.writable) throw new BridgeError(`${definition.name} is read-only in Apple Home`);
    for (const control of controls) if (!exists(control.element, true)) throw new BridgeError(`${definition.name} refers to a missing control`);
  }
  for (const definition of profile.characteristics.filter(c => c.required || mapping.characteristics[c.key])) {
    const binding = mapping.characteristics[definition.key];
    if (!binding) throw new BridgeError(`Map ${definition.name} before exposing ${profile.name}`);
    if (definition.readable && !binding.read && !binding.event && !binding.trigger && binding.constant === undefined) throw new BridgeError(`${definition.name} needs a state source`);
    if (definition.writable && !binding.write && !binding.trigger && !Object.keys(binding.commands ?? {}).length && !definition.configuration) throw new BridgeError(`${definition.name} needs a control`);
  }
}

/** Types with their own media, inputs or trigger semantics keep the type HomeTruth chose. */
const FIXED_PROFILES = new Set(["Camera", "VideoDoorbell", "Television", "MomentarySwitch", "Doorbell", "StatelessProgrammableSwitch"]);
/**
 * The accessory types an automatic accessory can appear as without losing or inventing a binding:
 * every characteristic it maps exists on the other type, and the other type requires nothing more.
 * A plain on/off switch can therefore be a Switch, Outlet or Lightbulb; a dimmable light stays a Lightbulb.
 */
export function alternativeProfiles(accessory: Pick<ExportAccessory, "profile" | "characteristics" | "cameraDevice" | "inputs">, protocol: BridgeProtocol): string[] {
  if (FIXED_PROFILES.has(accessory.profile) || accessory.cameraDevice || accessory.inputs) return [accessory.profile];
  const keys = Object.keys(accessory.characteristics);
  return ACCESSORY_PROFILES.filter(profile => profile.id === accessory.profile || profile.protocols.includes(protocol) && !profile.external && !FIXED_PROFILES.has(profile.id)
    && keys.every(key => profile.characteristics.some(characteristic => characteristic.key === key))
    && profile.characteristics.every(characteristic => !characteristic.required || keys.includes(characteristic.key)))
    .map(profile => profile.id);
}
