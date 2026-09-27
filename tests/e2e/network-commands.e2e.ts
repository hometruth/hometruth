import { expect, test } from "@playwright/test";
import { renderWifiAdmissionPage } from "../../src/ui/wifi-admission-page";
import { testPageContext } from "../../src/ui/test-context";
import type { WifiAdmissionRun } from "../../src/network/wifi-admission-service";
import type { WifiAdmissionSetup } from "../../src/network/wifi-admission-command";

const api = "/api/network/commands/accept-next";
const commandPage = "/network/commands/accept-next";
const setup: WifiAdmissionSetup = { networks: [{ ssid: "Test IoT", available: true, allowedCount: 2 }] };
const makeRun = (): WifiAdmissionRun => ({ id: "test-run", ssid: "Test IoT", timeoutSeconds: 180, recovery: false,
  status: "running", startedAt: new Date().toISOString(), activity: [{ at: new Date().toISOString(), message: "Wi-Fi admission is open. Start joining the device now." }] });

test("opens from Network, runs, survives refresh, and shows the joined device on desktop and mobile", async ({ page }, info) => {
  let current: WifiAdmissionRun | undefined;
  const starts: unknown[] = [];
  await page.route(`**${commandPage}`, route => route.fulfill({ contentType: "text/html", body: renderWifiAdmissionPage({
    ctx: testPageContext(), setup, ...(current ? { run: current } : {}),
  }) }));
  await page.route(`**${api}/options`, route => route.fulfill({ json: current?.result ? { networks: [{ ...setup.networks[0], allowedCount: current.result.allowedCount }] } : setup }));
  await page.route(`**${api}`, route => {
    if (route.request().method() === "POST") { starts.push(route.request().postDataJSON()); current = makeRun(); }
    return route.fulfill({ status: route.request().method() === "POST" ? 202 : 200, json: { run: current ?? null } });
  });
  await page.goto("/network-isolation");
  await expect(page.getByRole("heading", { name: "Network Commands" })).toBeVisible();
  await page.getByRole("link", { name: /Accept next Wi-Fi device/ }).click();
  await expect(page.getByRole("button", { name: "Run command", exact: true })).toBeDisabled();
  await page.getByLabel("Wi-Fi network", { exact: true }).selectOption("Test IoT");
  await page.getByRole("button", { name: "Run command", exact: true }).click();
  await expect(page.getByRole("log")).toContainText("admission is open");
  await expect(page.getByRole("button", { name: "Run command", exact: true })).toBeDisabled();
  expect(starts).toEqual([{ ssid: "Test IoT", timeoutSeconds: 180 }]);
  await page.reload();
  await expect(page.getByRole("log")).toContainText("admission is open");
  expect(starts).toHaveLength(1);
  current = { ...current!, status: "complete", finishedAt: new Date().toISOString(), result: {
    status: "accepted", ssid: "Test IoT", filterEnabled: true, allowedCount: 3,
    client: { ssid: "Test IoT", mac: "02:00:00:00:00:02", name: "Govee string lights", address: "10.78.0.52" },
  }, activity: [...current!.activity, { at: new Date().toISOString(), message: "MAC restriction restored and verified." }] };
  await expect(page.locator("#admission-status-text")).toHaveText("Device accepted");
  await expect(page.getByRole("heading", { name: "Device joined" })).toBeVisible();
  await expect(page.locator("#admission-device-name")).toHaveText("Govee string lights");
  await expect(page.locator("#admission-device-mac")).toHaveText("02:00:00:00:00:02");
  await expect(page.locator("#admission-device-ip")).toHaveText("10.78.0.52");
  await expect(page.locator("#admission-restored")).toContainText("3 devices are allowed");
  await page.screenshot({ path: info.outputPath("network-command-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath("network-command-mobile.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("cancels and waits for restoration before enabling another run", async ({ page }) => {
  let current = makeRun();
  await page.route(`**${commandPage}`, route => route.fulfill({ contentType: "text/html", body: renderWifiAdmissionPage({ ctx: testPageContext(), setup, run: current }) }));
  await page.route(`**${api}/options`, route => route.fulfill({ json: setup }));
  await page.route(`**${api}`, route => route.fulfill({ json: { run: current } }));
  await page.route(`**${api}/test-run/cancel`, route => { current = { ...current, status: "stopping" }; return route.fulfill({ json: { run: current } }); });
  await page.goto(commandPage);
  await page.getByRole("button", { name: "Cancel and restore" }).click();
  await expect(page.locator("#admission-status-text")).toHaveText("Restoring MAC restrictions…");
  await expect(page.getByRole("button", { name: "Run command", exact: true })).toBeDisabled();
  current = { ...current, status: "complete", result: { status: "cancelled", ssid: "Test IoT", allowedCount: 2, filterEnabled: true } };
  await expect(page.locator("#admission-status-text")).toHaveText("Cancelled; MAC restrictions restored");
  await expect(page.getByRole("button", { name: "Run command", exact: true })).toBeEnabled();
  await expect(page.getByRole("heading", { name: "Device joined" })).toBeHidden();
});

test("shows failed restoration and offers recovery without opening a new window", async ({ page }) => {
  const recoverySetup: WifiAdmissionSetup = { networks: [{ ssid: "Test IoT", allowedCount: 2, available: false }], recovery: { ssid: "Test IoT", active: false } };
  let current: WifiAdmissionRun = { ...makeRun(), status: "failed", error: "Router was unreachable; recovery snapshot retained." };
  let requested: unknown;
  await page.route(`**${commandPage}`, route => route.fulfill({ contentType: "text/html", body: renderWifiAdmissionPage({ ctx: testPageContext(), setup: recoverySetup, run: current }) }));
  await page.route(`**${api}/options`, route => route.fulfill({ json: recoverySetup }));
  await page.route(`**${api}`, route => {
    if (route.request().method() === "POST") { requested = route.request().postDataJSON(); current = { ...makeRun(), recovery: true }; }
    return route.fulfill({ json: { run: current } });
  });
  await page.goto(commandPage);
  await expect(page.locator("#admission-error")).toContainText("Router was unreachable");
  await expect(page.getByRole("button", { name: "Run command", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Restore MAC restrictions", exact: true }).click();
  expect(requested).toEqual({ ssid: "Test IoT", recover: true });
  await expect(page.getByRole("button", { name: "Cancel and restore" })).toBeHidden();
});
