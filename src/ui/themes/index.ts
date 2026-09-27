/**
 * The theme registry. Static so `Theme` stays a typed union for the cookie,
 * the env default, and `PageContext`; adding a theme is one folder and one
 * line here.
 */
import { brutal } from "./brutal/theme.ts";
import { euclid } from "./euclid/theme.ts";
import { swiss } from "./swiss/theme.ts";
import type { ThemeDefinition } from "./theme.ts";

export const THEMES = { euclid, swiss, brutal } as const satisfies Record<string, ThemeDefinition>;
export type Theme = keyof typeof THEMES;
export const THEME_IDS = Object.keys(THEMES) as readonly Theme[];
export const DEFAULT_THEME: Theme = "euclid";

export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && Object.hasOwn(THEMES, value);
}

export function themeById(id: Theme): ThemeDefinition {
  return THEMES[id];
}

export { COLOR_TOKENS, SHAPE_TOKENS, ruleViolations, scaleCss, themeCss } from "./theme.ts";
export type { ColorToken, ShapeToken, ThemeDefinition, ThemeRules } from "./theme.ts";
