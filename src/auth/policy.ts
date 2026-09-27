import { API_FILES, API_PAGE_PATTERNS } from "../element-api/paths";
/**
 * Which permission each route needs, and what it needs it *on*.
 *
 * This table is the authorization surface. It is a table and not a sprinkling
 * of checks inside handlers for one reason: a handler you forgot to annotate
 * is an open door and looks exactly like a handler that is meant to be open.
 * A route missing from this table has no policy, and no policy means denied —
 * and `policy.test.ts` walks every route Hono has registered and fails if any
 * of them is unlisted. Adding a route without deciding its permission is a
 * build failure, not a security incident.
 *
 * On targets, four of the five are obvious; the fifth is a judgement call worth
 * writing down. `/api/camera/*` is the raw camera-service API, and its `:id` is
 * a *vendor* id — a cloud serial from discovery — not a site device id. There
 * is no sound way to check a site-scoped subject against it, so the whole
 * family is `site`: reachable only by a token whose subject is every device.
 * The modelled routes (`/api/cameras/:id`, `/api/devices/:id`) are the ones a
 * narrow token uses, and they key on real device ids.
 */
import type { Permission } from "./model";

/** What the required permission is checked against. */
export type PolicyTarget =
  /** The site itself: only a subject of `all` reaches it. */
  | { readonly kind: "site" }
  /** A device named by a path parameter. */
  | { readonly kind: "device"; readonly param: string }
  /** A group named by a path parameter; every member must be in reach. */
  | { readonly kind: "group"; readonly param: string }
  /** An element key in a path parameter; a device key narrows, anything else is site. */
  | { readonly kind: "element"; readonly param: string }
  /** A page URL, resolved through the site's page directory to what it shows. */
  | { readonly kind: "page" }
  /**
   * A listing, and a promise: the handler narrows its rows to what this
   * principal reaches. Only the verb is checked here. A route that enumerates
   * the house without narrowing must be `site`, not this.
   */
  | { readonly kind: "listing" };

export interface RoutePolicy {
  readonly permission: Permission;
  readonly target: PolicyTarget;
}

/** No credential required. Every entry here is a deliberate hole; keep it short. */
export const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  // Liveness only: runtime name, version, timestamp. No site data. The
  // supervisor and the Dev Hub both gate on it before a worker is admitted.
  "GET /api/health",
  // The credential exchange itself, and the page that performs it.
  "GET /sign-in",
  "POST /api/auth/sign-in",
  // Theme modules: the same static, type-stripped UI code for every caller,
  // carrying no site data. The sign-in page needs them to render like the rest.
  "GET /ui/:version/*",
  "GET /ht.ts",
  "GET /ht.js",
  // The theme/appearance/language cookie, so sign-in honours the same choice.
  "POST /ui/preferences",
]);

const site = { kind: "site" } as const;
const page = { kind: "page" } as const;
const listing = { kind: "listing" } as const;
const device = (param = "id") => ({ kind: "device", param } as const);
const group = (param = "id") => ({ kind: "group", param } as const);
const element = (param = "key") => ({ kind: "element", param } as const);

const p = (permission: Permission, target: PolicyTarget): RoutePolicy => ({ permission, target });

/**
 * `METHOD /route/pattern` → policy, using Hono's own registered pattern so the
 * completeness test can compare the two lists directly.
 */
