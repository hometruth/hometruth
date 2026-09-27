import { de } from "./de";
import { en, type MessageKey, type Messages } from "./en";
import { es } from "./es";
import { formatMessage, type MessageParams } from "./format";
import { fr } from "./fr";

export type { MessageKey, Messages } from "./en";
export { formatMessage, FORMAT_MESSAGE_JS } from "./format";

export const SUPPORTED_LOCALES = ["en", "de", "fr", "es"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

/** The language's own name, for the language menu. */
export const LOCALE_NAMES: Readonly<Record<Locale, string>> = { en: "English", de: "Deutsch", fr: "Français", es: "Español" };

const RTL_LOCALES: ReadonlySet<string> = new Set(["ar", "he", "fa", "ur"]);

/** Every shipped catalog; `Messages` is a complete record, so a missing key fails the type check. */
const catalogs: Readonly<Record<Locale, Messages>> = { en, de, fr, es };

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * Pick a locale: an explicit choice wins, then the best `Accept-Language`
 * match by primary subtag and q-value, then English.
 */
export function negotiateLocale(acceptLanguage: string | undefined, preferred?: string): Locale {
  if (isLocale(preferred)) return preferred;
  if (!acceptLanguage) return DEFAULT_LOCALE;
  const ranked = acceptLanguage.split(",").map((part, index) => {
    const [tag = "", ...params] = part.trim().split(";");
    const q = params.map((param) => param.trim()).find((param) => param.startsWith("q="));
    const weight = q ? Number(q.slice(2)) : 1;
    return { tag: tag.toLowerCase().split("-")[0] ?? "", weight: Number.isFinite(weight) ? weight : 0, index };
  }).filter((entry) => entry.weight > 0).sort((a, b) => b.weight - a.weight || a.index - b.index);
  for (const entry of ranked) if (isLocale(entry.tag)) return entry.tag;
  return DEFAULT_LOCALE;
}

export interface Translator {
  readonly locale: Locale;
  readonly dir: "ltr" | "rtl";
  t(key: MessageKey, params?: MessageParams): string;
  /** A message that may not exist (a key built from data); undefined when the catalog has no such key. */
  lookup(key: string, params?: MessageParams): string | undefined;
  /** Every message whose key starts with one of the prefixes, for a page's browser script. */
  messages(prefixes: readonly string[]): Record<string, string>;
  time(value: string | number | Date): string;
  dateTime(value: string | number | Date): string;
  number(value: number, options?: Intl.NumberFormatOptions): string;
}

const translators = new Map<Locale, Translator>();

export function createTranslator(locale: Locale): Translator {
  const cached = translators.get(locale);
  if (cached) return cached;
  const dictionaries = new Map<string, Record<string, string>>();
  const numbers = new Map<string, Intl.NumberFormat>();
  const messages = catalogs[locale];
  const timeFormat = new Intl.DateTimeFormat(locale, { timeStyle: "medium" });
  const dateTimeFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const translator: Translator = {
    locale,
    dir: RTL_LOCALES.has(locale) ? "rtl" : "ltr",
    t: (key, params) => formatMessage(messages[key] ?? en[key] ?? key, params, locale),
    lookup: (key, params) => {
      if (!Object.hasOwn(en, key)) return undefined;
      const known = key as MessageKey;
      return formatMessage(messages[known] ?? en[known], params, locale);
    },
    messages: (prefixes) => {
      const key = [...new Set(prefixes)].sort().join("\0");
      let dictionary = dictionaries.get(key);
      if (!dictionary) {
        dictionary = Object.fromEntries((Object.keys(en) as MessageKey[]).filter(key => prefixes.some(prefix => key.startsWith(prefix))).map(key => [key, messages[key] ?? en[key]]));
        dictionaries.set(key, dictionary);
      }
      return dictionary;
    },
    time: (value) => timeFormat.format(new Date(value)),
    dateTime: (value) => dateTimeFormat.format(new Date(value)),
    number: (value, options) => {
      const key = JSON.stringify(options ?? {});
      let formatter = numbers.get(key);
      if (!formatter) { formatter = new Intl.NumberFormat(locale, options); numbers.set(key, formatter); }
      return formatter.format(value);
    },
  };
  translators.set(locale, translator);
  return translator;
}
