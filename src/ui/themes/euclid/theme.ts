/** Euclid: a proof book. Warm paper, ink rules, one blue, round marks. */
import type { ThemeDefinition } from "../theme.ts";

export const euclid = {
  id: "euclid",
  shape: {
    "font-body": '"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, "Times New Roman", serif',
    text: "17px",
    "rule-w": "1.5px",
    "mark-radius": "50%",
    radius: "0",
    shadow: "none",
  },
  light: {
    bg: "#F4EBD8", panel: "#EBDFC6", fg: "#191816", "fg-2": "#5F584D",
    rule: "#191816", hair: "rgba(25, 24, 22, .24)",
    accent: "#0E558A", "accent-fg": "#F4EBD8",
    ok: "#0E558A", warn: "#7A5806", "warn-mark": "#E4A412", bad: "#C43C35",
    "ok-soft": "rgba(14, 85, 138, .10)", "bad-soft": "rgba(196, 60, 53, .10)", "warn-soft": "rgba(228, 164, 18, .16)",
    stage: "#191816", "stage-fg": "#EFE2C9",
    live: "color-mix(in srgb, var(--fg) 80%, var(--accent))",
  },
  dark: {
    bg: "#191816", panel: "#242220", fg: "#EFE2C9", "fg-2": "#B3A78E",
    rule: "#EFE2C9", hair: "rgba(239, 226, 201, .24)",
    accent: "#7FB2DE", "accent-fg": "#191816",
    ok: "#7FB2DE", warn: "#E4A412", "warn-mark": "#E4A412", bad: "#E07770",
    "ok-soft": "rgba(127, 178, 222, .14)", "bad-soft": "rgba(224, 119, 112, .14)", "warn-soft": "rgba(228, 164, 18, .14)",
    stage: "#0E0D0C", "stage-fg": "#EFE2C9",
    live: "color-mix(in srgb, var(--fg) 80%, var(--accent))",
  },
  character: String.raw`
  /* Euclid: a proof book. Small-caps section titles, the brand set like a running head. */
  [data-theme="euclid"] h2, [data-theme="euclid"] legend { font-variant-caps: all-small-caps; letter-spacing: .06em; font-size: 1.0625rem; }
  [data-theme="euclid"] .brand { font-variant-caps: all-small-caps; letter-spacing: .08em; font-size: 1.125rem; }
  [data-theme="euclid"] .site-nav { font-variant-caps: all-small-caps; letter-spacing: .06em; font-size: 1.0625rem; }
  [data-theme="euclid"] h1 { font-size: 2.5rem; }
  [data-theme="euclid"] .state-value { font-size: 1.75rem; }
`,
  rules: { shadows: "none", radii: "marks-only", gradients: false },
  components: ["ht-switch", "ht-switch-row", "ht-button", "ht-light", "ht-status", "ht-sensor", "ht-sensor-row", "ht-television"],
  entry: "themes/euclid/index.ts",
} as const satisfies ThemeDefinition;
