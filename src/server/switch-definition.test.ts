import { describe, expect, test } from "bun:test";
import { ActionButtonDevice } from "../devices/composites/action-button";
import { OptimisticSwitchDevice } from "../devices/composites/optimistic-switch";
import { SyntheticSwitchDevice } from "../devices/composites/synthetic-switch";
import { LutronCasetaDimmerDevice, LutronCasetaSwitchDevice } from "../devices/switches/lutron-caseta";
import { ShellyPlus1 } from "../devices/switches/shelly-plus-1";
import { MemorySignalCodeStore } from "../signal-code-store";
import { Site } from "../site";
import { escapeHtml } from "../ui/shell";
import { StateHub } from "../state/hub";
import { createApp } from "./app";

describe("switch definitions in Settings", () => {
  test("documents the actual Shelly transport requests without executing them on page load", async () => {
    const requests: string[] = [];
    const relay = new ShellyPlus1({ id: "relay", name: "Relay" }, { host: "10.77.0.10", channel: 2 }, {
      fetch: async url => { requests.push(`GET ${url}`); return Response.json({ output: false }); },
    });
    const app = createApp(undefined, new Site([relay]));
    const html = await (await app.request("/switches/relay/settings")).text();
    expect(html).toContain("data-switch-definition");
    expect(requests).toEqual([]);
    await relay.turnOn(); await relay.turnOff(); await relay.toggle(); await relay.getState();
    for (const request of requests) expect(html).toContain(escapeHtml(request));
    for (const action of ["turn-on", "turn-off", "toggle"]) expect(html).toContain(`POST /api/switches/relay/${action} {}`);
    expect(html).toContain("GET /api/switches/relay/state");
  });

  test("distinguishes a Lutron device from its same-named group and identifies the exact zone commands", async () => {
    const one = new LutronCasetaSwitchDevice({ id: "lutron-main-lights", name: "Kitchen Lights" }, { host: "10.77.0.20", zone: 7 });
    const two = new LutronCasetaDimmerDevice({ id: "other", name: "Other" }, { host: "10.77.0.20", zone: 8 });
    const group = { id: "kitchen-group", name: "Kitchen Lights", members: [one.id, two.id], asSwitch: true };
    const site = new Site([one, two], undefined, undefined, undefined, undefined, undefined, [group]);
    const app = createApp(undefined, site);
    const html = await (await app.request(`${site.view(one.id)!.page}/settings`)).text();
    expect(html).toContain(`Device · <a href="${site.view(one.id)!.page}">Kitchen Lights`);
    expect(html).toContain('Member of these groups: <a href="/groups/kitchen-lights">Kitchen Lights');
    expect(html).toContain("CreateRequest /zone/7/commandprocessor");
    expect(html).toContain("ReadRequest /zone/7/status");
    for (const level of [0, 100]) expect(html).toContain(escapeHtml(JSON.stringify({ Command: { CommandType: "GoToLevel", Parameter: [{ Type: "Level", Value: level }] } })));
    expect(html).not.toContain("/zone/8/");
    const groupPage = await (await app.request("/groups/kitchen-lights")).text();
    expect(groupPage).toContain('Group · <a href="/groups/kitchen-lights">Kitchen Lights');
    expect(groupPage).toContain("POST /api/device-groups/kitchen-group/switch/turn-on {}");
    expect(groupPage).toContain('href="/lights/other"');
    expect(groupPage).toContain("readings are mixed or unknown");
    expect(groupPage).toContain("light.turnOn()");
    expect(groupPage).toContain("light.describe()");
    expect(groupPage).toContain("binarySwitch.describe()");
  });

  test("traces button-pair actions to saved commands and documents memory-only Refresh", async () => {
    const target = new ShellyPlus1({ id: "target", name: "Target <device>" }, { host: "10.77.0.10" });
    const store = new MemorySignalCodeStore();
    const saved = await store.add(target.id, { name: "Lights on", code: "AAEC", channel: "radio-frequency", durationMs: 250 });
    const on = new ActionButtonDevice({ id: "on-button", name: "On button" }, { device: target.id, savedCodeId: saved.id }, { signalCodes: store }, { device: () => target });
    const off = new ActionButtonDevice({ id: "off-button", name: "Off button" }, { device: target.id, control: "turnOff" }, {}, { device: () => target });
    const pair = new OptimisticSwitchDevice({ id: "pair", name: "Button pair" }, { onButton: on.id, offButton: off.id, initialState: "off" }, {}, { device: id => id === on.id ? on : off });
    const hub = new StateHub();
    const app = createApp(undefined, new Site([target, on, off, pair]), store, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, hub);
    await hub.data.refresh();
    const html = await (await app.request("/switches/button-pair/settings")).text();
    expect(html).toContain('href="/buttons/on-button"');
    expect(html).toContain('href="/buttons/off-button"');
    expect(html).toContain('href="/switches/target-device"');
    expect(html).toContain("Target &lt;device&gt;");
    expect(html).toContain(`Saved command: Lights on (${saved.id})`);
    expect(html).toContain(escapeHtml('radioFrequencyBlaster.send({"code":"AAEC","durationMs":250})'));
    expect(html).toContain(escapeHtml('invokeControl("turnOff")'));
    expect(html).toContain("Refresh does not query the hardware");
    expect(html).toContain("Initial state: off.");
    await hub.data.signals.remove(target.id, saved.id);
    expect(await (await app.request("/switches/button-pair/settings")).text()).toContain("This saved command could not be loaded");
  });

  test("shows inverted synthetic scene mappings instead of pretending every member turns on", async () => {
    const one = new ShellyPlus1({ id: "one", name: "One" }, { host: "10.77.0.10" });
    const two = new ShellyPlus1({ id: "two", name: "Two" }, { host: "10.77.0.11" });
    const scene = new SyntheticSwitchDevice({ id: "scene", name: "Scene" }, { members: [
      { device: one.id, on: "on", off: "off" }, { device: two.id, on: "off", off: "on" },
    ] }, { device: id => id === one.id ? one : two });
    const app = createApp(undefined, new Site([one, two, scene]));
    const html = await (await app.request("/switches/scene/settings")).text();
    const on = html.split("<dt>On</dt>")[1]!.split("<dt>Off</dt>")[0]!;
    expect(on).toMatch(/href="\/switches\/one"[\s\S]*?binarySwitch.turnOn\(\)/);
    expect(on).toMatch(/href="\/switches\/two"[\s\S]*?binarySwitch.turnOff\(\)/);
    expect(html).toContain("Other readable combinations return Off");
  });
});
