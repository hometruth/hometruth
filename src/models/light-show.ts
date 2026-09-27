/** A scene is a static arrangement in physical bulb order. */
export interface LightScene {
  id: string;
  name: string;
  colors: string[];
  pattern: "repeat";
}
export interface LightSceneState {
  status: "idle" | "submitted" | "error";
  sceneId?: string;
  appliedAt?: string;
  detail?: string;
}
/** Shows change over time: one animation or a sequence of effects. */
export interface LightShow {
  id: string;
  name: string;
  category: string;
  kind: "animation" | "sequence";
  steps?: string[];
}
/** Vendor presets whose motion has not yet been established. */
export interface LightPreset { id: string; name: string; category: string }
export interface LightShowState {
  status: "idle" | "submitted" | "running" | "error";
  showId?: string;
  presetId?: string;
  effectId?: string;
  startedAt?: string;
  stepSeconds?: number;
  detail?: string;
}
export interface LightShows {
  getScenes(): readonly LightScene[];
  getSceneState(): LightSceneState;
  applyScene(value: unknown): Promise<void>;
  getShows(): readonly LightShow[];
  getShowState(): LightShowState;
  playShow(value: unknown): Promise<void>;
  stopShow(): Promise<void>;
  getPresets(): readonly LightPreset[];
  applyPreset(value: unknown): Promise<void>;
}
