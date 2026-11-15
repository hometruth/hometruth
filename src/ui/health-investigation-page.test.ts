import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { Hono } from "hono";
import { Device, type DeviceModel } from "../models/device";
import { BinarySwitch } from "../models/binary-switch";
import { HealthService } from "../health/service";
import { HealthStore } from "../health/store";
import type { HealthCheck } from "../health/model";
import { Site } from "../site";
import { healthControlFailures, healthRoutes } from "../server/health-routes";
import type { AppEnvironment } from "../server/http";
import { renderPage } from "./shell";
import { renderHealthInvestigationPage } from "./health-investigation-page";
import { testPageContext } from "./test-context";

test("a failing press adds a live indented Health link and its page updates while investigating", async () => {
  let presses = 0, checks = 0;
  let finish!: (value: HealthCheck) => void;
  class Relay extends BinarySwitch {
    async turnOn() { presses++; throw new Error("Synthetic failure"); }
    async turnOff() {} async toggle() {} async getState() { return "off" as const; }
  }
  class Fixture extends Device {
    readonly model = { id: "fixture", manufacturer: "Example", product: "Relay", capabilities: ["binarySwitch"], connectionTypes: ["direct-local"] } as unknown as DeviceModel;
    readonly capabilities = { binarySwitch: new Relay(this.id) };
    async probe() { return {}; }
    override checkHealth(): Promise<HealthCheck> { checks++; return new Promise(resolve => { finish = resolve; }); }
  }
  const device = new Fixture("lights", "Kitchen Lights", {});
  const health = new HealthService({ store: new HealthStore(), devices: () => [device], services: () => [], timeoutMs: 20000 });
  const site = new Site([device], [], new Map(), [health]);
  health.start(false);
  const ctx = (path: string) => ({ ...testPageContext({ path }), healthInvestigations: health.investigations() });
  const app = new Hono<AppEnvironment>();
  app.use("*", healthControlFailures(site));
  app.onError(() => Response.json({ error: { code: "execution_failed", message: "Could not switch lights" } }, { status: 502 }));
  app.get("/switches", c => c.html(renderPage({ ctx: ctx("/switches"), title: "Switches", nav: "switches",
    body: '<h1>Switches</h1><button id="press">Turn on Kitchen Lights</button><p id="error"></p>',
    script: 'document.querySelector("#press").onclick = async () => { try { await ht.request("/api/switches/lights/turn-on", {method:"POST",body:"{}"}); } catch(error) { document.querySelector("#error").textContent = error.message; } };',
  })));
  app.post("/api/switches/:id/turn-on", async () => { await device.capabilities.binarySwitch.turnOn(); return Response.json({ ok: true }); });
  app.route("/", healthRoutes(site, c => ctx(new URL(c.req.url).pathname)));
  app.get("/ui/*", () => new Response("", { headers: { "Content-Type": "application/javascript" } }));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: app.fetch });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage(), observer = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const origin = `http://localhost:${server.port}`;
    await page.goto(origin + "/switches"); await observer.goto(origin + "/switches");
    const link = page.locator("[data-health-investigations] a");
    expect(await link.count()).toBe(0);
    await page.getByRole("button", { name: "Turn on Kitchen Lights" }).click();
    await link.waitFor({ state: "visible", timeout: 2000 });
    expect(await link.innerText()).toContain("Kitchen Lights failure");
    expect(await link.innerText()).toMatch(/Starting|Investigating/);
    expect(await page.locator("#error").innerText()).toBe("Could not switch lights");
    const href = await link.getAttribute("href");
    expect(href).toStartWith("/health/investigations/");
    await observer.locator("[data-health-investigations] a").waitFor({ state: "visible", timeout: 2000 });
    expect(await link.evaluate(element => element.parentElement?.previousElementSibling?.textContent)).toBe("Health");
    expect(await link.evaluate(element => parseFloat(getComputedStyle(element.parentElement!).marginInlineStart))).toBeGreaterThan(0);
    await link.click();
    await page.getByRole("heading", { name: "Kitchen Lights failure", exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector(".investigation-status")?.textContent?.includes("Investigating"));
    expect(checks).toBe(1); expect(presses).toBe(1);
    finish({ status: "unhealthy", reason: "unreachable", detail: "Not responding", checkedAt: new Date().toISOString() });
    await page.getByRole("heading", { name: "Check power and the connection", exact: true }).waitFor({ timeout: 3000 });
    expect(await page.locator(".investigation-status").innerText()).toContain("Investigation complete");
    expect(await page.locator("[data-investigation-content]").innerText()).toContain("Not responding");
    expect(await page.locator('[data-health-investigations] a[aria-current="page"]').getAttribute("href")).toBe(href);
    await page.reload();
    expect(await page.locator(".investigation-status").innerText()).toContain("Investigation complete");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(presses).toBe(1);
    expect(errors).toEqual([]);
  } finally { await browser.close(); server.stop(true); await health.stop(); }
}, 30000);

test("Claude's proposal shows its steps, device-changing marks and spend against the monthly budget", () => {
  const at = "2026-10-15T12:00:00.000Z";
  const html = renderHealthInvestigationPage(testPageContext({ path: "/health/investigations/x" }), {
    id: "00000000-0000-4000-8000-000000000000", title: "Kitchen Lights failure", href: "/health/investigations/x", status: "complete",
    createdAt: at, updatedAt: at, entity: { key: "device:lights", kind: "device", id: "lights", name: "Kitchen Lights" },
    trigger: { status: "unhealthy", reason: "operation_failed", detail: "A requested action failed", checkedAt: at },
    progress: "Read-only checks complete", observations: [], summary: "A requested action failed", likelyCause: "Unknown", steps: [],
    advice: { status: "complete", note: "Nothing was changed.", model: "claude-opus-5-5", costUsd: 0.036, summary: "The hub is offline",
      likelyCause: "The hub stopped first.", confidence: "medium", proposals: [{ title: "Power-cycle the hub", rationale: "Shared dependency", steps: ["Unplug it"], changesDevice: true }] },
  }, () => undefined, { month: "2026-10", spentUsd: 1.2, monthlyBudgetUsd: 5, model: "claude-opus-5-5" });
  for (const fragment of ["Claude", "The hub is offline", "Power-cycle the hub", "changes a device", "Unplug it", "$0.036", "$1.20 of $5.00 used this month"]) expect(html).toContain(fragment);
});
