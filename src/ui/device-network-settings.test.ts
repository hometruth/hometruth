import { expect, test } from "bun:test";
import type { IsolationStatus } from "../network/isolation";
import type { RegisteredDevice } from "../site";
import { DEVICE_NETWORK_SCRIPT, renderDeviceNetwork } from "./device-network-settings";
import { testPageContext } from "./test-context";

const device: RegisteredDevice = {
  id: "example-frame", name: "Example frame", kind: "device", model: "test-frame", modelTitle: "Test frame",
  capabilities: [], connectionTypes: ["direct-local"], host: "192.0.2.20", page: "/devices/example-frame",
  schemaId: "https://hometruth.ai/schemas/device", enabled: true,
};
const client = { mac: "02:00:00:00:00:20", address: device.host, vlan: 30, ssid: "Example <IoT>" };
const isolation: IsolationStatus = {
  adapter: "test", canIsolate: true, dns: [], listeners: {}, checkedAt: new Date().toISOString(),
  devices: [{ deviceId: device.id, name: device.name, host: device.host, isolated: false, internetBlock: "missing", capture: "unavailable", hostnames: [] }],
};

test("shows VLAN and escaped SSID for the saved hardware identity, even after its IP changes", () => {
  const html = renderDeviceNetwork(testPageContext(), device, [{ ...client, address: "192.0.2.21" }], client.mac.toUpperCase(), isolation);
  expect(html).toContain('data-network-vlan>30</dd>');
  expect(html).toContain('data-network-ssid>Example &lt;IoT&gt;</dd>');
  expect(html).toContain('data-can-isolate="true"');
});

test("does not guess a VLAN from ambiguous, offline or mismatched clients", () => {
  for (const [clients, mac] of [
    [[client, { ...client, mac: "02:00:00:00:00:21", vlan: 40 }], undefined],
    [[{ ...client, connected: false }], client.mac],
    [[client], "02:00:00:00:00:22"],
    [[], undefined],
  ] as const) {
    expect(renderDeviceNetwork(testPageContext(), device, clients, mac, isolation)).toContain('data-network-vlan>Not reported</dd>');
  }
  expect(renderDeviceNetwork(testPageContext(), device, [{ ...client, vlan: 0 }], undefined, isolation)).toContain('data-network-vlan>0</dd>');
});

test("unsupported devices and providers do not offer an active isolation action", () => {
  expect(renderDeviceNetwork(testPageContext(), { ...device, host: "cloud" }, [])).toBe("");
  for (const status of [undefined, { ...isolation, canIsolate: false }, { ...isolation, devices: [] }]) {
    const html = renderDeviceNetwork(testPageContext(), device, [], undefined, status);
    expect(html).toContain('data-can-isolate="false"');
    expect(html).toContain('data-device-isolate disabled');
    expect(html).toContain("Internet isolation is unavailable");
  }
});

class Element {
  dataset: Record<string, string> = {};
  textContent = "";
  disabled = true;
  tone = "";
  click: (() => Promise<void>) | undefined;
  addEventListener(_event: string, callback: () => Promise<void>) { this.click = callback; }
}

async function scriptFixture(writable = true) {
  const elements = Object.fromEntries(["device-isolate", "internet-state", "isolation-feedback", "network-vlan", "network-ssid"].map(key => [key, new Element()]));
  const panel = Object.assign(new Element(), {
    dataset: { deviceId: device.id, canIsolate: String(writable) },
    querySelector: (selector: string) => elements[selector.slice(6, -1)],
  });
  let rule = "missing";
  let requested = false;
  let fail = false;
  let applies = true;
  const posts: unknown[] = [];
  const calls: string[] = [];
  const { t } = testPageContext().i18n;
  new Function("document", "HTMLElement", "ht", DEVICE_NETWORK_SCRIPT)({ querySelector: () => panel }, Element, {
    t,
    say(element: Element, message: string, tone = "") { element.textContent = message; element.tone = tone; },
    request: async (url: string, options?: { body: string }) => {
      calls.push(url);
      if (options) {
        posts.push(JSON.parse(options.body));
        if (fail) throw new Error("Gateway unreachable");
        requested = JSON.parse(options.body).isolated;
        if (applies) rule = requested ? "on" : "off";
        return { device: { isolated: requested, internetBlock: rule }, message: "Gateway response" };
      }
      return { vlan: 30, ssid: "Example IoT", isolation: { internetBlock: rule, requested } };
    },
  });
  await Bun.sleep(0);
  return {
    button: elements["device-isolate"]!, state: elements["internet-state"]!, feedback: elements["isolation-feedback"]!, elements, posts, calls,
    fail: () => { fail = true; }, doNotApply: () => { applies = false; },
  };
}

test("reads live VLAN and rule state without mutating, then blocks and releases the selected device", async () => {
  const f = await scriptFixture();
  expect(f.posts).toEqual([]);
  expect(f.elements["network-vlan"]!.textContent).toBe("30");
  expect(f.state.textContent).toBe("No HomeTruth internet block");
  expect(f.button.disabled).toBe(false);
  await f.button.click!();
  expect(f.posts).toEqual([{ isolated: true }]);
  expect(f.calls.at(-1)).toBe("/api/devices/example-frame/isolation");
  expect(f.state.textContent).toBe("Blocked by HomeTruth");
  expect(f.button.textContent).toBe("Allow internet access");
  expect(f.feedback.tone).toBe("ok");
  await f.button.click!();
  expect(f.posts.at(-1)).toEqual({ isolated: false });
  expect(f.state.textContent).toBe("No HomeTruth internet block");
  expect(f.button.textContent).toBe("Block internet access");
});

test("a saved request is not presented as a successful firewall change when enforcement fails", async () => {
  const f = await scriptFixture();
  f.doNotApply();
  await f.button.click!();
  expect(f.state.textContent).toBe("No HomeTruth internet block");
  expect(f.feedback.tone).toBe("bad");
  expect(f.feedback.textContent).toContain("gateway has not confirmed");
  expect(f.button.textContent).toBe("Block internet access");
  expect(f.button.disabled).toBe(false);
  await f.button.click!();
  expect(f.posts).toEqual([{ isolated: true }, { isolated: true }]);
});

test("failed writes re-read the gateway and keep the action usable for retry", async () => {
  const f = await scriptFixture();
  f.fail();
  await f.button.click!();
  expect(f.calls.at(-1)).toBe("/api/devices/example-frame/network");
  expect(f.state.textContent).toBe("No HomeTruth internet block");
  expect(f.feedback.textContent).toBe("Gateway unreachable");
  expect(f.feedback.tone).toBe("bad");
  expect(f.button.disabled).toBe(false);
});

test("failed release keeps the confirmed block visible and allows another release attempt", async () => {
  const f = await scriptFixture();
  await f.button.click!();
  f.doNotApply();
  await f.button.click!();
  expect(f.posts.at(-1)).toEqual({ isolated: false });
  expect(f.state.textContent).toBe("Blocked by HomeTruth");
  expect(f.feedback.tone).toBe("bad");
  expect(f.feedback.textContent).toContain("removal of the block is not confirmed");
  expect(f.button.textContent).toBe("Allow internet access");
  expect(f.button.disabled).toBe(false);
});

test("read-only network status leaves the isolation control disabled", async () => {
  const f = await scriptFixture(false);
  expect(f.state.textContent).toBe("No HomeTruth internet block");
  expect(f.button.disabled).toBe(true);
  expect(f.posts).toEqual([]);
});
