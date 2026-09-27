/**
 * Message formatting shared by the server (this module) and the browser
 * (`FORMAT_MESSAGE_JS`, the same function as source text). A message may
 * hold `{name}` placeholders and `{count, plural, one {# thing} other {# things}}`
 * plural blocks; `#` inside a variant is the number, formatted for the locale.
 */
export type MessageParams = Readonly<Record<string, string | number>>;

const PLACEHOLDER = /\{(\w+)(?:,\s*plural,\s*((?:[^{}]|\{[^{}]*\})*))?\}/gu;
const VARIANT = /(=\d+|\w+)\s*\{([^{}]*)\}/gu;

export function formatMessage(message: string, params: MessageParams = {}, locale = "en"): string {
  return message.replace(PLACEHOLDER, (whole, name: string, plural?: string) => {
    const value = params[name];
    if (plural === undefined) return value === undefined ? whole : String(value);
    const count = typeof value === "number" ? value : Number(value ?? 0);
    const variants = new Map<string, string>();
    for (const match of plural.matchAll(VARIANT)) variants.set(match[1]!, match[2]!);
    const chosen = variants.get(`=${count}`) ?? variants.get(new Intl.PluralRules(locale).select(count)) ?? variants.get("other") ?? "";
    return chosen.replaceAll("#", new Intl.NumberFormat(locale).format(count));
  });
}

/** The browser copy of `formatMessage`; kept byte-for-byte equivalent by `format.test.ts`. */
export const FORMAT_MESSAGE_JS = String.raw`function formatMessage(message, params, locale) {
  params = params || {}; locale = locale || "en";
  return message.replace(/\{(\w+)(?:,\s*plural,\s*((?:[^{}]|\{[^{}]*\})*))?\}/g, function (whole, name, plural) {
    var value = params[name];
    if (plural === undefined) return value === undefined ? whole : String(value);
    var count = typeof value === "number" ? value : Number(value == null ? 0 : value);
    var variants = {};
    plural.replace(/(=\d+|\w+)\s*\{([^{}]*)\}/g, function (all, key, text) { variants[key] = text; return all; });
    var chosen = variants["=" + count];
    if (chosen === undefined) chosen = variants[new Intl.PluralRules(locale).select(count)];
    if (chosen === undefined) chosen = variants.other || "";
    return chosen.split("#").join(new Intl.NumberFormat(locale).format(count));
  });
}`;