export const ROUTE_POLICIES: Readonly<Record<string, RoutePolicy>> = {
  "GET /health": p("read", site),
  "GET /api/health/report": p("read", site),
  "GET /api/devices/:id/health": p("read", device()),
  "POST /api/devices/:id/health/check": p("read", device()),
  "GET /api/services/:id/health": p("read", site),
  "POST /api/services/:id/health/check": p("read", site),
  ...Object.fromEntries(API_PAGE_PATTERNS.flatMap(pattern => {
    const target = pattern === "/elements/:key" ? element() : pattern.startsWith("/schemas/") ? listing : !pattern.includes(":") ? site : page;
    return API_FILES.map(file => [`GET ${pattern}/${file}`, p("read", target)]);
  })),
  // ---- Session ------------------------------------------------------------
  "POST /api/auth/sign-out": p("read", listing),
  "GET /api/auth/whoami": p("read", listing),

  // ---- Tokens: administering access is itself site administration ---------
  "GET /settings/tokens": p("admin", site),
  "GET /api/tokens": p("admin", site),
  "POST /api/tokens": p("admin", site),
  "POST /api/tokens/:kid/revoke": p("admin", site),

  // ---- Catalogs: software, not house -------------------------------------
  "GET /api/models": p("read", listing),
  "GET /api/schemas": p("read", listing),
  "GET /api/event-types": p("read", listing),
  "GET /api/filters": p("read", site),
  "GET /api/filters/:id": p("read", site),
  "POST /api/filters": p("write", site),
  "PUT /api/filters/:id": p("write", site),
  "DELETE /api/filters/:id": p("write", site),
  "GET /schemas": p("read", listing),
  "GET /schemas/*": p("read", listing),
  // The API description enumerates this install's device ids, so it is read,
  // not public — and the handler narrows those enumerations to what the caller
  // reaches, which is what makes `listing` the honest target here.
  "GET /api/openapi.json": p("read", listing),
  "GET /api/inventory": p("read", listing),
  "GET /api/inventory/:uuid": p("read", listing),
  "POST /api/playground": p("read", listing),
  "GET /api-docs": p("read", listing),

  // ---- Listings, narrowed by the handler ---------------------------------
  "GET /": p("read", listing),
  "GET /api/devices": p("read", listing),
  "GET /api/device-groups": p("read", listing),
  "GET /api/elements": p("read", site),
  "GET /api/graph": p("read", site),
  "GET /api/rooms": p("read", site),
  "GET /api/services": p("read", site),
  "GET /api/tags": p("read", site),
  "GET /api/tags/:id": p("read", site),
  "GET /api/tags/export": p("admin", site),
  "GET /devices": p("read", listing),
  "GET /switches": p("read", listing),
  "GET /buttons": p("read", listing),
  "GET /groups": p("read", listing),
  "GET /graph": p("read", site),
  "GET /tags": p("read", site),
  "GET /tags/:slug": p("read", site),
  "GET /tags/:name/:slug": p("read", site),
  "GET /events": p("read", site),
  "GET /services": p("read", site),
  "GET /services/:id": p("read", site),
  "GET /automations": p("read", site),
  "GET /icons/:name": p("read", site),

  // ---- Element pages and tagging -----------------------------------------
  "GET /api/elements/:key": p("read", element()),
  "GET /api/elements/:key/tags": p("read", element()),
  "GET /api/graph/:key": p("read", element()),
  "GET /elements/:key": p("read", element()),
  "GET /elements/:key/graph": p("read", element()),
  "POST /api/elements/:key/tags": p("admin", element()),
  "DELETE /api/elements/:key/tags/:id": p("admin", element()),

  // ---- The ontology is site-wide: it defines what a room even is ---------
  "POST /api/tags": p("admin", site),
  "PATCH /api/tags/:id": p("admin", site),
  "POST /api/tags/import": p("admin", site),

  // ---- One device, read ---------------------------------------------------
  "GET /api/devices/:id": p("read", device()),
  "GET /api/devices/:id/enabled": p("read", device()),
  "GET /api/switches/:id": p("read", device()),
  "GET /api/switches/:id/state": p("read", device()),
  "GET /api/lights/:id": p("read", device()),
  "GET /api/buttons/:id": p("read", device()),
  "GET /api/buttons/:id/workflow": p("read", device()),
  "GET /api/ir-rf-blasters/:id": p("read", device()),
  "GET /api/radio-receivers/:id": p("read", device()),
  "GET /api/devices/:id/network": p("read", device()),
  "GET /api/devices/:id/isolation": p("read", device()),
  "GET /api/cameras/:id/light-sync/region": p("read", device()),

  // ---- One device, events -------------------------------------------------
  "GET /api/devices/:id/events": p("read", device()),
  "GET /api/devices/:id/events/stream": p("read", device()),
  "GET /api/events": p("read", site),
  "GET /api/events/stream": p("read", site),
  "GET /api/services/:id/events": p("read", site),
  "GET /api/services/:id/stream": p("read", site),
  // Admin: the Hue proxy's link button hands out a credential
  // that controls every light on the real bridge.
  "POST /api/services/:id/actions/:action": p("admin", site),

  // ---- One device, pictures and sound ------------------------------------
  "GET /api/cameras/:id/snapshot": p("read", device()),
  "GET /api/cameras/:id/stream.mjpeg": p("read", device()),
  "GET /api/cameras/:id/photos": p("read", device()),
  "GET /api/cameras/:id/photos/:photoId": p("read", device()),
  "GET /api/devices/:id/alarms/:file": p("read", device()),
  "POST /api/cameras/:id/photos/sync": p("write", device()),
  "GET /api/services/frigate/frames/:camera/:objectId": p("read", device("camera")),
  "GET /api/services/frigate/previews/:camera/:objectId": p("read", device("camera")),
  "GET /local-media/pet_msg0.wav": p("read", site),
  "GET /local-media/say/:file": p("read", site),
  "GET /api/automations/dog-announcer/stream.mjpeg": p("read", site),

  // ---- One device, control ------------------------------------------------
  "POST /api/devices/:id/controls/:control": p("write", device()),
  "POST /api/devices/:id/capabilities/:kind/controls/:controlId": p("write", device()),
  "POST /api/devices/:id/reboot": p("admin", device()),
  "POST /api/switches/:id/turn-on": p("write", device()),
  "POST /api/switches/:id/turn-off": p("write", device()),
  "POST /api/switches/:id/toggle": p("write", device()),
  "POST /api/lights/:id/turn-on": p("write", device()),
  "POST /api/lights/:id/turn-off": p("write", device()),
  "POST /api/lights/:id/toggle": p("write", device()),
  "POST /api/lights/:id/brightness": p("write", device()),
  "POST /api/lights/:id/color": p("write", device()),
  "POST /api/lights/:id/color-temperature": p("write", device()),
  "POST /api/buttons/:id/press": p("write", device()),
  "POST /api/ir-rf-blasters/:id/send": p("write", device()),
  "POST /api/ir-rf-blasters/:id/codes/:codeId/send": p("write", device()),
  "POST /api/radio-receivers/:id/codes/:codeId/send": p("write", device()),
  "POST /api/radio-receivers/:id/start": p("write", device()),
  "POST /api/radio-receivers/:id/stop": p("write", device()),
  "POST /api/radio-receivers/:id/quiet": p("write", device()),

  // ---- One device, configuration -----------------------------------------
  "POST /api/devices/:id/name": p("admin", device()),
  "POST /api/devices/:id/room": p("admin", device()),
  "POST /api/devices/:id/enable": p("admin", device()),
  "POST /api/devices/:id/disable": p("admin", device()),
  "POST /api/devices/:id/isolation": p("admin", device()),
  "POST /api/devices/:id/network/reconnect": p("admin", device()),
  "POST /api/devices/:id/network/rescan": p("admin", device()),
  "POST /api/devices/:id/network/settings": p("admin", device()),
  "GET /api/devices/:id/network/settings": p("admin", device()),
  "POST /api/ir-rf-blasters/:id/learn": p("admin", device()),
  "POST /api/ir-rf-blasters/:id/codes": p("admin", device()),
  "POST /api/ir-rf-blasters/:id/codes/:codeId/update": p("admin", device()),
  "POST /api/ir-rf-blasters/:id/codes/:codeId/delete": p("admin", device()),
  "POST /api/radio-receivers/:id/codes": p("admin", device()),
  "POST /api/radio-receivers/:id/codes/:codeId/delete": p("admin", device()),
  "PUT /api/buttons/:id/workflow": p("admin", device()),
  "PUT /api/cameras/:id/light-sync/region": p("admin", device()),
  "DELETE /api/cameras/:id/light-sync/region": p("admin", device()),
  "POST /api/aqara/:id/pair": p("admin", device()),
  "POST /api/aqara/:id/sync": p("admin", device()),

  // ---- Groups -------------------------------------------------------------
  "GET /api/device-groups/:id": p("read", group()),
  "GET /api/device-groups/:id/switch": p("read", group()),
  "POST /api/device-groups/:id/switch/turn-on": p("write", group()),
  "POST /api/device-groups/:id/switch/turn-off": p("write", group()),
  "POST /api/device-groups/:id/switch/toggle": p("write", group()),
  "POST /api/device-groups/:id/controls/:control": p("write", group()),
  "POST /api/device-groups/:id/settings": p("admin", group()),
  "POST /api/device-groups": p("admin", site),
  "POST /api/device-groups/preview": p("admin", site),
  "GET /groups/new": p("admin", site),

  // ---- Creating devices is editing devices.yml ---------------------
  "POST /api/switches": p("admin", site),
  "POST /api/buttons": p("admin", site),

  // ---- The network and the isolation switch ------------------------------
  "GET /api/isolation": p("admin", site),
  "GET /network-isolation": p("admin", site),
  "POST /api/network/rescan": p("admin", site),
  "GET /api/network/commands/accept-next": p("admin", site),
  "GET /api/network/commands/accept-next/options": p("admin", site),
  "POST /api/network/commands/accept-next": p("admin", site),
  "POST /api/network/commands/accept-next/:id/cancel": p("admin", site),
  "GET /network/commands/accept-next": p("admin", site),

  // ---- The raw camera service: vendor ids, so site-scoped only -----------
  "GET /api/camera/state": p("read", site),
  "GET /api/camera/network": p("admin", site),
  "POST /api/camera/network/dns-override": p("admin", site),
  "POST /api/camera/network/reconnect": p("admin", site),
  "POST /api/camera/discover": p("admin", site),
  "POST /api/camera/select": p("admin", site),
  "POST /api/camera/setup": p("admin", site),
  "POST /api/camera/disconnect": p("admin", site),
  "POST /api/camera/reboot": p("admin", site),
  "POST /api/camera/control": p("write", site),
  "POST /api/camera/ptz": p("write", site),
  "GET /api/camera/devices/:id/snapshot": p("read", site),
  "GET /api/camera/devices/:id/stream.mjpeg": p("read", site),
  "GET /api/camera/devices/:id/playback.mjpeg": p("read", site),
  "GET /api/camera/devices/:id/audio.mp3": p("read", site),
  "POST /api/camera/devices/:id/playback/pause": p("write", site),
  "POST /api/camera/devices/:id/playback/resume": p("write", site),
  "POST /api/camera/devices/:id/playback/seek": p("write", site),
  "POST /api/camera/devices/:id/playback/stop": p("write", site),
  // Talkback changes what is playing in the house.
  "POST /api/camera/devices/:id/talkback/start": p("write", site),
  "POST /api/camera/devices/:id/talkback/stop": p("write", site),
  "POST /api/camera/devices/:id/talkback/audio": p("write", site),
  "POST /api/camera/devices/:id/local-command": p("write", site),
  "POST /api/camera/devices/:id/local-iot": p("write", site),

  // ---- Automations --------------------------------------------------------
  "GET /api/automations/dog-announcer": p("read", site),
  "PUT /api/automations/dog-announcer": p("admin", site),
  "PUT /api/automations/dog-announcer/enabled": p("admin", site),
  "POST /api/automations/dog-announcer/preview": p("write", site),
  "GET /automations/dog-announcer": p("read", site),
  // The automation's own switch, mounted only when the site runs the service.
  "GET /api/automations/dog-announcer/switch": p("read", site),
  "POST /api/automations/dog-announcer/switch/turn-on": p("admin", site),
  "POST /api/automations/dog-announcer/switch/turn-off": p("admin", site),
  "POST /api/automations/dog-announcer/switch/toggle": p("admin", site),

  // ---- Kindle -------------------------------------------------------------
  "GET /kindle": p("read", site),
  "GET /kindle/designer": p("admin", site),
  "GET /kindle/settings": p("admin", site),
  "GET /api/kindle/config": p("read", site),
  "PUT /api/kindle/config": p("admin", site),
  "GET /api/kindle/catalog": p("admin", site),
  "GET /api/kindle/snapshot": p("read", site),
  "GET /api/kindle/images/:image": p("read", site),
  "POST /api/kindle/preview": p("admin", site),

  // ---- The state stream: one per page, carrying whatever nodes it names ---
  // The nodes are checked individually inside the route, so a narrow token
  // gets a stream carrying only what it may see rather than a 403.
  "GET /api/state": p("read", listing),
  "GET /api/state/stream": p("read", listing),

  // ---- Device pages, resolved through the page directory -----------------
  ...Object.fromEntries(
    ["devices", "switches", "lights", "string-lights", "buttons", "cameras", "sensors", "hubs", "blasters", "speakers", "groups"]
      .flatMap(prefix => [
        [`GET /${prefix}/:slug`, p("read", page)],
        [`GET /${prefix}/:slug/graph`, p("read", page)],
        [`GET /${prefix}/:slug/log`, p("read", page)],
        [`GET /${prefix}/:slug/light-sync`, p("admin", page)],
        [`GET /${prefix}/:slug/settings`, p("admin", page)],
      ]),
  ),
};

/** The policy for a matched route, or undefined — which the guard treats as denied. */
export function policyFor(method: string, routePath: string): RoutePolicy | undefined {
  return ROUTE_POLICIES[`${method} ${routePath}`];
}

export function isPublicRoute(method: string, routePath: string): boolean {
  return PUBLIC_ROUTES.has(`${method} ${routePath}`);
}
