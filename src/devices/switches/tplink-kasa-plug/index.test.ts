import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import {
  TPLINK_KASA_ENERGY_METER,
  TPLINK_KASA_PLUG,
  TplinkKasaEnergyMeter,
  TplinkKasaPlug,
  reportsProduct,
  type TplinkKasaPlugConfig,
} from ".";
import { Site, registeredView } from "../../../site";
import { validators } from "../../../validation";
import type { KasaTransport } from "../../../protocols/tplink-kasa/client";
import { decodeKasaFrame, encodeKasaFrame, KasaError } from "../../../protocols/tplink-kasa/codec";

const DEVICE_ID = "0123456789ABCDEF0123456789ABCDEF01234567";
const SW = "1.0.2 Build 000000 Rel.000000";
const child = (index: number, state: 0 | 1) => ({ id: `${DEVICE_ID}0${index}`, alias: `Outlet ${index + 1}`, state, on_time: 0, next_action: { type: -1 } });

function sysinfo(model: string, extra: Record<string, unknown>) {
  return { system: { get_sysinfo: { sw_ver: SW, hw_ver: "1.0", model, deviceId: DEVICE_ID, oemId: "0".repeat(32), hwId: "0".repeat(32), alias: "Synthetic plug", mac: "00:11:22:33:44:55", mic_type: "IOT.SMARTPLUGSWITCH", err_code: 0, ...extra } } };
}
const EP10 = (state: 0 | 1) => sysinfo("EP10(US)", { relay_state: state, feature: "TIM" });
const EP40 = (states: [0 | 1, 0 | 1]) => sysinfo("EP40(US)", { feature: "TIM", child_num: 2, children: states.map((state, index) => child(index, state)) });
const KP115 = (state: 0 | 1) => sysinfo("KP115(US)", { relay_state: state, feature: "TIM:ENE" });
const HS300 = (states: (0 | 1)[]) => sysinfo("HS300(US)", { feature: "TIM:ENE", child_num: 6, children: states.map((state, index) => child(index, state)) });

/** A fake device: answers each decoded request with `answer`, recording what was sent. */
function fake(answer: (request: Record<string, unknown>) => unknown) {
  const sent: Record<string, unknown>[] = [];
  const transport: KasaTransport = async (_host, port, frame, timeoutMs) => {
    expect(port).toBe(9999);
    expect(timeoutMs).toBe(5000);
    const request = decodeKasaFrame(frame);
    sent.push(request);
    const response = answer(request);
    if (response instanceof Error) throw response;
    return encodeKasaFrame(response);
  };
  return { transport, sent };
}

const relayOk = { system: { set_relay_state: { err_code: 0 } } };
const isSet = (request: Record<string, unknown>) => JSON.stringify(request).includes("set_relay_state");
const make = (config: TplinkKasaPlugConfig, transport: KasaTransport, id = "plug") => new TplinkKasaPlug({ id, name: "Synthetic plug" }, config, { transport });

