import { describe, expect, test } from "bun:test";
import { ShellyGen2Switch, type ShellyFetch } from "../devices/switches/shelly-plus-1";
import { binarySwitchSchema } from "../schemas";
import { validators } from "../validation";
import { BinarySwitch, BinarySwitchError, type BinarySwitchState } from "./binary-switch";

class MemorySwitch extends BinarySwitch {
  constructor(id: string, private state: BinarySwitchState = "off") {
    super(id);
  }
  async turnOn(): Promise<void> { this.state = "on"; }
  async turnOff(): Promise<void> { this.state = "off"; }
  async toggle(): Promise<void> { this.state = this.state === "on" ? "off" : "on"; }
  async getState(): Promise<BinarySwitchState> { return this.state; }
}

class BrokenSwitch extends MemorySwitch {
  override async getState(): Promise<BinarySwitchState> { throw new Error("no link"); }
}

function fakeShelly(initialOn: boolean, failWith?: () => Response | Error) {
  const calls: string[] = [];
  let on = initialOn;
  const fetchImpl: ShellyFetch = async (url) => {
    calls.push(`${url.pathname}${url.search}`);
    if (failWith) {
      const failure = failWith();
      if (failure instanceof Error) throw failure;
      return failure;
    }
    const id = url.searchParams.get("id");
    switch (url.pathname) {
      case "/rpc/Switch.Set": {
        const wasOn = on;
        on = url.searchParams.get("on") === "true";
        return Response.json({ was_on: wasOn, id });
      }
      case "/rpc/Switch.Toggle": {
        const wasOn = on;
        on = !on;
        return Response.json({ was_on: wasOn, id });
      }
      case "/rpc/Switch.GetStatus":
        return Response.json({ id: 0, source: "SHC", output: on, temperature: { tC: 40.8 } });
      default:
        return new Response("Not Found", { status: 404 });
    }
  };
  return { calls, fetchImpl, isOn: () => on };
}

describe("binary switch schema", () => {
  const document = {
    id: "porch-relay",
    state: { availability: "online", value: "on", observedAt: "2026-09-03T20:00:00Z" },
    actions: { turnOn: {}, turnOff: {}, toggle: {}, getState: {} },
  } as const;

  test("accepts an on/off switch that advertises all four actions", () => {
    expect(validators.binarySwitch(document), JSON.stringify(validators.binarySwitch.errors)).toBe(true);
    for (const example of binarySwitchSchema.examples) {
      expect(validators.binarySwitch(example)).toBe(true);
    }
  });

  test("allows an offline switch with an unknown state", () => {
    expect(validators.binarySwitch({ ...document, state: { availability: "offline" } })).toBe(true);
  });

  test("rejects a third state, a state without an observation time, and a missing action", () => {
    expect(validators.binarySwitch({ ...document, state: { ...document.state, value: "dimmed" } })).toBe(false);
    expect(validators.binarySwitch({ ...document, state: { availability: "online", value: "on" } })).toBe(false);
    const { getState: _omitted, ...threeActions } = document.actions;
    expect(validators.binarySwitch({ ...document, actions: threeActions })).toBe(false);
    expect(validators.binarySwitch({ ...document, actions: { ...document.actions, dim: {} } })).toBe(false);
  });

  test("composes onto a HomeTruth object", () => {
    expect(validators.homeTruthObject({
      schemaVersion: 1,
      id: "porch-relay-box",
      name: "Porch relay",
      capabilities: { binarySwitch: document },
    })).toBe(true);
  });
});

