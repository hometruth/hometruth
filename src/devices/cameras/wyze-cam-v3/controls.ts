/**
 * Wyze Cam v3 product controls over Thingino's web API.
 * The catalog records verification levels; a transport acknowledgment alone
 * does not establish a physical result. See docs/WYZE.md for supported routes.
 * These controls require the Thingino web API key; other firmware profiles
 * report them as not supported.
 */
import type { ThinginoHeartbeat, ThinginoWebApi } from "../../../protocols/thingino";

export type WyzeCamV3Verification = "inferred" | "transport ACK" | "state read-back" | "sensor confirmed" | "human confirmed";

export interface WyzeCamV3Control {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** `toggle` takes true/false; `select` takes one of `values`. */
  readonly kind: "toggle" | "select";
  readonly values?: readonly string[];
  /** Something a person can see or hear changes (IR LEDs glow, picture goes dark). */
  readonly physical: boolean;
  readonly verification: WyzeCamV3Verification;
  /** The current value from the heartbeat, when it reports one. */
  read(state: ThinginoHeartbeat): boolean | string | undefined;
  write(api: ThinginoWebApi, value: boolean | string): Promise<void>;
}

const toggle = (
  id: string,
  label: string,
  description: string,
  physical: boolean,
  verification: WyzeCamV3Verification,
  read: (state: ThinginoHeartbeat) => boolean | undefined,
  write: (api: ThinginoWebApi, on: boolean) => Promise<unknown>,
): WyzeCamV3Control => ({
  id, label, description, kind: "toggle", physical, verification, read,
  async write(api, value) { await write(api, value === true); },
});

export const WYZE_CAM_V3_CONTROLS: readonly WyzeCamV3Control[] = [
  {
    id: "nightVision.mode",
    label: "Night vision",
    description: "Auto switches by sensor gain; day and night force the IR cut filter, IR LEDs, and colour mode together.",
    kind: "select",
    values: ["auto", "day", "night"],
    physical: true,
    verification: "state read-back",
    read: (state) => (state.dayNightAuto ? "auto" : state.dayNightMode),
    async write(api, value) {
      if (value === "auto") await api.setSwitch("auto", true);
      else if (value === "day" || value === "night") await api.setDayNight(value);
    },
  },
  toggle("nightVision.irCut", "IR cut filter", "Block infrared from the sensor (day picture).", false, "state read-back", (state) => state.irCut, (api, on) => api.setSwitch("ircut", on)),
  toggle("nightVision.irNear", "IR light (850 nm)", "The visible-glow infrared LEDs.", true, "state read-back", (state) => state.ir850, (api, on) => api.setSwitch("ir850", on)),
  toggle("nightVision.irFar", "IR light (940 nm)", "The invisible infrared LEDs.", true, "state read-back", (state) => state.ir940, (api, on) => api.setSwitch("ir940", on)),
  toggle("video.monochrome", "Black and white", "Force the sensor's black-and-white mode; off means colour.", true, "state read-back", (state) => state.monochrome, (api, on) => api.setSwitch("color", on)),
  toggle("audio.microphone", "Microphone", "Include microphone audio in the streams.", false, "state read-back", (state) => state.microphone, (api, on) => api.setAudio("microphone", on)),
  toggle("audio.speaker", "Speaker", "Enable the speaker for two-way audio.", false, "state read-back", (state) => state.speaker, (api, on) => api.setAudio("speaker", on)),
  toggle("detection.motion", "Motion detection", "prudynt Motion Guard; events go to MQTT when configured.", false, "state read-back", (state) => state.motionDetection, (api, on) => api.setMotionDetection(on)),
];

export function wyzeCamV3Control(id: string): WyzeCamV3Control | undefined {
  return WYZE_CAM_V3_CONTROLS.find((control) => control.id === id);
}

/** Every control's current value from one heartbeat, for `readSettings`. */
export function readWyzeCamV3Settings(state: ThinginoHeartbeat): Record<string, boolean | string> {
  const values: Record<string, boolean | string> = {};
  for (const control of WYZE_CAM_V3_CONTROLS) {
    const value = control.read(state);
    if (value !== undefined) values[control.id] = value;
  }
  return values;
}
