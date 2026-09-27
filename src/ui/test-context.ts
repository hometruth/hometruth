import { createTranslator, type Locale } from "./i18n";
import { createPageContext, type PageContext } from "./shell";

/** A page context for tests: English, the Euclid theme, no optional features unless asked. */
export function testPageContext(options: { nonce?: string; locale?: Locale; path?: string; isolation?: boolean; admin?: boolean } = {}): PageContext {
  const locale = options.locale ?? "en";
  return createPageContext({
    nonce: options.nonce ?? "test-nonce",
    siteTitle: "HomeTruth",
    preferences: { theme: "euclid", scheme: "auto", locale },
    i18n: createTranslator(locale),
    path: options.path ?? "/",
    features: { isolation: options.isolation ?? false, admin: options.admin ?? false },
  });
}
