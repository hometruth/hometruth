import { expect, test } from "bun:test";
import { DogAnnouncer } from "../automations/dog-announcer";
import { DEFAULT_DOG_CONFIG } from "../automations/dog-config";
import { Site } from "../site";
import { createApp } from "../server/app";
import { isPublicRoute, policyFor, PUBLIC_ROUTES, ROUTE_POLICIES } from "./policy";

/**
 * Every route the app can register, as `METHOD /pattern`, middleware excluded.
 *
 * The automation routes only mount when the site runs that service, so the app
 * under test is built with it: a conditionally mounted route is exactly the
 * kind that gets forgotten, and it must be covered like any other.
 */
async function registeredRoutes(): Promise<string[]> {
  const announcer = new DogAnnouncer({
    store: { load: async () => DEFAULT_DOG_CONFIG, save: async () => {} },
    detect: async () => { throw new Error("not called"); },
    speak: async () => {}, validate: () => {},
  });
  try {
    const app = createApp(undefined, new Site([], undefined, new Map(), [announcer]));
    return [...new Set(app.routes.filter(route => route.method !== "ALL").map(route => `${route.method} ${route.path}`))].sort();
  } finally { await announcer.stop(); }
}

test("every registered route has a policy or is deliberately public", async () => {
  const unlisted = (await registeredRoutes()).filter(key => {
    const gap = key.indexOf(" ");
    return !policyFor(key.slice(0, gap), key.slice(gap + 1)) && !isPublicRoute(key.slice(0, gap), key.slice(gap + 1));
  });
  // A route with no policy is denied at runtime; this fails the build instead,
  // so the decision gets made when the route is written, not after an incident.
  expect(unlisted).toEqual([]);
});

test("no route is both public and policed", () => {
  expect([...PUBLIC_ROUTES].filter(key => key in ROUTE_POLICIES)).toEqual([]);
});

test("no policy names a route that does not exist", async () => {
  const registered = new Set(await registeredRoutes());
  expect([...Object.keys(ROUTE_POLICIES), ...PUBLIC_ROUTES].filter(key => !registered.has(key)).sort()).toEqual([]);
});

test("nothing under /api is public except health and the credential exchange", () => {
  expect([...PUBLIC_ROUTES].filter(key => key.includes(" /api/")).sort())
    .toEqual(["GET /api/health", "POST /api/auth/sign-in"]);
});

test("every route that enables or disables the automation requires admin", () => {
  for (const [method, path] of [
    ["PUT", "/api/automations/dog-announcer/enabled"],
    ["POST", "/api/automations/dog-announcer/switch/turn-on"],
    ["POST", "/api/automations/dog-announcer/switch/turn-off"],
    ["POST", "/api/automations/dog-announcer/switch/toggle"],
  ] as const) expect(policyFor(method, path)?.permission).toBe("admin");
});
