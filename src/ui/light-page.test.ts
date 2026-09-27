import { describe, expect, test } from "bun:test";
import { lightSchema, stringLightSchema } from "../schemas";
import type { RegisteredDevice } from "../site";
import { renderLightPage } from "./light-page";
import { LIGHT_SHOWS_SCRIPT } from "./string-light-shows";
import { renderStringLightPage } from "./string-light-page";
import { testPageContext } from "./test-context";

const light: RegisteredDevice = {
  id: "hue-test", name: "Hue test", kind: "light", model: "hue-light", modelTitle: "Hue light", capabilities: ["light"],
  host: "10.77.0.29", page: "/lights/hue-test", schemaId: lightSchema.$id, enabled: true,
};

const string: RegisteredDevice = {
  id: "patio-string", name: "Patio string", kind: "string-light", model: "govee-h7021", modelTitle: "Govee H7021", capabilities: ["stringLight"],
  host: "10.77.0.80", page: "/string-lights/patio-string", schemaId: stringLightSchema.$id, enabled: true,
};

const bulbs: RegisteredDevice[] = [1, 0].map((index) => ({
  id: `bulb-${index + 1}`, name: `Patio bulb ${index + 1}`, kind: "light", model: "govee-h7021-bulb", modelTitle: "Govee H7021 bulb", capabilities: ["light"],
  host: string.host, parent: { id: string.id, index }, page: `/lights/bulb-${index + 1}`, schemaId: lightSchema.$id, enabled: true,
}));

const messagesOf = (html: string): Record<string, string> => JSON.parse(/<script type="application\/json" id="ht-messages"[^>]*>(.*?)<\/script>/su.exec(html)![1]!) as Record<string, string>;

describe("light page", () => {
  test("binds one ht-light to the device node and carries no script of its own", () => {
    const html = renderLightPage({ ctx: testPageContext(), device: light });
    expect(html).toContain('<ht-light node="device/hue-test">');
    expect(html).not.toContain('capability="stringLight"');
    expect(html).toContain('id="ht-state"');
    expect(html).toContain("Checking");
    expect(html).not.toContain("data-light-page");
    expect(html).not.toContain('id="brightness"');
    expect(html).not.toContain("/api/lights/");
  });

  test("hands the element the light and state catalogs", () => {
    const messages = messagesOf(renderLightPage({ ctx: testPageContext(), device: light }));
    expect(messages["light.brightness"]).toBe("Brightness");
    expect(messages["light.kelvin"]).toBe("{kelvin} K");
    expect(messages["stringLight.warmWhite"]).toContain("warm white");
    expect(messages["state.stale"]).toBeDefined();
  });

  test("places the page's extra sections after the element", () => {
    const html = renderLightPage({ ctx: testPageContext(), device: light, afterControls: '<section id="after">More</section>', extraCss: ".after { color: var(--fg); }" });
    expect(html.indexOf("<ht-light")).toBeLessThan(html.indexOf('<section id="after">'));
    expect(html).toContain(".after { color: var(--fg); }");
  });
});

describe("string light page", () => {
  test("binds ht-light to the stringLight capability and lists the bulbs in physical order", () => {
    const html = renderStringLightPage({ ctx: testPageContext(), device: string, lights: bulbs });
    expect(html).toContain('<ht-light node="device/patio-string" capability="stringLight">');
    expect(html).toContain("data-light-shows");
    expect(html).toContain("data-light-scenes");
    expect(html.indexOf('href="/lights/bulb-1"')).toBeLessThan(html.indexOf('href="/lights/bulb-2"'));
    expect(html).toContain(LIGHT_SHOWS_SCRIPT);
  });

  test("the shows script follows the element's frames rather than fetching state itself", () => {
    expect(LIGHT_SHOWS_SCRIPT).toContain("ht-light[node^=\"device/\"]");
    expect(LIGHT_SHOWS_SCRIPT).toContain("addEventListener('ht:frame'");
    expect(LIGHT_SHOWS_SCRIPT).toContain("/capabilities/stringLight/controls/");
    expect(LIGHT_SHOWS_SCRIPT).not.toContain("light-state");
    expect(LIGHT_SHOWS_SCRIPT).not.toContain("show-changed");
    expect(LIGHT_SHOWS_SCRIPT).not.toContain("data-light-page");
    expect(LIGHT_SHOWS_SCRIPT).not.toContain("setTimeout");
  });
});
