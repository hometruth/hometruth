/** Scene controls use the same object actions and state stream as device pages. */
import { ht } from "./runtime.ts";
import { isCold } from "./view.ts";
import type { NodeId } from "../../state/protocol.ts";
import type { SceneDevicePresentation } from "../scene-model.ts";

type Device = { id: string; name: string; page: string; capabilities: string[] } & Partial<SceneDevicePresentation>;
type ObjectState = { status?: string; capabilities?: Record<string, { state?: Record<string, any>; actions?: Record<string, any> }>; sensors?: { name: string; unit?: string; state?: { value?: number } }[] };
const seed = document.getElementById("ht-overview-data");
if (seed && ht.state) {
  const { devices } = JSON.parse(seed.textContent || "{}") as { devices: Device[] };
  const state = ht.state;
  const records = new Map<string, ObjectState>();
  const pending = new Set<string>();
  const nodeOf = (device: Device): NodeId => `device/${device.id}`;
  const objectOf = (device: Device) => records.get(device.id);
  const capsOf = (device: Device) => objectOf(device)?.capabilities ?? {};
  const powerKind = (device: Device) => device.capabilities.find(kind => ["light", "stringLight", "binarySwitch", "television"].includes(kind));
  const isOn = (device: Device) => { const kind = powerKind(device); const current = kind ? capsOf(device)[kind]?.state : undefined; return current?.on === true || current?.value === "on" || current?.power === "on" || capsOf(device).speaker?.state?.playback === "playing" || capsOf(device).cooktop?.state?.childLocked === true; };
  const primary = (device: Device): { kind: string; action: string; value?: unknown } | undefined => {
    const caps = capsOf(device), kind = powerKind(device);
    if (kind) { const actions = caps[kind]?.actions ?? {}; const action = actions.toggle ? "toggle" : isOn(device) ? "turnOff" : "turnOn"; if (Object.hasOwn(actions, action)) return { kind, action }; }
    const action = caps.speaker?.state?.playback === "playing" ? "pause" : "play";
    if (caps.speaker?.actions?.[action]) return { kind: "speaker", action };
    if (caps.button?.actions?.press) return { kind: "button", action: "press" };
    if (caps.treatDispenser?.actions?.dispense) return { kind: "treatDispenser", action: "dispense", value: 1 };
    if (caps.cooktop?.actions?.setChildLock) return { kind: "cooktop", action: "setChildLock", value: !caps.cooktop.state?.childLocked };
    return undefined;
  };
  const reading = (device: Device) => {
    const object = objectOf(device), caps = capsOf(device);
    if (!object || object.status !== "online") return object?.status === "offline" ? "Offline" : "—";
    if (powerKind(device)) return isOn(device) ? device.onLabel ?? "On" : device.offLabel ?? "Off";
    if (caps.speaker) return caps.speaker.state?.playback === "playing" ? "Playing" : "Paused";
    if (caps.cooktop) return caps.cooktop.state?.childLocked ? "Locked" : "Unlocked";
    if (caps.treatDispenser) return "Dispense";
    if (caps.button) return device.effect === "vacuum-dock" ? "Return" : "Start";
    if (caps.occupancySensor) return caps.occupancySensor.state?.occupied ? "Occupied" : "Clear";
    if (caps.contactSensor) return caps.contactSensor.state?.open ? "Open" : "Closed";
    if (caps.motionSensor) return caps.motionSensor.state?.motion ? "Motion" : "Clear";
    const readings = (object.sensors ?? []).flatMap(sensor => typeof sensor.state?.value === "number" ? [`${ht.number(sensor.state.value, { maximumFractionDigits: 1 })}${sensor.unit ?? ""}`] : []);
    const collection = caps.sensor?.state;
    if (collection?.detail) return String(collection.detail);
    if (Array.isArray(collection?.sensors)) for (const sensor of collection.sensors) if (typeof sensor.value === "number") readings.push(`${ht.number(sensor.value, { maximumFractionDigits: 1 })}${sensor.unit ?? ""}`);
    if (readings.length) return readings.slice(0, 2).join(" · ");
    return caps.camera ? "Live view ↗" : "Online";
  };
  let redraw = () => {};
  const update = () => {
    for (const device of devices) {
      const card = document.querySelector<HTMLElement>(`[data-device-card="${CSS.escape(device.id)}"]`);
      if (!card) continue;
      card.dataset.on = String(isOn(device)); card.dataset.busy = String(pending.has(device.id));
      const value = card.querySelector<HTMLElement>("[data-device-reading]"); if (value) { value.textContent = reading(device); ht.live(value, state.read(nodeOf(device))?.observedAt); }
      const button = card.querySelector<HTMLButtonElement>("[data-device-control]");
      if (button) { const action = primary(device); button.disabled = pending.has(device.id) || !action; button.setAttribute("aria-busy", String(pending.has(device.id))); if (action && !["press", "dispense"].includes(action.action)) button.setAttribute("aria-pressed", String(isOn(device))); }
    }
    redraw();
  };
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-device-control]")) button.addEventListener("click", async () => {
    const device = devices.find(device => device.id === button.dataset.deviceControl)!;
    const action = primary(device); if (!action || pending.has(device.id)) return;
    pending.add(device.id); update();
    const feedback = document.querySelector<HTMLElement>("[data-control-feedback]");
    try { await state.invoke(nodeOf(device), action.kind, action.action, action.value); if (feedback) feedback.textContent = `${device.name}: ${reading(device)}`; }
    catch (error) { if (feedback) feedback.textContent = error instanceof Error ? error.message : "Could not update device"; }
    finally { pending.delete(device.id); update(); }
  });
  for (const device of devices) state.subscribe(nodeOf(device), record => { const value = (record.value ?? {}) as ObjectState; records.set(device.id, record.fault ? { ...value, status: "offline" } : record.stale && isCold(record.observedAt, Date.now()) ? { ...value, status: "unknown" } : value); update(); }, "glance");

  const canvas = document.querySelector<HTMLCanvasElement>("[data-house-canvas]");
  const base = document.querySelector<HTMLImageElement>(".vh-fallback");
  const layers = [...document.querySelectorAll<HTMLImageElement>("[data-scene-assets] img")];
  if (canvas && base && layers.length === 3) {
    const context = canvas.getContext("2d")!;
    const [flow, dry, gate] = layers as [HTMLImageElement, HTMLImageElement, HTMLImageElement];
    const waterDevice = devices.find(device => device.effect === "waterfall");
    const gateDevice = devices.find(device => device.effect === "gate");
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0, timer: number | undefined, visible = true;
    const draw = () => {
      if (![base, flow, dry, gate].every(image => image.complete && image.naturalWidth)) return;
      const waterOn = waterDevice ? isOn(waterDevice) : false;
      context.imageSmoothingEnabled = false;
      context.drawImage(base, 0, 0);
      if (waterOn) context.drawImage(flow, (frame % 4) * 64, Math.floor(frame / 4) * 96, 64, 96, 40, 128, 64, 96);
      else context.drawImage(dry, 40, 128);
      if (!gateDevice || !isOn(gateDevice)) context.drawImage(gate, 240, 184);
      canvas.dataset.waterfall = waterOn ? "on" : "off"; canvas.dataset.gate = gateDevice && isOn(gateDevice) ? "open" : "closed"; canvas.dataset.frame = String(frame);
      canvas.hidden = false; base.hidden = true;
    };
    const schedule = () => {
      if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
      draw();
      if (visible && !document.hidden && !reduced.matches && waterDevice && isOn(waterDevice)) timer = window.setTimeout(() => { frame = (frame + 1) % 8; schedule(); }, 140);
    };
    redraw = schedule;
    for (const layer of [base, ...layers]) layer.addEventListener("load", schedule);
    const observer = new IntersectionObserver(entries => { visible = entries.some(entry => entry.isIntersecting); schedule(); }); observer.observe(canvas.parentElement!);
    document.addEventListener("visibilitychange", schedule); reduced.addEventListener("change", schedule);
    window.addEventListener("pagehide", () => { if (timer !== undefined) clearTimeout(timer); observer.disconnect(); }, { once: true });
    schedule();
  }
  update();
}