describe("BinarySwitchDevice", () => {
  test("implementations honor the four-method contract", async () => {
    const device = new MemorySwitch("memory");
    expect(await device.getState()).toBe("off");
    await device.turnOn();
    expect(await device.getState()).toBe("on");
    await device.turnOn();
    expect(await device.getState()).toBe("on");
    await device.toggle();
    expect(await device.getState()).toBe("off");
    await device.toggle();
    expect(await device.getState()).toBe("on");
    await device.turnOff();
    expect(await device.getState()).toBe("off");
    await device.turnOff();
    expect(await device.getState()).toBe("off");
  });

  test("describes itself as a valid BinarySwitch document", async () => {
    const described = await new MemorySwitch("memory", "on").describe();
    expect(validators.binarySwitch(described)).toBe(true);
    expect(described.state.availability).toBe("online");
    expect(described.state.value).toBe("on");
    expect(Object.keys(described.actions).sort()).toEqual(["getState", "toggle", "turnOff", "turnOn"]);
  });

  test("reports an unreadable switch as offline instead of inventing a state", async () => {
    const described = await new BrokenSwitch("broken").describe();
    expect(validators.binarySwitch(described)).toBe(true);
    expect(described.state).toEqual({ availability: "offline" });
  });
});

describe("ShellyGen2Switch", () => {
  test("maps the contract onto Shelly Switch RPC calls", async () => {
    const shelly = fakeShelly(false);
    const device = new ShellyGen2Switch({ id: "relay", host: "10.77.0.228", fetch: shelly.fetchImpl });

    expect(await device.getState()).toBe("off");
    await device.turnOn();
    expect(shelly.isOn()).toBe(true);
    expect(await device.getState()).toBe("on");
    await device.toggle();
    expect(await device.getState()).toBe("off");
    await device.turnOff();
    expect(await device.getState()).toBe("off");

    expect(shelly.calls).toEqual([
      "/rpc/Switch.GetStatus?id=0",
      "/rpc/Switch.Set?id=0&on=true",
      "/rpc/Switch.GetStatus?id=0",
      "/rpc/Switch.Toggle?id=0",
      "/rpc/Switch.GetStatus?id=0",
      "/rpc/Switch.Set?id=0&on=false",
      "/rpc/Switch.GetStatus?id=0",
    ]);
  });

  test("addresses the requested channel", async () => {
    const shelly = fakeShelly(true);
    const device = new ShellyGen2Switch({ id: "relay", host: "shelly.local", channel: 1, fetch: shelly.fetchImpl });
    await device.turnOff();
    expect(shelly.calls).toEqual(["/rpc/Switch.Set?id=1&on=false"]);
  });

  test("refuses hosts outside the local network", () => {
    expect(() => new ShellyGen2Switch({ id: "relay", host: "8.8.8.8" })).toThrow(BinarySwitchError);
    expect(() => new ShellyGen2Switch({ id: "relay", host: "example.com" })).toThrow(BinarySwitchError);
    expect(() => new ShellyGen2Switch({ id: "relay", host: "10.77.0.228/../" })).toThrow(BinarySwitchError);
    expect(() => new ShellyGen2Switch({ id: "relay", host: "10.77.0.228", channel: -1 })).toThrow(BinarySwitchError);
  });

  test("surfaces unreachable relays and malformed replies as typed errors", async () => {
    const unreachable = new ShellyGen2Switch({
      id: "relay",
      host: "10.77.0.228",
      fetch: fakeShelly(false, () => new Error("EHOSTUNREACH")).fetchImpl,
    });
    await expect(unreachable.getState()).rejects.toMatchObject({ code: "unreachable" });

    const httpError = new ShellyGen2Switch({
      id: "relay",
      host: "10.77.0.228",
      fetch: fakeShelly(false, () => Response.json({ code: -103, message: "bad" }, { status: 400 })).fetchImpl,
    });
    await expect(httpError.turnOn()).rejects.toMatchObject({ code: "protocol" });

    const notJson = new ShellyGen2Switch({
      id: "relay",
      host: "10.77.0.228",
      fetch: fakeShelly(false, () => new Response("<html>", { status: 200 })).fetchImpl,
    });
    await expect(notJson.getState()).rejects.toMatchObject({ code: "protocol" });

    const noOutput = new ShellyGen2Switch({
      id: "relay",
      host: "10.77.0.228",
      fetch: fakeShelly(false, () => Response.json({ id: 0 })).fetchImpl,
    });
    await expect(noOutput.getState()).rejects.toMatchObject({ code: "protocol" });
    expect(await noOutput.describe()).toMatchObject({ state: { availability: "offline" } });
  });
});
