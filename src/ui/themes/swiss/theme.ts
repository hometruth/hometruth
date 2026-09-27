/** Swiss: the grid. White, ink, one red, square marks; Euclid's elements restyled through custom properties. */
import type { ThemeDefinition } from "../theme.ts";

/** The switch value set like a Swiss headline; the elements are Euclid's. */
const SWITCH = {
  "--ht-switch-value-weight": "700",
  "--ht-switch-value-tracking": "-.02em",
  "--ht-switch-value-size": "1.5rem",
} as const;

export const swiss = {
  id: "swiss",
  shape: {
    "font-body": '"Helvetica Neue", Helvetica, "Neue Haas Grotesk Text", Arial, system-ui, sans-serif',
    text: "16px",
    "rule-w": "1px",
    "mark-radius": "0",
    radius: "0",
    shadow: "none",
  },
  light: {
    bg: "#FFFFFF", panel: "#F2F2F2", fg: "#111111", "fg-2": "#6A6A6A",
    rule: "#111111", hair: "rgba(17, 17, 17, .16)",
    accent: "#C8102E", "accent-fg": "#FFFFFF",
    ok: "#111111", warn: "#6A6A6A", "warn-mark": "#8C8C8C", bad: "#C8102E",
    "ok-soft": "rgba(17, 17, 17, .07)", "bad-soft": "rgba(200, 16, 46, .09)", "warn-soft": "rgba(17, 17, 17, .07)",
    stage: "#111111", "stage-fg": "#F2F2F2",
    live: "color-mix(in srgb, var(--fg) 85%, var(--accent))",
  },
  dark: {
    bg: "#121212", panel: "#1D1D1D", fg: "#F2F2F2", "fg-2": "#9C9C9C",
    rule: "#F2F2F2", hair: "rgba(242, 242, 242, .18)",
    accent: "#FF3B4E", "accent-fg": "#121212",
    ok: "#F2F2F2", warn: "#9C9C9C", "warn-mark": "#9C9C9C", bad: "#FF3B4E",
    "ok-soft": "rgba(242, 242, 242, .08)", "bad-soft": "rgba(255, 59, 78, .14)", "warn-soft": "rgba(242, 242, 242, .08)",
    stage: "#000000", "stage-fg": "#F2F2F2",
    live: "color-mix(in srgb, var(--fg) 85%, var(--accent))",
  },
  extra: { light: SWITCH, dark: SWITCH },
  character: String.raw`
  /* Swiss: the grid. Tracked capitals for section titles, tight bold headline, hairlines. */
  [data-theme="swiss"] h1 { font-weight: 700; font-size: 2.25rem; letter-spacing: -.025em; }
  [data-theme="swiss"] h2, [data-theme="swiss"] legend { font-size: .75rem; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
  [data-theme="swiss"] .brand { font-weight: 700; letter-spacing: .1em; text-transform: uppercase; font-size: .8125rem; }
  [data-theme="swiss"] .site-nav { font-size: .8125rem; letter-spacing: .06em; text-transform: uppercase; }
  [data-theme="swiss"] .state-value { font-weight: 700; letter-spacing: -.02em; }
  [data-theme="swiss"] .row-name { font-weight: 500; }
`,
  rules: { shadows: "none", radii: "none", gradients: false },
  components: ["ht-switch", "ht-switch-row", "ht-button", "ht-light", "ht-status", "ht-sensor", "ht-sensor-row", "ht-television"],
  entry: "themes/swiss/index.ts",
} as const satisfies ThemeDefinition;
