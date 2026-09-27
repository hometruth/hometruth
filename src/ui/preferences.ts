/**
 * Per-browser UI preferences: theme, appearance (light/dark/auto), and
 * language. Stored in one cookie as a query string; site defaults come from
 * `HOMETRUTH_THEME`, `HOMETRUTH_SCHEME`, and `HOMETRUTH_LOCALE`, and the
 * language otherwise follows `Accept-Language`.
 */
import { isLocale, negotiateLocale, type Locale } from "./i18n";
import { DEFAULT_THEME, THEME_IDS, isTheme, type Theme } from "./themes";

/** The theme ids, in registry order; the footer's picker iterates them. */
export const THEMES: readonly Theme[] = THEME_IDS;
export { isTheme, type Theme };
export const SCHEMES = ["auto", "light", "dark"] as const;
export type Scheme = (typeof SCHEMES)[number];

export const PREFERENCES_COOKIE = "hometruth_ui";
export const PREFERENCES_PATH = "/ui/preferences";

export interface UiPreferences {
  readonly theme: Theme;
  readonly scheme: Scheme;
  readonly locale: Locale;
}

export function isScheme(value: unknown): value is Scheme {
  return typeof value === "string" && (SCHEMES as readonly string[]).includes(value);
}

/** The recognised fields of a form body or cookie; anything else is ignored. */
export function pickPreferences(fields: Readonly<Record<string, string | undefined>>): Partial<UiPreferences> {
  return {
    ...(isTheme(fields.theme) ? { theme: fields.theme } : {}),
    ...(isScheme(fields.scheme) ? { scheme: fields.scheme } : {}),
    ...(isLocale(fields.locale) ? { locale: fields.locale } : {}),
  };
}

export function parsePreferencesCookie(value: string | undefined): Partial<UiPreferences> {
  if (!value) return {};
  const fields: Record<string, string> = {};
  for (const [key, entry] of new URLSearchParams(value)) fields[key] = entry;
  return pickPreferences(fields);
}

export function serializePreferencesCookie(preferences: UiPreferences): string {
  return new URLSearchParams({ theme: preferences.theme, scheme: preferences.scheme, locale: preferences.locale }).toString();
}

export interface PreferenceSources {
  readonly cookie?: string | undefined;
  readonly acceptLanguage?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export function resolvePreferences({ cookie, acceptLanguage, env = {} }: PreferenceSources): UiPreferences {
  const chosen = parsePreferencesCookie(cookie);
  const defaults = pickPreferences({
    theme: env.HOMETRUTH_THEME?.trim().toLowerCase(),
    scheme: env.HOMETRUTH_SCHEME?.trim().toLowerCase(),
    locale: env.HOMETRUTH_LOCALE?.trim().toLowerCase(),
  });
  return {
    theme: chosen.theme ?? defaults.theme ?? DEFAULT_THEME,
    scheme: chosen.scheme ?? defaults.scheme ?? "auto",
    locale: negotiateLocale(acceptLanguage, chosen.locale ?? defaults.locale),
  };
}
