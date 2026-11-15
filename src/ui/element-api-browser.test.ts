import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { createApp } from "../server/app";
import { Site } from "../site";

test("MCP and skill tabs copy global installation requests with the current element as context", async () => {
  const app = createApp(undefined, new Site([]));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: request => app.fetch(request) });
  const origin = `http://localhost:${server.port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${origin}/switches?tab=mcp&rest-search=toggle`);
    const mcp = page.locator('[data-install-prompt="mcp"]');
    await mcp.waitFor({ state: "visible" });
    await mcp.getByRole("button", { name: "Copy installation request" }).click();
    await mcp.getByRole("button", { name: "Copied", exact: true }).waitFor();
    const mcpRequest = await page.evaluate(() => navigator.clipboard.readText());
    expect(mcpRequest).toBe(await mcp.locator("code").innerText());
    expect(mcpRequest).toContain(`${origin}/mcp`);
    expect(mcpRequest).toContain("Streamable HTTP");
    expect(mcpRequest).toContain('"Switches" (friendly address: switches)');
    expect(mcpRequest).not.toContain("\n");

    await page.locator('[data-element-api-tab="skill"]').click();
    const skill = page.locator('[data-install-prompt="skill"]');
    await skill.waitFor({ state: "visible" });
    expect(new URL(page.url()).searchParams.get("tab")).toBe("skill");
    expect(new URL(page.url()).searchParams.get("rest-search")).toBe("toggle");
    await skill.getByRole("button", { name: "Copy installation request" }).click();
    await skill.getByRole("button", { name: "Copied", exact: true }).waitFor();
    const skillRequest = await page.evaluate(() => navigator.clipboard.readText());
    expect(skillRequest).toBe(await skill.locator("code").innerText());
    expect(skillRequest).toContain(`${origin}/SKILL.md`);
    expect(skillRequest).toContain('"Switches" (friendly address: switches)');
    expect(skillRequest).not.toContain("/switches/SKILL.md");
    expect(skillRequest).not.toContain("\n");
    expect(await page.getByRole("link", { name: "Open HomeTruth SKILL.md" }).getAttribute("href")).toBe("/SKILL.md");

    await page.goBack();
    await mcp.waitFor({ state: "visible" });
    expect(new URL(page.url()).searchParams.get("tab")).toBe("mcp");
    await page.goForward();
    await skill.waitFor({ state: "visible" });
    await page.reload();
    await skill.waitFor({ state: "visible" });
    const globalSkill = await (await app.request(`${origin}/SKILL.md`)).text();
    await page.getByText("Preview the HomeTruth skill", { exact: true }).click();
    expect(await page.locator('#api-panel-4 details code').textContent()).toBe(globalSkill);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await server.stop(true);
  }
}, 30_000);
