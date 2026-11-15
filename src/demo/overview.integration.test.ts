import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { expect as browserExpect } from "@playwright/test";
import { exportDemo } from "./export";
import { FALLINGWATER_CONFIG } from "./showcase";
import { createPublicWorker } from "../public-schemas/worker";

test("large scenes have controls below, animated water, gate state and diverse shared object actions", async () => {
  const output = await mkdtemp(join(tmpdir(), "hometruth-overview-"));
  const browser = await chromium.launch({ headless: true });
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    await exportDemo({ output, config: FALLINGWATER_CONFIG, showcase: true });
    const worker = createPublicWorker([]);
    const requests: string[] = [], errors: string[] = [];
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
      requests.push(new URL(request.url).pathname);
      return worker.fetch(request, { ASSETS: { async fetch(request) {
        const file = Bun.file(join(output, new URL(request instanceof Request ? request.url : request).pathname));
        return await file.exists() ? new Response(file, { headers: { "content-type": file.type } }) : new Response("Not found", { status: 404 });
      } } });
    } });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
    const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
    const origin = server.url.origin;
    await page.goto(origin);
    const water = page.getByRole("button", { name: "Waterfall", exact: true });
    await water.waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector('[data-house-canvas]')?.getAttribute("data-waterfall") === "on");
    expect(await page.locator("[data-device-card]").count()).toBe(36);
    expect(await page.locator("h1,h2,.site-sidebar,.ht-house-hotspot,.ht-stage-caption,.ht-demo-banner").count()).toBe(0);
    expect(await page.locator(".vh-art button,.vh-art a,.vh-art span").count()).toBe(0);
    const geometry = await page.locator(".vh-scene").evaluateAll(scenes => scenes.map(scene => {
      const art = scene.querySelector(".vh-art")!.getBoundingClientRect();
      return { artWidth: art.width, below: scene.querySelector(".vh-controls")!.getBoundingClientRect().top >= art.bottom };
    }));
    expect(geometry).toEqual([{ artWidth: 1440, below: true }, { artWidth: 1440, below: true }]);
    await browserExpect.poll(async () => page.locator('[data-house-canvas]').getAttribute("data-frame")).not.toBe("0");
    await water.click();
    await page.waitForFunction(() => document.querySelector('[data-house-canvas]')?.getAttribute("data-waterfall") === "off");
    const dry = await page.locator("canvas").evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
    const frame = await page.locator("canvas").getAttribute("data-frame");
    await page.waitForTimeout(320);
    expect(await page.locator("canvas").getAttribute("data-frame")).toBe(frame);
    await page.getByRole("button", { name: "Driveway gate", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-house-canvas]')?.getAttribute("data-gate") === "open");
    expect(await page.locator("canvas").evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL())).not.toBe(dry);
    await water.click();
    await page.waitForFunction(() => document.querySelector('[data-house-canvas]')?.getAttribute("data-waterfall") === "on");
    await page.getByRole("button", { name: "Speakers", exact: true }).click();
    await browserExpect.poll(async () => page.locator('[data-device-reading="demo-device-22"]').textContent()).toBe("Playing");
    await page.getByRole("button", { name: "Television", exact: true }).click();
    await browserExpect.poll(async () => page.locator('[data-device-reading="demo-device-21"]').textContent()).toBe("Off");
    await page.getByRole("button", { name: "Vacuum clean", exact: true }).click();
    await browserExpect.poll(async () => page.locator('[data-device-reading="demo-device-26"]').textContent()).toBe("Cleaning");
    await page.reload();
    await page.waitForFunction(() => document.querySelector('[data-house-canvas]')?.getAttribute("data-gate") === "open");
    expect(await page.locator('[data-device-reading="demo-device-26"]').textContent()).toBe("Cleaning");
    await page.getByRole("button", { name: "Vacuum dock", exact: true }).click();
    await browserExpect.poll(async () => page.locator('[data-device-reading="demo-device-26"]').textContent()).toBe("Docked");
    expect(await page.locator('[data-device-reading="demo-device-27"]').textContent()).toBe("23.4°C · 51%");
    expect(await page.locator('[data-device-reading="demo-device-28"]').textContent()).toContain("620ppm");
    expect(await page.locator('[data-device-reading="demo-device-28"]').evaluate(element => getComputedStyle(element).color)).toBe("rgb(206, 217, 205)");
    expect(await page.locator('[data-device-card="demo-device-28"] .vh-control').evaluate(element => getComputedStyle(element).color)).toBe("rgb(248, 240, 221)");
    await page.getByRole("button", { name: "Cooktop lock", exact: true }).click();
    await browserExpect.poll(async () => page.locator('[data-device-reading="demo-device-33"]').textContent()).toBe("Locked");
    await page.getByRole("button", { name: "Pet feeder", exact: true }).click();
    await page.getByRole("button", { name: "Ceiling fan", exact: true }).focus();
    await page.keyboard.press("Space");
    await browserExpect.poll(async () => page.locator('[data-device-reading="demo-device-18"]').textContent()).toBe("Off");
    const captures = process.env.HOMETRUTH_QA_OUTPUT;
    if (captures) {
      await mkdir(captures, { recursive: true });
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: join(captures, "visual-home-desktop.png"), fullPage: true, animations: "disabled" });
    }
    for (const width of [320, 390, 768, 1280, 1600]) {
      await page.setViewportSize({ width, height: 950 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    if (captures) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: join(captures, "visual-home-mobile.png"), fullPage: true, animations: "disabled" });
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForTimeout(200);
    const still = await page.locator("canvas").getAttribute("data-frame");
    await page.waitForTimeout(300);
    expect(await page.locator("canvas").getAttribute("data-frame")).toBe(still);
    await page.getByRole("link", { name: "Television details", exact: true }).click();
    await page.locator('[data-demo-object-api]').waitFor();
    expect(await page.locator('[data-demo-object-json]').textContent()).toContain('"power": "standby"');
    await page.getByRole("link", { name: "Explore in graph", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-graph-panel]:not([hidden]) h2')?.textContent === "Television");
    expect(requests.filter(path => path.startsWith("/api/"))).toEqual([]);
    expect(errors).toEqual([]);
    expect((await fetch(`${origin}/demo`)).status).toBe(404);
    await context.close();
  } finally { await browser.close(); server?.stop(true); await rm(output, { recursive: true, force: true }); }
}, 60_000);
