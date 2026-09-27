/**
 * Brutal: neobrutalist. Warm off-white ground, black 3px borders, hard
 * offset shadows a button drops onto when pressed, electric pink accent,
 * yellow panel. Dark inverts the ground and colours the shadow with the
 * accent. Links are ink with a heavy accent underline so they clear 4.5:1.
 */
import type { ThemeDefinition } from "../theme.ts";

export const brutal = {
  id: "brutal",
  shape: {
    "font-body": '"Helvetica Neue", Helvetica, Arial, "Inter", system-ui, sans-serif',
    text: "16px",
    "rule-w": "3px",
    "mark-radius": ".375rem",
    radius: ".375rem",
    shadow: ".375rem .375rem 0 var(--rule)",
  },
  light: {
    bg: "#FFFBEB", panel: "#FFE566", fg: "#111111", "fg-2": "#4A4A4A",
    rule: "#111111", hair: "rgba(17, 17, 17, .3)",
    accent: "#FF4D8D", "accent-fg": "#111111",
    ok: "#0A7A3E", warn: "#8A5A00", "warn-mark": "#FFB800", bad: "#C81E1E",
    "ok-soft": "rgba(10, 122, 62, .14)", "bad-soft": "rgba(200, 30, 30, .12)", "warn-soft": "rgba(255, 184, 0, .24)",
    stage: "#111111", "stage-fg": "#FFFBEB",
    live: "color-mix(in srgb, var(--fg) 78%, var(--accent))",
  },
  dark: {
    shadow: ".375rem .375rem 0 var(--accent)",
    bg: "#111111", panel: "#262626", fg: "#FFFBEB", "fg-2": "#C2BDAE",
    rule: "#FFFBEB", hair: "rgba(255, 251, 235, .3)",
    accent: "#FF4D8D", "accent-fg": "#111111",
    ok: "#3DDC84", warn: "#FFB800", "warn-mark": "#FFB800", bad: "#FF6B6B",
    "ok-soft": "rgba(61, 220, 132, .16)", "bad-soft": "rgba(255, 107, 107, .16)", "warn-soft": "rgba(255, 184, 0, .18)",
    stage: "#000000", "stage-fg": "#FFFBEB",
    live: "color-mix(in srgb, var(--fg) 78%, var(--accent))",
  },
  character: String.raw`
  /* Brutal: black capitals, thick rules, buttons that drop onto their shadow when pressed. */
  [data-theme="brutal"] h1, [data-theme="brutal"] h2, [data-theme="brutal"] legend { font-weight: 900; text-transform: uppercase; letter-spacing: -.02em; }
  [data-theme="brutal"] h1 { font-size: 2.75rem; line-height: 1; }
  [data-theme="brutal"] h2 { font-size: 1.125rem; }
  [data-theme="brutal"] .brand { font-weight: 900; text-transform: uppercase; letter-spacing: .04em; }
  [data-theme="brutal"] .site-nav { font-weight: 700; text-transform: uppercase; font-size: .875rem; letter-spacing: .04em; }
  [data-theme="brutal"] a { color: var(--fg); text-decoration-color: var(--accent); text-decoration-thickness: 3px; text-underline-offset: .12em; }
  [data-theme="brutal"] a:hover { background: var(--accent); color: var(--accent-fg); text-decoration: none; }
  [data-theme="brutal"] .row, [data-theme="brutal"] .kv > dt, [data-theme="brutal"] .kv > dd, [data-theme="brutal"] .event, [data-theme="brutal"] .empty { border-color: var(--rule); border-width: 2px; }
  [data-theme="brutal"] .table thead th, [data-theme="brutal"] .table tbody th, [data-theme="brutal"] .table tbody td, [data-theme="brutal"] .table tbody tr { border-color: var(--rule); border-bottom-width: 2px; }
  [data-theme="brutal"] .row-name { font-weight: 700; }
  [data-theme="brutal"] .state-value { font-weight: 900; text-transform: uppercase; letter-spacing: -.02em; font-size: 1.75rem; }
  [data-theme="brutal"] .btn { font-weight: 900; text-transform: uppercase; letter-spacing: .04em; border-radius: var(--radius); box-shadow: var(--shadow); transition: transform var(--motion), box-shadow var(--motion), background var(--motion), color var(--motion); }
  [data-theme="brutal"] .btn:hover:not(:disabled), [data-theme="brutal"] .btn:focus-visible { background: var(--panel); color: var(--fg); }
  [data-theme="brutal"] .btn:active:not(:disabled) { transform: translate(.375rem, .375rem); box-shadow: none; background: var(--panel); }
  [data-theme="brutal"] .btn:disabled { box-shadow: none; }
  [data-theme="brutal"] .btn-primary { background: var(--accent); color: var(--accent-fg); border-color: var(--rule); }
  [data-theme="brutal"] .btn-primary:hover:not(:disabled), [data-theme="brutal"] .btn-primary:focus-visible { background: var(--accent); color: var(--accent-fg); }
  [data-theme="brutal"] input, [data-theme="brutal"] select, [data-theme="brutal"] textarea { border-radius: var(--radius); }
  [data-theme="brutal"] .chip { border-radius: var(--radius); box-shadow: var(--shadow); }
  [data-theme="brutal"] .chip > * + * { border-inline-start: var(--rule-w) solid var(--rule); }
`,
  rules: { shadows: "hard-offset", radii: "any", gradients: false },
  components: ["ht-switch", "ht-switch-row", "ht-button", "ht-light", "ht-status", "ht-sensor", "ht-sensor-row", "ht-television"],
  entry: "themes/brutal/index.ts",
} as const satisfies ThemeDefinition;
