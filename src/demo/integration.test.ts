import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { exportDemo } from "./export";

test("static pages operate without APIs and keep pretend state across navigation and reloads", async () => {
  const output = await mkdtemp(join(tmpdir(), "hometruth-demo-browser-"));
  const requests: string[] = [];
  const errors: string[] = [];
  let server: ReturnType<typeof Bun.serve> | undefined;
  const browser = await chromium.launch({ headless: true });
  try {
    await exportDemo({ output, basePath: "/demo", includeNames: false, config: {
      schemaVersion: 2,
      devices: [
        { id: "private-relay", name: "Private Relay", room: "Private Room", model: "shelly-plus-1", config: { host: "192.0.2.20" } },
        { id: "private-lamp", name: "Private Light", room: "Private Room", model: "elgato-key-light-air", config: { host: "192.0.2.21" } },
      ],
    } });
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(path);
      const relative = path === "/demo" ? "demo/index.html" : path.slice(1);
      let file = Bun.file(join(output, relative));
      if (!(await file.exists()) && !relative.endsWith(".html")) file = Bun.file(join(output, relative + ".html"));
      return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 });
    } });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${server.url.origin}/demo`);
    await page.locator("a.row").filter({ hasText: "Shelly Plus 1 1" }).first().click();
    const turnOn = page.locator('ht-switch [data-action="turnOn"]');
    await turnOn.waitFor({ state: "visible" });
    await turnOn.click();
    await page.waitForFunction(() => document.querySelector("ht-switch")?.shadowRoot?.querySelector('[data-action="turnOn"]')?.getAttribute("data-state") === "active");
    const cookies = await context.cookies();
    expect(cookies.some(cookie => cookie.path === "/demo" && cookie.value.length > 0)).toBe(true);
    await page.reload();
    await page.waitForFunction(() => document.querySelector("ht-switch")?.shadowRoot?.querySelector('[data-action="turnOn"]')?.getAttribute("data-state") === "active");
    await page.getByRole("link", { name: "Devices", exact: true }).first().click();
    await page.locator("a.row").filter({ hasText: "Elgato Key Light Air 1" }).first().click();
    const brightness = page.locator("ht-light input#brightness");
    await brightness.waitFor({ state: "visible" });
    await page.waitForFunction(() => (window as unknown as { ht: { state: { connection: string } } }).ht.state.connection === "live");
    await brightness.fill("37");
    await brightness.dispatchEvent("change");
    await page.waitForFunction(() => (window as unknown as { ht: { state: { read(node: string): { value: { capabilities: { light: { state: { brightnessPercent: number } } } } } } } }).ht.state.read("device/demo-device-2")?.value?.capabilities?.light?.state?.brightnessPercent === 37);
    await page.reload();
    await brightness.waitFor({ state: "visible" });
    await page.waitForFunction(() => (window as unknown as { ht: { state: { connection: string } } }).ht.state.connection === "live");
    expect(await brightness.inputValue()).toBe("37");
    await page.getByRole("button", { name: "Reset demo", exact: true }).click();
    await page.waitForTimeout(150);
    expect(await brightness.inputValue()).toBe("65");
    await page.getByRole("link", { name: "Graph", exact: true }).first().click();
    const cards = page.locator(".graph-card:visible");
    const initialCount = await cards.count();
    await page.locator("#graph-search").fill("Shelly");
    expect(await cards.count()).toBeLessThan(initialCount);
    await page.locator("#graph-search").fill("");
    expect(await cards.count()).toBe(initialCount);
    const outside = await page.locator('a[href^="/"]').evaluateAll(links => links.map(link => link.getAttribute("href")!).filter(href => !href.startsWith("/demo")));
    expect(outside).toEqual([]);
    expect(requests.filter(path => path.includes("/api/") || path.includes("/stream"))).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await browser.close(); server?.stop(true); await rm(output, { recursive: true, force: true });
  }
}, 60_000);
