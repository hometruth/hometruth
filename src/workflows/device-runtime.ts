import { Speaker } from "../models/speaker";
import { DINNER_BELL } from "./sounds";
import { isDeepStrictEqual } from "node:util";
import type { Device } from "../models/device";
import { Light, type LightState } from "../models/light";
import { LightGroupCapability } from "../devices/composites/light-group";
import { throwIfCancelled, wait, type WorkflowRuntime } from "./runner";

const leases = new WeakMap<object, Promise<void>>();
/** Reserve all underlying resources together, including group members, until cleanup finishes. */
async function exclusively<T>(resources: object[], signal: AbortSignal, task: () => Promise<T>): Promise<T> {
  const unique = [...new Set(resources)]; const previous = unique.map(resource => leases.get(resource));
  let release!: () => void; const lease = new Promise<void>(resolve => { release = resolve; });
  for (const resource of unique) leases.set(resource, lease);
  try { await Promise.all(previous); throwIfCancelled(signal); return await task(); }
  finally { release(); for (const resource of unique) if (leases.get(resource) === lease) leases.delete(resource); }
}
function lights(light: Light): Light[] { return light instanceof LightGroupCapability ? [...new Set(light.members.flatMap(lights))] : [light]; }
async function restore(light: Light, state: LightState) {
  // Always try power restoration even if a color or brightness write fails.
  try {
    if (state.colorTemperatureKelvin !== undefined && light.supportsColorTemperature()) await light.setColorTemperature(state.colorTemperatureKelvin);
    else if (state.color && light.supportsColor()) await light.setColor(state.color);
    await light.setBrightness(state.brightnessPercent);
  } finally { await (state.on ? light.turnOn() : light.turnOff()); }
}
export function deviceRuntime(devices: ReadonlyMap<string, Device>): WorkflowRuntime {
  return {
    async action(action, signal) {
      throwIfCancelled(signal); const device = devices.get(action.target);
      if (!device) throw new Error(`Missing target ${action.target}`);
      const light = device.capability("light");
      const resources = light instanceof Light && action.operation.startsWith("light.") ? lights(light) : [device];
      await exclusively(resources, signal, async () => {
        if (action.operation === "speaker.playSound") {
          const speaker = device.capability("speaker");
          if (!(speaker instanceof Speaker) || !speaker.supportsSounds()) throw new Error("Local sounds are unavailable");
          const state = await speaker.getState(); throwIfCancelled(signal);
          if (state.playback !== "stopped" || !state.group.isCoordinator || state.group.memberHosts?.length !== 1) throw new Error("Dinner bell requires a stopped, ungrouped speaker");
          try {
            await speaker.setVolume(Number(action.input.volumePercent)); throwIfCancelled(signal);
            await speaker.setMute(false); throwIfCancelled(signal);
            await speaker.playSound(action.input.sound as "dinnerBell");
            await wait(DINNER_BELL.durationMs + 1000, signal);
          } finally {
            // Every cleanup step is attempted, even if one fails.
            const results = await Promise.allSettled([speaker.stop(), speaker.setVolume(state.volumePercent), speaker.setMute(state.muted)]);
            if (results.some(result => result.status === "rejected")) throw new Error("Sound cleanup could not restore speaker settings");
          }
          return;
        }
        if (action.operation !== "light.flash") {
          await device.invokeControl(action.operation, action.input.value); throwIfCancelled(signal); return;
        }
        if (!(light instanceof Light)) throw new Error("Flash requires a light");
        const members = lights(light);
        const snapshots = await Promise.all(members.map(async member => ({ member, state: await member.getState() })));
        throwIfCancelled(signal);
        let actionError: unknown;
        try {
          for (let cycle = 0; cycle < Number(action.input.count); cycle++) for (const color of action.input.colors as string[]) {
            throwIfCancelled(signal);
            // Settle every member before restoration, including when one write fails.
            const results = await Promise.allSettled(members.map(async member => {
              await member.setColor(color); throwIfCancelled(signal);
              await member.setBrightness(Number(action.input.brightnessPercent)); throwIfCancelled(signal); await member.turnOn();
            }));
            const failure = results.find(r => r.status === "rejected"); if (failure?.status === "rejected") throw failure.reason;
            await wait(Number(action.input.onMs), signal);
            const off = await Promise.allSettled(members.map(member => member.turnOff()));
            const offFailure = off.find(r => r.status === "rejected"); if (offFailure?.status === "rejected") throw offFailure.reason;
            await wait(Number(action.input.offMs), signal);
          }
        } catch (error) { actionError = error; }
        const restored = await Promise.allSettled(snapshots.map(({ member, state }) => restore(member, state)));
        if (restored.some(r => r.status === "rejected")) throw new Error("Flash cleanup could not restore every light");
        if (actionError) throw actionError;
      });
    },
    async predicate(predicate, signal) {
      throwIfCancelled(signal);
      try {
        const device = devices.get(predicate.target); if (!device) return undefined;
        const document = await device.describe(); throwIfCancelled(signal);
        const parts = predicate.path.slice(1).split("/").map(part => part.replace(/~1/g, "/").replace(/~0/g, "~"));
        const kind = parts[1]; const capability = kind ? (document.capabilities as Record<string, { state?: { availability?: string } }>)[kind] : undefined;
        if (capability?.state?.availability !== "online") return undefined;
        let value: unknown = document;
        for (const part of parts) { if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) return undefined; value = (value as Record<string, unknown>)[part]; }
        if (predicate.operator === "equals") return isDeepStrictEqual(value, predicate.value);
        if (predicate.operator === "notEquals") return !isDeepStrictEqual(value, predicate.value);
        if (typeof value !== "number" || typeof predicate.value !== "number") return undefined;
        return predicate.operator === "greaterThan" ? value > predicate.value : value < predicate.value;
      } catch (error) { throwIfCancelled(signal); return undefined; }
    },
  };
}