describe("TP-Link Kasa plug (single outlet)", () => {
  test("getState maps relay_state 1 and 0", async () => {
    let state: 0 | 1 = 1;
    const device = make({ host: "192.168.50.10", model: "EP10" }, fake(() => EP10(state)).transport);
    expect(await device.getState()).toBe("on");
    state = 0;
    expect(await device.getState()).toBe("off");
  });

  test("turnOn and turnOff send set_relay_state without a child context", async () => {
    const device = fake((request) => isSet(request) ? relayOk : EP10(0));
    const plug = make({ host: "192.168.50.10", model: "EP10" }, device.transport);
    await plug.invokeControl("turnOn");
    await plug.invokeControl("turnOff");
    expect(device.sent).toEqual([{ system: { set_relay_state: { state: 1 } } }, { system: { set_relay_state: { state: 0 } } }]);
  });

  test("toggle reads the current state and writes the opposite", async () => {
    const device = fake((request) => isSet(request) ? relayOk : EP10(1));
    await make({ host: "192.168.50.10", model: "EP10" }, device.transport).invokeControl("toggle");
    expect(device.sent).toEqual([{ system: { get_sysinfo: {} } }, { system: { set_relay_state: { state: 0 } } }]);
  });

  test("describe is a valid online binary switch with reported identity", async () => {
    const plug = make({ host: "192.168.50.10", model: "EP10" }, fake(() => EP10(1)).transport);
    const object = await plug.describe();
    expect(validators.homeTruthObject(object)).toBe(true);
    expect(object).toMatchObject({ status: "online", manufacturer: "TP-Link", model: "EP10(US)", firmwareVersion: SW });
    expect(object.capabilities.binarySwitch).toMatchObject({ state: { availability: "online", value: "on" } });
  });

  test("a malformed relay_state is a protocol error and reads as offline, never Off", async () => {
    const plug = make({ host: "192.168.50.10", model: "EP10" }, fake(() => sysinfo("EP10(US)", { relay_state: "off" })).transport);
    await expect(plug.getState()).rejects.toMatchObject({ code: "protocol" });
    const object = await plug.describe();
    expect(object.status).toBe("offline");
    expect(object.capabilities.binarySwitch).toMatchObject({ state: { availability: "offline" } });
    expect(object.capabilities.binarySwitch!.state).not.toHaveProperty("value");
  });

  test("an unreachable host makes describe offline and probe reject", async () => {
    const plug = make({ host: "192.168.50.10", model: "EP10" }, fake(() => new KasaError("Kasa device at 192.168.50.10 is unreachable: timeout", "unreachable")).transport);
    await expect(plug.getState()).rejects.toMatchObject({ name: "BinarySwitchError", code: "unreachable" });
    expect((await plug.describe()).status).toBe("offline");
    await expect(plug.probe()).rejects.toMatchObject({ code: "unreachable" });
  });

  test("a failed write surfaces as unreachable, not as a state", async () => {
    const device = fake((request) => isSet(request) ? new KasaError("down", "unreachable") : EP10(0));
    await expect(make({ host: "192.168.50.10", model: "EP10" }, device.transport).turnOn()).rejects.toMatchObject({ code: "unreachable" });
  });

  test("a device error answer to a write is a protocol error", async () => {
    const device = fake(() => ({ system: { set_relay_state: { err_code: -1, err_msg: "module not support" } } }));
    await expect(make({ host: "192.168.50.10", model: "EP10" }, device.transport).turnOn()).rejects.toMatchObject({ code: "protocol" });
  });

  test("probe checks the reported model and returns identity", async () => {
    expect(await make({ host: "192.168.50.10", model: "EP10" }, fake(() => EP10(0)).transport).probe()).toEqual({ model: "EP10(US)", firmwareVersion: SW });
    const wrong = make({ host: "192.168.50.10", model: "EP10" }, fake(() => KP115(0)).transport);
    await expect(wrong.probe()).rejects.toThrow("reports KP115(US), not EP10");
    // A different product at the address is not this switch's state.
    expect((await wrong.describe()).status).toBe("offline");
  });

  test("a single-outlet model reporting children is rejected", async () => {
    const plug = make({ host: "192.168.50.10", model: "EP10" }, fake(() => sysinfo("EP10(US)", { children: [child(0, 1)] })).transport);
    await expect(plug.probe()).rejects.toThrow("did not report its relay state");
  });

  test("concurrent describe and probe share one sysinfo request", async () => {
    const device = fake(() => EP10(1));
    const plug = make({ host: "192.168.50.10", model: "EP10" }, device.transport);
    await Promise.all([plug.describe(), plug.probe()]);
    expect(device.sent).toHaveLength(1);
  });

  test("checkHealth is read-only: healthy, unhealthy when unreachable, disabled when disabled", async () => {
    const ok = fake(() => EP10(1));
    const healthy = make({ host: "192.168.50.10", model: "EP10" }, ok.transport);
    expect((await healthy.checkHealth()).status).toBe("healthy");
    expect(ok.sent.every((request) => !isSet(request))).toBe(true);

    const down = make({ host: "192.168.50.10", model: "EP10" }, fake(() => new KasaError("down", "unreachable")).transport);
    expect(await down.checkHealth()).toMatchObject({ status: "unhealthy", reason: "unreachable" });

    const off = make({ host: "192.168.50.10", model: "EP10" }, fake(() => { throw new Error("must not be contacted"); }).transport);
    off.enabled = false;
    expect((await off.checkHealth()).status).toBe("disabled");
  });
});

