import { describe, expect, test } from "bun:test";
import type { RegisteredDevice } from "../site";
import { renderDeviceSettingsPage } from "./device-settings-page";
import { testPageContext } from "./test-context";

const relay: RegisteredDevice = {
  id: "gate-relay",
  name: "Gate <relay>",
  kind: "binary-switch",
  model: "shelly-plus-1",
  modelTitle: "Shelly Plus 1",
  capabilities: ["binarySwitch"],
  connectionTypes: ["direct-local"],
  host: "10.77.0.228",
  page: "/devices/gate-relay",
  schemaId: "https://hometruth.ai/schemas/binary-switch",
  enabled: true,
};

const camera: RegisteredDevice = {
  ...relay,
  id: "camera",
  name: "Camera",
  kind: "camera",
  capabilities: ["camera"],
  page: "/devices/camera",
};

describe("device settings page", () => {
  test("the enabled toggle posts enable and disable with no value and restores itself after an error", async () => {
    const html = renderDeviceSettingsPage({ ctx: testPageContext(), device: relay });
    const script = html.slice(html.indexOf('const enabledToggle ='), html.indexOf('const reconnect ='));
    class Input {
      checked = true;
      disabled = false;
      dataset = { deviceId: relay.id };
      change: (() => Promise<void>) | undefined;
      addEventListener(_event: string, callback: () => Promise<void>) { this.change = callback; }
    }
    const toggle = new Input();
    const calls: { path: string; init: RequestInit }[] = [];
    let fail = false;
    new Function("document", "HTMLInputElement", "ht", script)({
      querySelector: (selector: string) => selector === "[data-device-enabled]" ? toggle : {},
    }, Input, {
      say() {}, t: (key: string) => key,
      request: async (path: string, init: RequestInit) => {
        calls.push({ path, init });
        if (fail) throw new Error("Unable to save");
        return path.endsWith("/enable");
      },
    });
    expect(toggle.change).toBeDefined();
    for (const enabled of [false, true]) {
      toggle.checked = enabled;
      await toggle.change!();
      expect(calls.at(-1)).toEqual({ path: `/api/devices/gate-relay/${enabled ? "enable" : "disable"}`, init: { method: "POST", headers: { "content-type": "application/json" } } });
      expect(toggle.checked).toBe(enabled);
      expect(toggle.disabled).toBe(false);
    }
    fail = true;
    toggle.checked = false;
    await toggle.change!();
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(false);
  });
  test("shows the shared pairing QR and manual code for an exported switch", () => {
    const html = renderDeviceSettingsPage({
      ctx: testPageContext({ nonce: 'n"once' }),
      device: relay,
      matter: { running: true, commissioned: false, switchIds: ["gate-relay", "candles"], qrCodeDataUrl: "data:image/png;base64,AQID", manualPairingCode: "12345678901" },
    });
    expect(html).toContain('<style id="ht-css" nonce="n&quot;once">');
    expect(html).toContain('href="/devices/gate-relay/settings" aria-current="page"');
    expect(html).toContain('data-matter-pairing-qr src="data:image/png;base64,AQID"');
    expect(html).toContain("Scan once in Apple Home to add every exported switch.");
    expect(html).toContain("12345678901");
    expect(html).toContain("Gate &lt;relay&gt;");
    expect(html).not.toContain("Gate <relay>");
    expect(html).toContain("data-device-rename");
    expect(html).toContain("data-network-reconnect");
    expect(html).toContain('data-network-rescan data-device-id="gate-relay"');
    expect(html).toContain(">Find on network<");
    expect(html).toContain('"rescan.moved"');
    expect(html).toContain("data-room-picker");
    expect(html).toContain('<dd data-connection-types>Direct local connection</dd>');
    expect(html).toContain('<dt>Schema</dt><dd><a href="/schemas/binary-switch">https://hometruth.ai/schemas/binary-switch</a></dd>');
  });

  test("keeps Settings for every device but does not invent a QR for an unsupported device", () => {
    const html = renderDeviceSettingsPage({ ctx: testPageContext(), device: camera });
    expect(html).toContain('href="/devices/camera/settings" aria-current="page"');
    expect(html).toContain("The Matter bridge exports switches only.");
    expect(html).not.toContain("data-matter-pairing-qr");
    expect(html).toContain('href="/devices/camera/light-sync"');
  });

  test("does not present an already-commissioned bridge QR as a device pairing action", () => {
    const html = renderDeviceSettingsPage({
      ctx: testPageContext(),
      device: relay,
      matter: { running: true, commissioned: true, switchIds: ["gate-relay"], qrCodeDataUrl: "data:image/png;base64,AQID" },
    });
    expect(html).toContain("Do not scan the code again");
    expect(html).toContain("Matter pairs the whole bridge");
    expect(html).toContain("appears in Apple Home on its own");
    expect(html).toContain("Show the bridge code");
    expect(html).not.toContain("Scan once in Apple Home");
  });

  test("explains when an eligible device has no generated QR yet", () => {
    const html = renderDeviceSettingsPage({ ctx: testPageContext(), device: relay });
    expect(html).toContain("No pairing code yet. Check the Apple Home bridge on the Services page.");
  });
});
