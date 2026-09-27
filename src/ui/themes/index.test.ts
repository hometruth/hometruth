import { describe, expect, test } from "bun:test";
import { isTheme as prefersTheme, THEMES as THEME_LIST } from "../preferences.ts";
import { COLOR_TOKENS, DEFAULT_THEME, isTheme, ruleViolations, scaleCss, SHAPE_TOKENS, THEME_IDS, THEMES, themeById, themeCss, type ThemeDefinition } from "./index.ts";

const TAGS = ["ht-switch", "ht-switch-row", "ht-button", "ht-light", "ht-status", "ht-sensor", "ht-sensor-row", "ht-television"];

/** The Euclid blocks exactly as `src/ui/shell.ts` TOKENS_CSS wrote them before the registry. */
const EUCLID_BEFORE = {
  light: `
    color-scheme: light;
    --font-body: "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, "Times New Roman", serif;
    --text: 17px;
    --rule-w: 1.5px; --mark-radius: 50%;
    --bg: #F4EBD8; --panel: #EBDFC6; --fg: #191816; --fg-2: #5F584D;
    --rule: #191816; --hair: rgba(25, 24, 22, .24);
    --accent: #0E558A; --accent-fg: #F4EBD8;
    --ok: #0E558A; --warn: #7A5806; --warn-mark: #E4A412; --bad: #C43C35;
    --ok-soft: rgba(14, 85, 138, .10); --bad-soft: rgba(196, 60, 53, .10); --warn-soft: rgba(228, 164, 18, .16);
    --stage: #191816; --stage-fg: #EFE2C9;`,
  dark: `
    color-scheme: dark;
    --bg: #191816; --panel: #242220; --fg: #EFE2C9; --fg-2: #B3A78E;
    --rule: #EFE2C9; --hair: rgba(239, 226, 201, .24);
    --accent: #7FB2DE; --accent-fg: #191816;
    --ok: #7FB2DE; --warn: #E4A412; --warn-mark: #E4A412; --bad: #E07770;
    --ok-soft: rgba(127, 178, 222, .14); --bad-soft: rgba(224, 119, 112, .14); --warn-soft: rgba(228, 164, 18, .14);
    --stage: #0E0D0C; --stage-fg: #EFE2C9;`,
};

const EUCLID_CHARACTER_BEFORE = [
  '[data-theme="euclid"] h2, [data-theme="euclid"] legend { font-variant-caps: all-small-caps; letter-spacing: .06em; font-size: 1.0625rem; }',
  '[data-theme="euclid"] .brand { font-variant-caps: all-small-caps; letter-spacing: .08em; font-size: 1.125rem; }',
  '[data-theme="euclid"] .site-nav { font-variant-caps: all-small-caps; letter-spacing: .06em; font-size: 1.0625rem; }',
  '[data-theme="euclid"] h1 { font-size: 2.5rem; }',
  '[data-theme="euclid"] .state-value { font-size: 1.75rem; }',
];

/** `name: value` pairs of one rule body, whatever the line breaks. */
function parseDeclarations(body: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const declaration of body.split(";")) {
    const at = declaration.indexOf(":");
    if (at < 0) continue;
    map.set(declaration.slice(0, at).trim(), declaration.slice(at + 1).trim());
  }
  return map;
}

/** The body of the rule that starts with `selector {` in `css`; the caller checks it exists. */
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) return "";
  const open = css.indexOf("{", start);
  return css.slice(open + 1, css.indexOf("}", open));
}

