/** Visual bindings accompany demo state; they never change a device's capabilities. */
export interface SceneDevicePresentation {
  scene: "house" | "room";
  icon: string;
  effect?: "waterfall" | "gate" | "fan" | "blinds" | "television" | "vacuum-start" | "vacuum-dock";
  target?: string;
  onLabel?: string;
  offLabel?: string;
}
export interface ScenePresentation {
  devices: Record<string, SceneDevicePresentation>;
}
