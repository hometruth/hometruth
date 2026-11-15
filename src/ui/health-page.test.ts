import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { HealthStore } from "../health/store";
import { DAY, HOUR } from "../health/model";
import { renderHealthPage } from "./health-page";
import { testPageContext } from "./test-context";

test("health guidance supports agent handoff, friendly checks, error feedback and verified recovery", async () => {
  const store = new HealthStore();
  const now = Date.parse("2026-01-01T00:00:00Z");
  const device = { key: "device:relay-id", kind: "device" as const, id: "relay-id", name: 'Desk relay <script>alert(1)</script>' };
  const unknown = { key: "device:unknown", kind: "device" as const, id: "unknown", name: "Unobserved bulb" };
  const failed = { status: "unhealthy" as const, detail: "Connection timed out", checkedAt: new Date(now).toISOString() };
  store.begin(now); store.observe(device, failed, now); store.problem(device, failed.detail, now);
  store.observe(unknown, { status: "unknown", detail: "No reliable health observation", checkedAt: null }, now);
  // A friendly name that is also another internal ID catches accidental double mapping.
  const ctx = testPageContext({ path: "/health", admin: true, apiAddresses: { devices: { "relay-id": "desk-relay", "desk-relay": "wrong-relay" }, services: {}, groups: {}, elements: {}, tags: {}, stateNodes: {} } });
  let checks = 0, failCheck = true, failPolicy = false;
  const requests: string[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: async request => {
    const path = new URL(request.url).pathname;
    if (path === "/health") return new Response(renderHealthPage(ctx, store.report(now - DAY, now + 1000, HOUR), "24h", (_kind, id) => `/switches/${id === "relay-id" ? "desk-relay" : id}`), { headers: { "Content-Type": "text/html" } });
    if (request.method === "PUT") {
      expect(path).toBe("/api/devices/desk-relay/health/policy");
      if (failPolicy) return new Response(null, { status: 503 });
      const body = await request.json() as { unreachableIsUnhealthy: boolean };
      store.setUnreachableIsUnhealthy(device.key, body.unreachableIsUnhealthy);
      store.observe(device, body.unreachableIsUnhealthy ? failed : { status: "expected_offline", detail: "Offline periods allowed", checkedAt: failed.checkedAt }, now);
      if (body.unreachableIsUnhealthy) store.problem(device, failed.detail, now);
      return Response.json(body);
    }
    if (request.method === "POST") {
      requests.push(path); checks++;
      if (path !== "/api/devices/desk-relay/health/check") return new Response(null, { status: 404 });
      if (failCheck) return new Response(null, { status: 503 });
      const healthy = { status: "healthy" as const, detail: "Responding normally", checkedAt: new Date(now + 1000).toISOString() };
      store.observe(device, healthy, now + 1000);
      return Response.json(healthy);
    }
    return new Response("", { headers: { "Content-Type": "application/javascript" } });
  } });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
    const page = await context.newPage();
    await page.addInitScript(() => {
      // Push refreshes explicitly; no real event source or hardware is involved.
      (window as any).EventSource = class extends EventTarget {
        constructor() { super(); (window as any).healthEvents = this; }
        close() {}
      };
    });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const origin = `http://localhost:${server.port}`;
    await page.goto(`${origin}/health`);
    const issue = page.locator('[data-issue="device:relay-id"]');
    expect(await issue.innerText()).toContain("Check power and the connection");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 900 });
    expect(await issue.locator("script").count()).toBe(0);
    expect(await page.locator('[data-health-disclosure="unknown"]').getAttribute("open")).toBeNull();
    await issue.getByRole("checkbox").uncheck();
    await issue.waitFor({ state: "detached" });
    expect(await page.locator(".health-table").innerText()).toContain("Offline (allowed)");
    const tablePolicy = page.locator('table [data-health-policy="/api/devices/desk-relay/health/policy"]');
    expect(await tablePolicy.isChecked()).toBe(false);
    await tablePolicy.check();
    await issue.waitFor({ state: "visible" });
    failPolicy = true;
    await issue.getByRole("checkbox").uncheck();
    await page.waitForFunction(() => document.querySelector("#health-action-status")?.textContent?.includes("Could not save"));
    expect(await issue.getByRole("checkbox").isChecked()).toBe(true);
    failPolicy = false;
    expect(checks).toBe(0);
    await issue.getByText("Investigate with your agent", { exact: true }).click();
    await issue.getByRole("button", { name: "Copy investigation request" }).click();
    const prompt = await page.evaluate(() => navigator.clipboard.readText());
    expect(prompt).toContain(`${origin}/mcp`);
    expect(prompt).toContain("Connection timed out");
    expect(prompt).toContain("/api/devices/desk-relay/health/check");
    expect(checks).toBe(0);
    await page.evaluate(() => (window as any).healthEvents.dispatchEvent(new Event("service-event")));
    await page.waitForTimeout(900);
    expect(await issue.locator("details").getAttribute("open")).not.toBeNull();
    await issue.getByRole("button", { name: "Check again" }).click();
    await page.waitForFunction(() => document.querySelector("#health-action-status")?.textContent?.includes("could not complete"));
    expect(await issue.count()).toBe(1);
    failCheck = false;
    await issue.getByRole("button", { name: "Check again" }).click();
    await issue.waitFor({ state: "detached" });
    expect(await page.locator("#health-action-status").innerText()).toContain("Healthy");
    expect(await page.locator(".health-problems").innerText()).toContain("Resolved");
    expect(requests).toEqual(["/api/devices/desk-relay/health/check", "/api/devices/desk-relay/health/check"]);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await browser.close(); await server.stop(true); store.close(); }
}, 30_000);
