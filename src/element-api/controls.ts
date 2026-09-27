import type { CapabilityKind } from "../models/capability";
import { record, type Schema } from "./schema";

const bool: Schema = { type: "boolean" };
const text: Schema = { type: "string", minLength: 1 };
const number: Schema = { type: "number" };
const object = (properties: Schema, required: string[] = []): Schema => ({ type: "object", additionalProperties: false, properties, required });
const none = new Set(["turnOn", "turnOff", "toggle", "getState", "getLights", "getScenes", "getShows", "getPresets", "stopShow", "play", "pause", "stop", "leaveGroup", "playCall", "stopMovement", "pan.home", "tilt.home", "volumeUp", "volumeDown", "toggleMute", "readSettings", "latestPhoto"]);

/** Transport value schemas, using the same control ids that Capability.invoke accepts. */
export function controlRequest(kind: CapabilityKind | undefined, control: string, bounds: Schema = {}): Schema {
  let value: Schema | undefined;
  let optional = false;
  if (none.has(control)) value = undefined;
  else if (["setMute", "setPrivacy", "setArtMode", "setChildLock"].includes(control)) value = bool;
  else if (["setBrightness", "setVolume", "setSensitivity"].includes(control)) value = { type: "number", minimum: 0, maximum: 100, examples: [50] };
  else if (control === "setColorTemperature") value = { type: "number", examples: [3000] };
  else if (control === "setTimer") value = { type: "integer", minimum: 0, maximum: 5940, examples: [60] };
  else if (control === "setClearAfter") value = { type: "integer", minimum: 1, examples: [30000] };
  else if (control === "setColor") value = { type: "string", pattern: "^#[0-9a-fA-F]{6}$", examples: ["#ff8800"] };
  else if (["say", "joinGroup", "setInput", "launchApp"].includes(control)) value = text;
  else if (control === "playUri") value = { oneOf: [{ ...text, examples: ["https://example.com/audio.mp3"] }, object({ uri: text, title: text }, ["uri"])] };
  else if (control === "press" && kind === "button") { value = { oneOf: [{ type: "integer", minimum: 1 }, object({ durationMs: { type: "integer", minimum: 1 } })] }; optional = true; }
  else if (control === "press" && kind === "television") value = { ...text, ...(Array.isArray(bounds.keys) ? { enum: bounds.keys } : { examples: ["KEY_HOME"] }) };
  else if (control === "dispense") { value = { type: "integer", minimum: 1, examples: [1] }; optional = true; }
  else if (/^(pan|tilt)\./.test(control)) value = { type: "integer", minimum: 1, examples: [500] };
  else if (control === "send") value = { oneOf: [{ ...text, description: "Encoded signal from a learned or saved code." }, object({ code: text, durationMs: number }, ["code"])] };
  else if (control === "learn") { value = object({ timeoutMs: number, ...(kind === "radioFrequencyBlaster" ? { frequencyHz: number } : {}) }); optional = true; }
  else value = { description: "JSON value accepted by this control. Inspect its action limits before supplying a value." };
  if (value && (value.type === "number" || value.type === "integer")) {
    const range = Object.keys(record(bounds.lease)).length ? record(bounds.lease) : bounds;
    const minimum = Object.entries(range).find(([key, val]) => /^(minimum|min[A-Z])/.test(key) && typeof val === "number")?.[1];
    const maximum = Object.entries(range).find(([key, val]) => /^(maximum|max[A-Z])/.test(key) && typeof val === "number")?.[1];
    if (typeof minimum === "number") { value.minimum = minimum; value.examples = [minimum]; }
    if (typeof maximum === "number") value.maximum = maximum;
  }
  return object({ ...(value ? { value } : {}), confirmed: { type: "boolean", description: "Set true only after confirming an action that requires confirmation." } }, value && !optional ? ["value"] : []);
}
