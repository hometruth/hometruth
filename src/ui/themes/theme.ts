/**
 * What a theme is, server side: complete colour records for light and dark,
 * the shape tokens, the character CSS that gives the vocabulary its voice,
 * machine-readable rules a test holds the character to, and where the
 * browser entry lives. `themeCss()` turns one definition into the token
 * blocks the shell used to hand-write, so adding a theme is adding a folder.
 */

/** Every colour a page may use; the shell's vocabulary and the elements read only these. */
export const COLOR_TOKENS = [
  "bg", "panel", "fg", "fg-2",
  "rule", "hair",
  "accent", "accent-fg",
  "ok", "warn", "warn-mark", "bad",
  "ok-soft", "bad-soft", "warn-soft",
  "stage", "stage-fg",
  "live",
] as const;
export type ColorToken = (typeof COLOR_TOKENS)[number];

/** Type, rule weight, and the two shape tokens (`radius`, `shadow`) a colours-and-shapes theme sets without HTML. */
export const SHAPE_TOKENS = ["font-body", "text", "rule-w", "mark-radius", "radius", "shadow"] as const;
export type ShapeToken = (typeof SHAPE_TOKENS)[number];

export type ColorTokens = Readonly<Record<ColorToken, string>>;
export type ShapeTokens = Readonly<Record<ShapeToken, string>>;
/** One scheme's colours; a scheme may also re-set a shape token (a dark theme's shadow takes another colour). */
export type SchemeTokens = ColorTokens & Partial<ShapeTokens>;

export interface ThemeRules {
  /** `none`: no box-shadow at all; `inset-rails`: inset only (a rule drawn as a shadow); `hard-offset`: solid offset shadows. */
  readonly shadows: "none" | "inset-rails" | "hard-offset";
  /** `none`: everything square; `marks-only`: only `--mark-radius` curves; `any`: `--radius` may be non-zero. */
  readonly radii: "none" | "marks-only" | "any";
  readonly gradients: boolean;
}

export interface ThemeDefinition {
  readonly id: string;
  readonly light: SchemeTokens;
  readonly dark: SchemeTokens;
  readonly shape: ShapeTokens;
  /** CSS written against `[data-theme="<id>"]` selectors; appended after the vocabulary. */
  readonly character: string;
  readonly rules: ThemeRules;
  /** The `ht-*` tags the browser entry defines. */
  readonly components: readonly string[];
  /** Path under `src/ui` of the browser entry, served by `GET /ui/:version/<entry>`. */
  readonly entry: string;
  /** Component custom properties (`--ht-*`) a theme sets per scheme, for elements it reuses from another theme. */
  readonly extra?: { readonly light?: Readonly<Record<string, string>>; readonly dark?: Readonly<Record<string, string>> };
}

/** The scale every theme shares; it moved verbatim from the shell's token block. */
export function scaleCss(): string {
  return String.raw`
  :root {
    --font-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    --s1: .25rem; --s2: .5rem; --s3: .75rem; --s4: 1rem; --s5: 1.5rem; --s6: 2.5rem; --s7: 4rem;
    --page: 52rem; --page-wide: 72rem; --measure: 68ch;
    --mark: .6rem;
    --motion: 180ms cubic-bezier(.2, .7, .2, 1);
  }
`;
}

function declarations(entries: readonly (readonly [string, string])[], indent: string): string {
  return entries.map(([name, value]) => `${indent}${name}: ${value};`).join("\n");
}

function shapeEntries(theme: ThemeDefinition, scheme: SchemeTokens, all: boolean): (readonly [string, string])[] {
  return SHAPE_TOKENS.flatMap((token) => {
    const value = scheme[token] ?? (all ? theme.shape[token] : undefined);
    return value === undefined ? [] : [[`--${token}`, value] as const];
  });
}

function colorEntries(scheme: SchemeTokens): (readonly [string, string])[] {
  return COLOR_TOKENS.map((token) => [`--${token}`, scheme[token]] as const);
}

function extraEntries(extra: Readonly<Record<string, string>> | undefined): (readonly [string, string])[] {
  return Object.entries(extra ?? {}).map(([name, value]) => [name, value] as const);
}

/** The light block carries the shape tokens; a dark block only what dark changes. */
function block(theme: ThemeDefinition, which: "light" | "dark", indent: string): string {
  const scheme = theme[which];
  const entries = [
    ["color-scheme", which] as const,
    ...shapeEntries(theme, scheme, which === "light"),
    ...colorEntries(scheme),
    ...extraEntries(theme.extra?.[which]),
  ];
  return declarations(entries, `${indent}  `);
}

/**
 * The four blocks the shell used to hand-write per theme: light, explicit
 * dark, dark under `auto` when the OS prefers it, then the character.
 */
export function themeCss(theme: ThemeDefinition): string {
  const selector = `[data-theme="${theme.id}"]`;
  return [
    `  ${selector} {\n${block(theme, "light", "  ")}\n  }`,
    `  ${selector}[data-scheme="dark"] {\n${block(theme, "dark", "  ")}\n  }`,
    `  @media (prefers-color-scheme: dark) {\n    ${selector}[data-scheme="auto"] {\n${block(theme, "dark", "    ")}\n    }\n  }`,
    theme.character,
  ].join("\n") + "\n";
}

const DECLARATION = /(box-shadow|border-radius)\s*:\s*([^;}]+)/gu;

/** Where a theme's CSS or shape tokens contradict its own rules; empty when it keeps its word. */
export function ruleViolations(theme: ThemeDefinition): string[] {
  const found: string[] = [];
  const { rules, shape, character } = theme;
  if (rules.shadows === "none" && shape.shadow !== "none") found.push(`shape.shadow is "${shape.shadow}" but shadows are "none"`);
  if (rules.radii !== "any" && shape.radius !== "0") found.push(`shape.radius is "${shape.radius}" but radii are "${rules.radii}"`);
  if (rules.radii === "none" && shape["mark-radius"] !== "0") found.push(`shape.mark-radius is "${shape["mark-radius"]}" but radii are "none"`);
  if (!rules.gradients && /gradient\(/u.test(character)) found.push("character draws a gradient");
  for (const match of character.matchAll(DECLARATION)) {
    const property = match[1];
    const value = (match[2] ?? "").trim();
    if (property === "box-shadow" && rules.shadows !== "hard-offset" && value !== "none" && !value.startsWith("inset")) {
      found.push(`character sets box-shadow: ${value} but shadows are "${rules.shadows}"`);
    }
    if (property === "border-radius" && rules.radii !== "any" && !["0", "var(--mark-radius)", "var(--radius)"].includes(value)) {
      found.push(`character sets border-radius: ${value} but radii are "${rules.radii}"`);
    }
  }
  return found;
}