describe("TP-Link Kasa plug (multi-outlet)", () => {
  test("EP40 outlets read their own child state", async () => {
    const device = fake(() => EP40([0, 1]));
    expect(await make({ host: "192.168.50.11", model: "EP40", outlet: 0 }, device.transport, "a").getState()).toBe("off");
    expect(await make({ host: "192.168.50.11", model: "EP40", outlet: 1 }, device.transport, "b").getState()).toBe("on");
  });

  test("writes address the outlet's full child id in context", async () => {
    const device = fake((request) => isSet(request) ? relayOk : EP40([0, 0]));
    const outlet = make({ host: "192.168.50.11", model: "EP40", outlet: 1 }, device.transport);
    await outlet.turnOn();
    await outlet.turnOff();
    expect(device.sent).toEqual([
      { system: { get_sysinfo: {} } },
      { context: { child_ids: [`${DEVICE_ID}01`] }, system: { set_relay_state: { state: 1 } } },
      { context: { child_ids: [`${DEVICE_ID}01`] }, system: { set_relay_state: { state: 0 } } },
    ]);
  });

  test("toggle flips only the configured outlet", async () => {
    const device = fake((request) => isSet(request) ? relayOk : HS300([0, 0, 0, 1, 0, 0]));
    await make({ host: "192.168.50.12", model: "HS300", outlet: 3 }, device.transport).toggle();
    expect(device.sent.at(-1)).toEqual({ context: { child_ids: [`${DEVICE_ID}03`] }, system: { set_relay_state: { state: 0 } } });
  });

  test("a strip reporting the wrong outlet count is rejected", async () => {
    const plug = make({ host: "192.168.50.12", model: "HS300", outlet: 0 }, fake(() => HS300([0, 0])).transport);
    await expect(plug.probe()).rejects.toThrow("did not report 6 outlets");
  });

  test("outlet must match the product's outlet count", () => {
    const transport = fake(() => EP10(0)).transport;
    expect(() => make({ host: "192.168.50.11", model: "EP40" }, transport)).toThrow("needs outlet from 0 to 1");
    expect(() => make({ host: "192.168.50.11", model: "EP40", outlet: 2 }, transport)).toThrow("needs outlet from 0 to 1");
    expect(() => make({ host: "192.168.50.10", model: "KP115", outlet: 0 }, transport)).toThrow("has one outlet");
    expect(() => make({ host: "192.168.50.12", model: "HS300", outlet: 5 }, transport)).not.toThrow();
  });

  test("public hosts are refused before any request", () => {
    const transport = fake(() => { throw new Error("must not be contacted"); }).transport;
    expect(() => make({ host: "8.8.8.8", model: "EP10" }, transport)).toThrow("private LAN address");
    expect(() => make({ host: "plug.example.com", model: "EP10" }, transport)).toThrow("private LAN address");
    expect(() => make({ host: "plug.local", model: "EP10" }, transport)).not.toThrow();
  });
});

