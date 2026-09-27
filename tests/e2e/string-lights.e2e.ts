import { expect, test, type Page } from "@playwright/test";
import { renderStringLightPage } from "../../src/ui/string-light-page";
import { renderLightPage } from "../../src/ui/light-page";
import { testPageContext } from "../../src/ui/test-context";
import type { RegisteredDevice } from "../../src/site";

const parent: RegisteredDevice = { id: "patio-string", name: "Patio StringLight", kind: "string-light", model: "govee-h7021", modelTitle: "Govee H7021 StringLight", capabilities: ["stringLight"], host: "10.77.0.80", page: "/string-lights/patio-string", schemaId: "https://hometruth.ai/schemas/string-light", enabled: true };
const lights: RegisteredDevice[] = Array.from({ length: 30 }, (_, index) => ({ id: `bulb-${index + 1}`, name: `Patio bulb ${index + 1}`, kind: "light", model: "govee-h7021-bulb", modelTitle: "Govee H7021 bulb", capabilities: ["light"], host: parent.host, parent: { id: parent.id, index }, page: `/lights/patio-bulb-${index + 1}`, schemaId: "https://hometruth.ai/schemas/light", enabled: true, relationships: [{ id: parent.id, name: parent.name, page: parent.page, relation: "partOf" }] }));

/** The capability documents a fixture serves per device id; `version` moves whenever a command changed one. */
interface Fixture { readonly capabilities: () => Record<string, unknown>; readonly version: () => number }

/**
 * Stands in for `GET /api/state/stream`: every (re)connection gets `hello`
 * plus one `state` frame per requested node, built from the fixture's current
 * documents (`fault: unconfigured` for a device it does not know). The
 * response ends there, and `retry: 300` makes the browser reconnect at once,
 * so the page sees each change a command makes within a few hundred ms —
 * the same shape a live stream has, without holding a socket open.
 */
async function routeStream(page: Page, devices: Record<string, Fixture>): Promise<void> {
  await page.route("**/api/state/stream**", (route) => {
    const url = new URL(route.request().url());
    const nodes = url.searchParams.getAll("node");
    const now = new Date().toISOString();
    const frames = [`retry: 300`, `event: hello\ndata: ${JSON.stringify({ generation: "e2e", tier: url.searchParams.get("tier") ?? "live", nodes, keepaliveMs: 20_000 })}`];
    for (const node of nodes) {
      const id = node.slice("device/".length);
      const fixture = devices[id];
      const record = fixture
        ? { node, version: fixture.version(), value: { id, name: id, status: "online", capabilities: fixture.capabilities() }, observedAt: now, updatedAt: now }
        : { node, version: 0, fault: { code: "unconfigured", message: `${id} is not in devices.yml` }, updatedAt: now };
      frames.push(`event: state\ndata: ${JSON.stringify(record)}`);
    }
    return route.fulfill({ status: 200, contentType: "text/event-stream", body: `${frames.join("\n\n")}\n\n` });
  });
}

const stringLightPage = (page: Page) => page.route(`**${parent.page}`, (route) => route.fulfill({ contentType: "text/html", body: renderStringLightPage({ ctx: testPageContext(), device: parent, lights }) }));
const bulbPage = (page: Page) => page.route(`**${lights[0]!.page}`, (route) => route.fulfill({ contentType: "text/html", body: renderLightPage({ ctx: testPageContext(), device: lights[0]! }) }));
const controlName = (url: string) => url.split("/").at(-1)!;

