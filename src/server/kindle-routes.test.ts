import { StateHub } from "../state/hub";
import { deviceNode } from "../state/protocol";
import { describe, expect, test } from "bun:test";
import { createApp } from "./app";
import { Site } from "../site";
import { Device, type DeviceIdentity } from "../models/device";
import { BinarySwitch, type BinarySwitchState } from "../models/binary-switch";
import { SHELLY_PLUS_1 } from "../devices/switches/shelly-plus-1";

class ReadOnlyRelay extends BinarySwitch {
  writes = 0;
  async getState(): Promise<BinarySwitchState> { return "on"; }
  async turnOn() { this.writes++; }
  async turnOff() { this.writes++; }
  async toggle() { this.writes++; }
}
class TestDevice extends Device<{ host: string }> {
  readonly model = SHELLY_PLUS_1;
  readonly relay = new ReadOnlyRelay("relay");
  readonly capabilities = { binarySwitch: this.relay };
  constructor(id: string, name: string, room: string) { super(id, name, { host: "" }); this.room = room; }
  async probe(): Promise<DeviceIdentity> { return {}; }
}

describe("Kindle dashboard", () => {
  test("server-renders real state, escapes labels, filters and paginates without device writes", async () => {
    const devices = Array.from({ length: 7 }, (_, n) => new TestDevice(`relay-${n}`, n === 0 ? '<img src=x onerror="bad()">' : `Relay ${n}`, n === 6 ? "Bedroom" : "Office"));
    const hub = new StateHub();
    const app = createApp(undefined, new Site(devices), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, hub);
    await Promise.all(devices.map(device => hub.observer.refresh(deviceNode(device.id))));
    const response = await app.request("/kindle?room=Office");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text();
    expect(html).toContain("6 of 6 items online");
    expect(html).toContain("&lt;img src=x onerror=&quot;bad()&quot;&gt;");
    expect(html).not.toContain('<img src=x');
    expect(html.match(/data-capability="binarySwitch"/g)).toHaveLength(4);
    expect(html).toContain('aria-pressed="true">On');
    expect(html).toContain("Page 1 of 2");
    const next = await app.request("/kindle?room=Office&page=999&fragment=1");
    expect(next.headers.get("X-HomeTruth-Kindle")).toBe("1");
    const fragment = await next.text();
    expect(fragment).toContain("Page 2 of 2");
    expect(fragment).not.toContain("<!doctype");
    expect(fragment).not.toContain("<script");
    expect(fragment.match(/data-capability="binarySwitch"/g)).toHaveLength(2);
    expect(devices.every((device) => device.relay.writes === 0)).toBe(true);
  });

  test("empty sites render and unsupported page numbers are bounded", async () => {
    const app = createApp(undefined, Site.empty());
    const response = await app.request("/kindle?page=NaN&room=%3Cscript%3E", { headers: { "accept-language": "de" } });
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("Keine Geräte in dieser Ansicht.");
    expect(html).toContain("Seite 1 von 1");
  });
});