describe("TP-Link Kasa energy meter", () => {
  const meter = (plug: TplinkKasaPlug) => new TplinkKasaEnergyMeter({ id: `${plug.id}-energy`, name: "Synthetic meter" }, { plug: plug.id }, plug);

  test("KP115 reads power, voltage, current and energy in W, V, A and kWh", async () => {
    const device = fake((request) => "emeter" in request
      ? { emeter: { get_realtime: { voltage_mv: 121345, current_ma: 512, power_mw: 58210, total_wh: 12034, err_code: 0 } } }
      : KP115(1));
    const plug = make({ host: "192.168.50.13", model: "KP115" }, device.transport);
    const object = await meter(plug).describe();
    expect(validators.homeTruthObject(object)).toBe(true);
    expect(object).toMatchObject({ status: "online", parent: { id: "plug", index: 0 } });
    const sensors = object.capabilities.sensor!.state.sensors;
    expect(sensors.map(({ id, quantity, unit, value }) => ({ id, quantity, unit, value }))).toEqual([
      { id: "power", quantity: "power", unit: "W", value: 58.21 },
      { id: "voltage", quantity: "voltage", unit: "V", value: 121.345 },
      { id: "current", quantity: "current", unit: "A", value: 0.512 },
      { id: "energy", quantity: "energy", unit: "kWh", value: 12.034 },
    ]);
    expect(device.sent).toEqual([{ emeter: { get_realtime: {} } }]);
  });

  test("older firmware float fields are accepted", async () => {
    const device = fake((request) => "emeter" in request ? { emeter: { get_realtime: { voltage: 120.2, current: 0.2, power: 10.5, total: 3.25, err_code: 0 } } } : KP115(1));
    const sensors = (await meter(make({ host: "192.168.50.13", model: "KP115" }, device.transport)).describe()).capabilities.sensor!.state.sensors;
    expect(sensors.map((sensor) => sensor.value)).toEqual([10.5, 120.2, 0.2, 3.25]);
  });

  test("HS300 outlet meter reads through the outlet's child context", async () => {
    const device = fake((request) => "emeter" in request ? { emeter: { get_realtime: { voltage_mv: 120000, current_ma: 0, power_mw: 0, total_wh: 0, err_code: 0 } } } : HS300([1, 1, 1, 1, 1, 1]));
    const plug = make({ host: "192.168.50.12", model: "HS300", outlet: 4 }, device.transport);
    const object = await meter(plug).describe();
    expect(object.status).toBe("online");
    expect(object.capabilities.sensor!.state.sensors.find((sensor) => sensor.id === "power")).toMatchObject({ availability: "online", value: 0 });
    expect(device.sent).toEqual([{ system: { get_sysinfo: {} } }, { context: { child_ids: [`${DEVICE_ID}04`] }, emeter: { get_realtime: {} } }]);
  });

  test("a missing reading is unknown and the collection degraded", async () => {
    const device = fake((request) => "emeter" in request ? { emeter: { get_realtime: { power_mw: 1000, err_code: 0 } } } : KP115(1));
    const state = (await meter(make({ host: "192.168.50.13", model: "KP115" }, device.transport)).describe()).capabilities.sensor!.state;
    expect(state.availability).toBe("degraded");
    expect(state.sensors.map((sensor) => sensor.availability)).toEqual(["online", "unknown", "unknown", "unknown"]);
  });

  test("an unreachable meter is offline with no values", async () => {
    const plug = make({ host: "192.168.50.13", model: "KP115" }, fake(() => new KasaError("down", "unreachable")).transport);
    const energy = meter(plug);
    const object = await energy.describe();
    expect(object.status).toBe("offline");
    expect(object.capabilities.sensor!.state.sensors.every((sensor) => sensor.availability === "offline" && sensor.value === undefined)).toBe(true);
    await expect(energy.probe()).rejects.toMatchObject({ code: "unreachable" });
    expect((await energy.checkHealth()).status).toBe("unhealthy");
  });

  test("probe checks the plug's model and reads the meter", async () => {
    const device = fake((request) => "emeter" in request ? { emeter: { get_realtime: { power_mw: 0, voltage_mv: 0, current_ma: 0, total_wh: 0, err_code: 0 } } } : KP115(0));
    expect(await meter(make({ host: "192.168.50.13", model: "KP115" }, device.transport)).probe()).toEqual({ model: "KP115(US) energy meter", firmwareVersion: SW });
  });

  test("refuses a plug without a meter", () => {
    const plug = make({ host: "192.168.50.10", model: "EP10" }, fake(() => EP10(0)).transport);
    expect(() => meter(plug)).toThrow("has no energy meter");
  });
});