test("StringLight shows ordered bulb devices and runs whole-string controls through the right capability", async ({ page }) => {
  const commands: { name: string; value: unknown }[] = [];
  let version = 1;
  const state = { availability: "online", observedAt: new Date().toISOString(), on: true, brightnessPercent: 100, color: "#ff7f00", layout: "linear", lightCount: 30, lights: lights.map(light => ({ id: light.id, name: light.name, index: light.parent!.index })) };
  const actions = { turnOn: {}, turnOff: {}, toggle: {}, setBrightness: { minimumPercent: 0, maximumPercent: 100 }, setColor: { formats: ["hex"] } };
  await stringLightPage(page);
  await bulbPage(page);
  await routeStream(page, {
    [parent.id]: { capabilities: () => ({ stringLight: { id: parent.id, state, actions } }), version: () => version },
    "bulb-1": { capabilities: () => ({ light: { id: "bulb-1", state: { availability: "unknown", detail: "Individual bulb controls have not been verified." } } }), version: () => 1 },
  });
  await page.route("**/api/devices/patio-string/capabilities/stringLight/controls/*", (route) => {
    const name = controlName(route.request().url());
    const { value } = route.request().postDataJSON() as { value?: unknown };
    commands.push({ name, value });
    if (name === "turnOff") state.on = false;
    if (name === "setBrightness") state.brightnessPercent = value as number;
    version += 1;
    return route.fulfill({ json: { object: { id: parent.id, capabilities: { stringLight: { id: parent.id, state, actions } } } } });
  });
  await page.goto(parent.page);
  const light = page.locator("ht-light");
  await expect(page.getByRole("heading", { name: "Patio StringLight" })).toBeVisible();
  await expect(page.locator(".light-string li")).toHaveCount(30);
  await expect(page.locator(".light-string li").first()).toHaveText("1");
  await expect(page.locator(".light-string li").last()).toHaveText("30");
  await expect(light.locator("[part~=value]")).toHaveText("On");
  await light.getByRole("button", { name: "Off", exact: true }).click();
  await expect(light.locator("[part~=value]")).toHaveText("Off");
  expect(commands).toEqual([{ name: "turnOff", value: undefined }]);
  await light.locator("[part~=brightness]").fill("42");
  await light.locator("[part~=brightness]").dispatchEvent("change");
  await expect.poll(() => commands.length).toBe(2);
  expect(commands[1]).toEqual({ name: "setBrightness", value: 42 });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("link", { name: "Patio bulb 1", exact: true }).first().click();
  await expect(page).toHaveURL(/\/lights\/patio-bulb-1$/);
  await expect(page.getByRole("link", { name: "Patio StringLight", exact: true })).toBeVisible();
  await expect(light.locator("[part~=value]")).toHaveText("Unknown");
  await expect(light.getByRole("button", { name: "On", exact: true })).toBeHidden();
  await expect(light.locator("[part~=brightness-field]")).toBeHidden();
  await expect(light.locator("[part~=detail]")).toContainText("not been verified");
  expect(commands).toHaveLength(2);
});

