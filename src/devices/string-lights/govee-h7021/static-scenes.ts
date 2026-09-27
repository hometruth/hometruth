import type { LightScene } from "../../../models/light-show";

/** Explicit RGB arrangements. Repeated along the string once, with no timer. */
export const STATIC_SCENES: readonly LightScene[] = [
  { id: "candy-cane", name: "Candy cane", pattern: "repeat", colors: ["#ff0000", "#ffffff"] },
  { id: "holiday-colors", name: "Holiday colors", pattern: "repeat", colors: ["#ff1800", "#00b030", "#fff1cf"] },
  { id: "ocean-colors", name: "Ocean colors", pattern: "repeat", colors: ["#0040ff", "#00c8d8"] },
  { id: "sunset-colors", name: "Sunset colors", pattern: "repeat", colors: ["#ff3800", "#ff9c20", "#b42666"] },
  { id: "forest-colors", name: "Forest colors", pattern: "repeat", colors: ["#125f22", "#76bd32", "#ffc75c"] },
  { id: "lavender-colors", name: "Lavender colors", pattern: "repeat", colors: ["#a040ff", "#e6b4ff"] },
  { id: "rainbow-colors", name: "Rainbow colors", pattern: "repeat", colors: ["#ff0000", "#ff8a00", "#ffe100", "#00bc43", "#005cff", "#9626ff"] },
  { id: "warm-glow", name: "Warm glow", pattern: "repeat", colors: ["#ffd48a", "#ff9f37"] },
];