function luminance(hex: string): number {
  const channel = (part: string): number => {
    const c = parseInt(part, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(hex.slice(1, 3)) + 0.7152 * channel(hex.slice(3, 5)) + 0.0722 * channel(hex.slice(5, 7));
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("theme registry", () => {
  test("ids equal keys, entries and components follow the folder recipe", () => {
    for (const key of THEME_IDS) {
      const theme: ThemeDefinition = themeById(key);
      expect(theme.id).toBe(key);
      expect(theme.entry).toBe(`themes/${key}/index.ts`);
      expect([...theme.components]).toEqual(TAGS);
    }
    expect(THEME_IDS).toEqual(["euclid", "swiss", "brutal"]);
    expect(DEFAULT_THEME).toBe("euclid");
    expect(themeById("swiss")).toBe(THEMES.swiss);
  });

  test("every theme carries every colour token in both schemes and every shape token", () => {
    for (const theme of Object.values(THEMES)) {
      for (const token of COLOR_TOKENS) {
        expect(theme.light[token]).toMatch(/\S/u);
        expect(theme.dark[token]).toMatch(/\S/u);
      }
      for (const token of SHAPE_TOKENS) expect(theme.shape[token]).toMatch(/\S/u);
    }
  });

  test("text on ground and accent text on accent clear 4.5:1 in both schemes", () => {
    for (const theme of Object.values(THEMES)) {
      for (const scheme of [theme.light, theme.dark]) {
        expect(contrast(scheme.fg, scheme.bg)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(scheme["accent-fg"], scheme.accent)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(scheme["fg-2"], scheme.bg)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test("each theme's character and shape tokens keep its own rules", () => {
    for (const theme of Object.values(THEMES)) expect(ruleViolations(theme)).toEqual([]);
    expect(THEMES.euclid.rules).toEqual({ shadows: "none", radii: "marks-only", gradients: false });
    expect(THEMES.swiss.rules).toEqual({ shadows: "none", radii: "none", gradients: false });
    expect(THEMES.brutal.rules).toEqual({ shadows: "hard-offset", radii: "any", gradients: false });
  });

  test("ruleViolations catches a shadow or radius a theme's rules forbid", () => {
    const loud = { ...THEMES.swiss, character: '[data-theme="swiss"] .btn { box-shadow: 0 2px 4px #000; border-radius: 4px; }' };
    expect(ruleViolations(loud)).toHaveLength(2);
    const railed = { ...THEMES.swiss, character: '[data-theme="swiss"] .log { box-shadow: inset 3px 0 var(--rule); border-radius: var(--radius); }' };
    expect(ruleViolations(railed)).toEqual([]);
    const shaped = { ...THEMES.swiss, shape: { ...THEMES.swiss.shape, radius: "4px" } };
    expect(ruleViolations(shaped)).toHaveLength(1);
  });

  test("the character is written against [data-theme] selectors only", () => {
    for (const theme of Object.values(THEMES)) {
      const selectors = theme.character.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("/*"));
      for (const line of selectors) {
        for (const selector of line.slice(0, line.indexOf("{")).split(",")) expect(selector.trim()).toStartWith(`[data-theme="${theme.id}"]`);
      }
    }
  });
});

describe("themeCss", () => {
  const css = themeCss(THEMES.euclid);

  test("emits the four blocks the shell used to hand-write", () => {
    expect(css).toContain('[data-theme="euclid"] {');
    expect(css).toContain('[data-theme="euclid"][data-scheme="dark"] {');
    expect(css).toContain('@media (prefers-color-scheme: dark) {\n    [data-theme="euclid"][data-scheme="auto"] {');
    for (const rule of EUCLID_CHARACTER_BEFORE) expect(css).toContain(rule);
    expect(css.indexOf('[data-theme="euclid"] h2')).toBeGreaterThan(css.indexOf("@media"));
  });

  test("reproduces Euclid's light declarations, adding only --radius, --shadow and --live", () => {
    const before = parseDeclarations(EUCLID_BEFORE.light);
    const after = parseDeclarations(ruleBody(css, '[data-theme="euclid"]'));
    for (const [name, value] of before) expect([name, after.get(name)]).toEqual([name, value]);
    expect([...after.keys()].filter((name) => !before.has(name))).toEqual(["--radius", "--shadow", "--live"]);
    expect(after.get("--radius")).toBe("0");
    expect(after.get("--shadow")).toBe("none");
    // Live ink is mixed from the theme's own tokens, so a theme never restates a colour to get it.
    expect(after.get("--live")).toBe("color-mix(in srgb, var(--fg) 80%, var(--accent))");
  });

  test("reproduces Euclid's dark declarations under both dark selectors", () => {
    const before = parseDeclarations(EUCLID_BEFORE.dark);
    for (const selector of ['[data-theme="euclid"][data-scheme="dark"]', '[data-theme="euclid"][data-scheme="auto"]']) {
      const after = parseDeclarations(ruleBody(css, selector));
      expect(after.get("--live")).toBe("color-mix(in srgb, var(--fg) 80%, var(--accent))");
      after.delete("--live");
      expect(after).toEqual(before);
    }
  });

  test("Swiss sets its switch custom properties in both schemes", () => {
    const swiss = themeCss(THEMES.swiss);
    for (const selector of ['[data-theme="swiss"]', '[data-theme="swiss"][data-scheme="dark"]', '[data-theme="swiss"][data-scheme="auto"]']) {
      const body = parseDeclarations(ruleBody(swiss, selector));
      expect(body.get("--ht-switch-value-weight")).toBe("700");
      expect(body.get("--ht-switch-value-tracking")).toBe("-.02em");
      expect(body.get("--ht-switch-value-size")).toBe("1.5rem");
    }
  });

  test("Brutal's dark scheme recolours the shadow with the accent", () => {
    const brutal = themeCss(THEMES.brutal);
    expect(parseDeclarations(ruleBody(brutal, '[data-theme="brutal"]')).get("--shadow")).toBe(".375rem .375rem 0 var(--rule)");
    expect(parseDeclarations(ruleBody(brutal, '[data-theme="brutal"][data-scheme="dark"]')).get("--shadow")).toBe(".375rem .375rem 0 var(--accent)");
    expect(parseDeclarations(ruleBody(brutal, '[data-theme="brutal"]')).get("--rule-w")).toBe("3px");
  });

  test("only the requested theme's tokens appear", () => {
    expect(css).not.toContain('[data-theme="swiss"]');
    expect(css).not.toContain('[data-theme="brutal"]');
  });

  test("scaleCss is the shared :root block", () => {
    const root = parseDeclarations(ruleBody(scaleCss(), ":root"));
    expect(root.get("--mark")).toBe(".6rem");
    expect(root.get("--page-wide")).toBe("72rem");
    expect(root.get("--motion")).toBe("180ms cubic-bezier(.2, .7, .2, 1)");
    expect([...root.keys()]).toEqual(["--font-mono", "--s1", "--s2", "--s3", "--s4", "--s5", "--s6", "--s7", "--page", "--page-wide", "--measure", "--mark", "--motion"]);
  });
});

describe("preferences", () => {
  test("accept every registered theme and nothing else", () => {
    for (const id of THEME_IDS) {
      expect(isTheme(id)).toBe(true);
      expect(prefersTheme(id)).toBe(true);
    }
    expect(THEME_LIST).toEqual(THEME_IDS);
    for (const other of ["", "EUCLID", "bauhaus", 1, null, undefined, "toString", "__proto__"]) {
      expect(isTheme(other)).toBe(false);
      expect(prefersTheme(other)).toBe(false);
    }
  });
});