test("light shows start, advance in the UI, stop, and retain useful errors", async ({ page }) => {
  const shows = [
    { id: "seaside", name: "Seaside", category: "HomeTruth", kind: "sequence", steps: ["wave", "aurora"] },
    { id: "wave", name: "Wave", category: "Natural", kind: "animation" },
    { id: "aurora", name: "Aurora", category: "Natural", kind: "animation" },
  ];
  let show: Record<string, unknown> = { status: "idle" };
  let fail = false;
  let version = 1;
  const commands: unknown[] = [];
  const capabilities = () => ({ stringLight: { id: parent.id, state: { availability: "online", on: true, shows, show }, actions: { turnOn: {}, turnOff: {}, playShow: {}, stopShow: {} } } });
  await stringLightPage(page);
  await routeStream(page, { [parent.id]: { capabilities, version: () => version } });
  await page.route("**/api/devices/patio-string/capabilities/stringLight/controls/*", (route) => {
    if (fail) return route.fulfill({ status: 502, json: { error: { code: "govee_unreachable", message: "Controller unavailable" } } });
    const method = controlName(route.request().url());
    const { value } = route.request().postDataJSON() as { value?: { id: string } };
    commands.push({ method, value });
    show = method === "playShow" && value ? { status: value.id === "seaside" ? "running" : "submitted", showId: value.id, effectId: value.id === "seaside" ? "wave" : value.id } : { status: "idle" };
    version += 1;
    return route.fulfill({ json: { object: { id: parent.id, capabilities: capabilities() } } });
  });
  await page.goto(parent.page);
  await expect(page.getByRole("heading", { name: "Shows", exact: true })).toBeVisible();
  await expect(page.locator("#show-steps")).toHaveText("Wave → Aurora");
  await page.locator("#show-duration").fill("10");
  await page.getByRole("button", { name: "Start show", exact: true }).click();
  await expect(page.locator("#show-status")).toContainText("Seaside · sending Wave");
  expect(commands[0]).toEqual({ method: "playShow", value: { id: "seaside", stepSeconds: 10 } });
  await page.getByRole("button", { name: "Stop show", exact: true }).click();
  await expect(page.locator("#show-status")).toHaveText("No show requested by HomeTruth.");
  await page.locator("#light-show").selectOption("wave");
  await expect(page.locator("#show-duration")).toBeHidden();
  await page.getByRole("button", { name: "Start show", exact: true }).click();
  await expect(page.locator("#show-status")).toHaveText("Wave sent to the lights. Playback cannot be read back.");
  fail = true;
  await page.getByRole("button", { name: "Stop show", exact: true }).click();
  await expect(page.locator("#show-feedback")).toContainText("Controller unavailable");
  await expect(page.getByRole("button", { name: "Stop show", exact: true })).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("bulb page exposes controls without claiming that commanded state was observed", async ({ page }) => {
  const commands: string[] = [];
  let version = 1;
  const state: Record<string, unknown> = { availability: "unknown", detail: "Individual bulb state is not reported." };
  const capabilities = () => ({ light: { id: "bulb-1", state, actions: { turnOn: {}, turnOff: {}, setColor: { formats: ["hex"] }, setBrightness: { minimumPercent: 0, maximumPercent: 100 } } } });
  await bulbPage(page);
  await routeStream(page, { "bulb-1": { capabilities, version: () => version } });
  await page.route("**/api/devices/bulb-1/capabilities/light/controls/*", (route) => {
    commands.push(controlName(route.request().url()));
    Object.assign(state, { on: false, color: "#ffffff", brightnessPercent: 100, stateSource: "commanded", commandedAt: new Date().toISOString() });
    version += 1;
    return route.fulfill({ json: { object: { id: "bulb-1", capabilities: capabilities() } } });
  });
  await page.goto(lights[0]!.page);
  const light = page.locator("ht-light");
  await expect(light.locator("[part~=value]")).toHaveText("Unknown");
  await expect(light.locator("[part~=color]")).toBeVisible();
  await expect(light.locator("[part~=temperature-field]")).toBeHidden();
  await light.getByRole("button", { name: "Off", exact: true }).click();
  await expect(light.locator("[part~=value]")).toHaveText("Off");
  await expect(light.locator("[part~=detail]")).toContainText("Last command");
  expect(commands).toEqual(["turnOff"]);
});

test("fixed white is an explicit whole-string action, not a temperature slider", async ({ page }) => {
  const commands: { name: string; value: unknown }[] = [];
  let version = 1;
  const state: Record<string, unknown> = { availability: "online", on: true, color: "#ff6000" };
  const capabilities = () => ({ stringLight: { id: parent.id, state, actions: { setColorTemperature: { minimumKelvin: 2700, maximumKelvin: 2700 }, setColor: { formats: ["hex"] } } } });
  await stringLightPage(page);
  await routeStream(page, { [parent.id]: { capabilities, version: () => version } });
  await page.route("**/api/devices/patio-string/capabilities/stringLight/controls/*", (route) => {
    const { value } = route.request().postDataJSON() as { value?: unknown };
    commands.push({ name: controlName(route.request().url()), value });
    delete state.color;
    state.colorTemperatureKelvin = value;
    version += 1;
    return route.fulfill({ json: { object: { id: parent.id, capabilities: capabilities() } } });
  });
  await page.goto(parent.page);
  const light = page.locator("ht-light");
  const white = light.getByRole("button", { name: "Set whole string to warm white (2,700 K)", exact: true });
  await expect(white).toBeVisible();
  await expect(white).not.toHaveAttribute("aria-disabled", "true");
  await expect(light.locator("[part~=temperature-field]")).toBeHidden();
  await expect(light.locator("[part~=white-help]")).toContainText("Replaces every bulb’s color");
  await expect(light.locator("[part~=color]")).toHaveValue("#ff6000");
  expect(commands).toHaveLength(0);
  await white.click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands).toEqual([{ name: "setColorTemperature", value: 2700 }]);
  await expect(light.locator("[part~=temperature-field]")).toBeHidden();
  await expect(white).not.toHaveAttribute("aria-disabled", "true");
});

test("static scenes preview bulb order without sending, stay separate from shows, and restore after stopping", async ({ page }) => {
  const commands: { method: string; value: unknown }[] = [];
  let version = 1;
  const scenes = [
    { id: "candy-cane", name: "Candy cane", pattern: "repeat", colors: ["#ff0000", "#ffffff"] },
    { id: "ocean-colors", name: "Ocean colors", pattern: "repeat", colors: ["#0040ff", "#00c8d8"] },
  ];
  const state = {
    availability: "online", on: true, lightCount: 30, scenes,
    shows: [{ id: "wave", name: "Wave", category: "Natural", kind: "animation" }],
    presets: [{ id: "night", name: "Night", category: "Life" }],
    scene: { status: "idle" } as Record<string, unknown>, show: { status: "idle" } as Record<string, unknown>,
  };
  let savedScene = { status: "idle" } as Record<string, unknown>;
  const capabilities = () => ({ stringLight: { id: parent.id, state, actions: { turnOn: {}, turnOff: {}, applyScene: {}, playShow: {}, stopShow: {}, applyPreset: {} } } });
  await stringLightPage(page);
  await routeStream(page, { [parent.id]: { capabilities, version: () => version } });
  await page.route("**/api/devices/patio-string/capabilities/stringLight/controls/*", (route) => {
    const method = controlName(route.request().url());
    const { value } = route.request().postDataJSON() as { value?: unknown };
    commands.push({ method, value });
    if (method === "applyScene") { state.scene = { status: "submitted", sceneId: value }; state.show = { status: "idle" }; }
    if (method === "playShow" || method === "applyPreset") {
      savedScene = state.scene; state.scene = { status: "idle" };
      state.show = { status: "submitted", ...(method === "playShow" ? { showId: (value as { id: string }).id, effectId: (value as { id: string }).id } : { presetId: value, effectId: value }) };
    }
    if (method === "stopShow") { state.show = { status: "idle" }; state.scene = savedScene; }
    version += 1;
    return route.fulfill({ json: { object: { id: parent.id, capabilities: capabilities() } } });
  });
  await page.goto(parent.page);
  await expect(page.getByRole("heading", { name: "Scenes", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Shows", exact: true })).toBeVisible();
  await expect(page.locator("[data-light-scenes] button")).toHaveText("Apply scene");
  await expect(page.locator("#scene-preview li")).toHaveCount(30);
  await expect(page.locator("#scene-preview li").first()).toHaveCSS("background-color", "rgb(255, 0, 0)");
  await expect(page.locator("#scene-preview li").nth(1)).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await page.locator("#light-scene").selectOption("ocean-colors");
  await expect(page.locator("#scene-preview li").last()).toHaveAttribute("aria-label", "Light 30: #00c8d8");
  expect(commands).toHaveLength(0);
  await page.getByRole("button", { name: "Apply scene", exact: true }).click();
  expect(commands[0]).toEqual({ method: "applyScene", value: "ocean-colors" });
  await expect(page.locator("#scene-status")).toContainText("Ocean colors sent as a static arrangement");
  await page.getByRole("button", { name: "Start show", exact: true }).click();
  await expect(page.locator("#scene-status")).toHaveText("No static scene applied by HomeTruth.");
  await expect(page.locator("#show-status")).toContainText("Wave sent");
  await page.getByRole("button", { name: "Stop show", exact: true }).click();
  await expect(page.locator("#scene-status")).toContainText("Ocean colors sent as a static arrangement");
  await expect(page.locator("#preset-apply")).toBeHidden();
  await page.getByText("Other Govee presets", { exact: true }).click();
  await expect(page.locator("[data-govee-presets]")).toContainText("Their motion is unclassified");
  await page.getByRole("button", { name: "Apply preset", exact: true }).click();
  await expect(page.locator("#preset-status")).toContainText("Night sent");
  await expect(page.locator("#show-status")).toHaveText("No show requested by HomeTruth.");
  await page.getByRole("button", { name: "Stop preset", exact: true }).click();
  await expect(page.locator("#scene-status")).toContainText("Ocean colors sent as a static arrangement");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