describe("models and config", () => {
  test("reportsProduct accepts region suffixes only", () => {
    expect(reportsProduct("EP40(US)", "EP40")).toBe(true);
    expect(reportsProduct("HS300", "HS300")).toBe(true);
    expect(reportsProduct("EP40M(US)", "EP40")).toBe(false);
    expect(reportsProduct("KP115(US)", "EP10")).toBe(false);
  });

  test("plug config schema accepts examples and rejects public-looking hosts and unknown keys", () => {
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(TPLINK_KASA_PLUG.configSchema);
    expect(validate({ host: "192.168.50.10", model: "EP10" })).toBe(true);
    expect(validate({ host: "192.168.50.12", model: "HS300", outlet: 5, timeoutMs: 5000 })).toBe(true);
    expect(validate({ host: "192.168.50.10" })).toBe(false);
    expect(validate({ host: "192.168.50.10", model: "HS110" })).toBe(false);
    expect(validate({ host: "http://192.168.50.10/", model: "EP10" })).toBe(false);
    expect(validate({ host: "192.168.50.10", model: "EP10", password: "x" })).toBe(false);
    expect(validate({ host: "192.168.50.12", model: "HS300", outlet: 6 })).toBe(false);
  });

  test("energy meter config schema", () => {
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(TPLINK_KASA_ENERGY_METER.configSchema);
    expect(validate({ plug: "desk-plug" })).toBe(true);
    expect(validate({})).toBe(false);
    expect(validate({ plug: "desk-plug", host: "192.168.50.10" })).toBe(false);
  });

  test("provisions as a binary-switch page and a contained sensor page", () => {
    const models = [TPLINK_KASA_PLUG, TPLINK_KASA_ENERGY_METER];
    const site = Site.fromConfig({
      schemaVersion: 2,
      devices: [
        { id: "strip-1", name: "Strip outlet 1", model: "tplink-kasa-plug", config: { host: "192.168.50.12", model: "HS300", outlet: 0 } },
        { id: "strip-1-energy", name: "Strip outlet 1 energy", model: "tplink-kasa-energy-meter", config: { plug: "strip-1" } },
      ],
    }, {}, undefined, models);
    const plug = site.get("strip-1")!;
    const energy = site.get("strip-1-energy")!;
    expect(plug).toBeInstanceOf(TplinkKasaPlug);
    expect(energy).toBeInstanceOf(TplinkKasaEnergyMeter);
    expect(registeredView(plug).kind).toBe("binary-switch");
    expect(registeredView(energy).kind).toBe("sensor");
    expect(energy.parent).toEqual({ id: "strip-1", index: 0 });
    expect(TPLINK_KASA_PLUG.capabilities).toEqual(["binarySwitch"]);
    expect(TPLINK_KASA_PLUG.secretsSchema).toBeUndefined();
  });

  test("an energy meter on a non-metering plug fails provisioning", () => {
    expect(() => Site.fromConfig({
      schemaVersion: 2,
      devices: [
        { id: "porch", name: "Porch", model: "tplink-kasa-plug", config: { host: "192.168.50.11", model: "EP40", outlet: 0 } },
        { id: "porch-energy", name: "Porch energy", model: "tplink-kasa-energy-meter", config: { plug: "porch" } },
      ],
    }, {}, undefined, [TPLINK_KASA_PLUG, TPLINK_KASA_ENERGY_METER])).toThrow("has no energy meter");
  });
});
