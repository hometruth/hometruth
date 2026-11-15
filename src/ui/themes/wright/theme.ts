import type { ThemeDefinition } from "../theme.ts";
import { euclid } from "../euclid/theme.ts";

/** Island modernism: warm sand, lagoon teal, koa wood, and tactile accessory tiles. */
export const wright = {
  id: "wright",
  shape: { "font-body": '"Avenir Next", Avenir, "Segoe UI", sans-serif', text: "16px", "rule-w": "1px", "mark-radius": "50%", radius: "16px", shadow: "none" },
  light: { bg: "#F3EAD8", panel: "#E6DFCA", fg: "#254B47", "fg-2": "#5F6B5D", rule: "#536151", hair: "#D9D4C5", accent: "#176A66", "accent-fg": "#FFF8E9", ok: "#3F644C", warn: "#80601F", "warn-mark": "#B88A39", bad: "#A2382B", "ok-soft": "#E3EADF", "bad-soft": "#F0DDD5", "warn-soft": "#F0E6CC", stage: "#243B30", "stage-fg": "#F1E8D4", live: "color-mix(in srgb, var(--fg) 80%, var(--accent))" },
  dark: { bg: "#1B2822", panel: "#27372D", fg: "#F0E8D5", "fg-2": "#B8BEAC", rule: "#9CA68E", hair: "#425044", accent: "#E8AD87", "accent-fg": "#241C15", ok: "#B0CAA0", warn: "#E6BC6D", "warn-mark": "#E6BC6D", bad: "#EDAC9C", "ok-soft": "#324932", "bad-soft": "#49332D", "warn-soft": "#49422A", stage: "#14231B", "stage-fg": "#F0E8D5", live: "color-mix(in srgb, var(--fg) 80%, var(--accent))" },
  character: '[data-theme="wright"] h1, [data-theme="wright"] h2 { font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif; font-weight: 400; letter-spacing: -.035em; }',
  rules: { shadows: "none", radii: "any", gradients: false },
  components: euclid.components,
  entry: "themes/wright/index.ts",
} as const satisfies ThemeDefinition;
