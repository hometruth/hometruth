import type { ValidateFunction } from "ajv";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { SecureHeadersVariables } from "hono/secure-headers";
import type { Principal } from "../auth/scope";
import type { ErrorResponse } from "../schemas";
import { createTranslator } from "../ui/i18n";
import { PREFERENCES_COOKIE, resolvePreferences, type UiPreferences } from "../ui/preferences";
import { createPageContext, type PageContext, type PageState } from "../ui/shell";
import { describeValidationErrors, validators } from "../validation";

/** Which optional site features exist; set once by the app so every page's navigation agrees. */
export interface UiFeatures {
  readonly isolation: boolean;
  /** Whether this request's token may administer the site; hides what it could not open. */
  readonly admin: boolean;
}

export type AppEnvironment = { Variables: SecureHeadersVariables & {
  uiFeatures?: UiFeatures;
  pageState?: PageState;
  elementApi?: PageContext["elementApi"];
  tagEditor?: PageContext["tagEditor"];
  rooms?: readonly string[];
  /** Who is making this request, set by the auth guard. Absent only on a public route. */
  principal?: Principal;
} };

/** The worker generation, the cache key in browser module URLs; `dev` outside the supervisor. */
export function assetVersion(): string {
  return process.env.HOMETRUTH_RELOAD_VERSION ?? "dev";
}
export const SITE_TITLE = "HomeTruth";

/** The browser's UI preferences for this request: the cookie, else the site's env defaults, else `Accept-Language`. */
export function uiPreferences(context: Context<AppEnvironment>, env: Readonly<Record<string, string | undefined>> = process.env): UiPreferences {
  return resolvePreferences({
    cookie: getCookie(context, PREFERENCES_COOKIE),
    acceptLanguage: context.req.header("accept-language"),
    env,
  });
}

/** Everything a page render needs from the request. */
export function pageContext(context: Context<AppEnvironment>): PageContext {
  const preferences = uiPreferences(context);
  return createPageContext({
    nonce: context.get("secureHeadersNonce") ?? "",
    siteTitle: SITE_TITLE,
    preferences,
    i18n: createTranslator(preferences.locale),
    path: new URL(context.req.url).pathname + new URL(context.req.url).search,
    features: context.get("uiFeatures") ?? { isolation: false, admin: false },
    ...(context.get("pageState") ? { state: context.get("pageState")! } : {}),
    assetVersion: assetVersion(),
    rooms: context.get("rooms") ?? [],
    ...(context.get("tagEditor") ? { tagEditor: context.get("tagEditor")! } : {}),
    ...(context.get("elementApi") ? { elementApi: context.get("elementApi")! } : {}),
  });
}

export function checkedJson<T>(
  context: Context<AppEnvironment>,
  validate: ValidateFunction<T>,
  body: T,
  status: ContentfulStatusCode = 200,
) {
  if (!validate(body)) {
    throw new Error(`Invalid server response: ${describeValidationErrors(validate.errors)}`);
  }
  return context.json(body, status);
}

export function errorJson(
  context: Context<AppEnvironment>,
  status: ContentfulStatusCode,
  code: string,
  message: string,
  detail?: string,
) {
  const trimmedDetail = detail?.trim().slice(0, 500);
  const body: ErrorResponse = { error: { code, message, ...(trimmedDetail ? { detail: trimmedDetail } : {}) } };
  return checkedJson(context, validators.errorResponse, body, status);
}

export function errorDetail(error: unknown): string | undefined {
  const cause = (error as { cause?: unknown } | null)?.cause;
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  if (cause !== undefined && cause !== null) return String(cause);
  return undefined;
}

export function isAllowedChangeOrigin(context: Context<AppEnvironment>, origin: string): boolean {
  try {
    const originUrl = new URL(origin);
    const requestUrl = new URL(context.req.url);
    if (originUrl.origin === requestUrl.origin) return true;

    // The local Dev Hub presents the app through a stable hostname while the
    // Bun server may be bound to a different loopback port.
    return !process.env.HOMETRUTH_PUBLIC_ORIGIN
      && originUrl.protocol === "http:" && originUrl.hostname === "hometruth.localhost";
  } catch {
    return false;
  }
}

export async function requestJson(context: Context<AppEnvironment>): Promise<unknown> {
  const body = await context.req.text();
  if (!body.trim()) return {};
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}
