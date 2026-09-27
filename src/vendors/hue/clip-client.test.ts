import { describe, expect, test } from "bun:test";
import { HueClipClient, HueClipError, hexToXy, xyToHex } from "./clip-client";

describe("hexToXy / xyToHex", () => {
  test("pure red round-trips close to red", () => {
    const [x, y] = hexToXy("#ff0000");
    const hex = xyToHex(x, y, 100);
    // Gamut clipping/rounding means this won't be exact; just check it reads as "red-ish".
    expect(hex.startsWith("#")).toBe(true);
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    expect(r).toBeGreaterThan(g);
    expect(r).toBeGreaterThan(b);
  });

  test("white maps near the D65-ish white point", () => {
    const [x, y] = hexToXy("#ffffff");
    expect(x).toBeCloseTo(0.3127, 1);
    expect(y).toBeCloseTo(0.329, 1);
  });

  test("black does not divide by zero", () => {
    expect(() => hexToXy("#000000")).not.toThrow();
  });

  test("rejects a malformed hex string", () => {
    expect(() => hexToXy("red")).toThrow(HueClipError);
    expect(() => hexToXy("#zzzzzz")).toThrow(HueClipError);
  });

  test("xyToHex clamps to a valid byte range", () => {
    const hex = xyToHex(0.9, 0.9, 100); // far outside any real gamut
    expect(/^#[0-9a-f]{6}$/u.test(hex)).toBe(true);
  });
});

function fakeFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const { status, body } = handler(url, init);
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

describe("HueClipClient", () => {
  test("rejects a non-LAN host", () => {
    expect(() => new HueClipClient({ host: "hue.example.com", applicationKey: "key" })).toThrow(HueClipError);
  });

  test("startEntertainment PUTs the start action", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const client = new HueClipClient({
      host: "10.77.0.29",
      applicationKey: "appkey",
      fetch: fakeFetch((url, init) => {
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return { status: 200, body: { data: [{ rid: "area-1", rtype: "entertainment_configuration" }], errors: [] } };
      }),
    });
    await client.startEntertainment("area-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/entertainment_configuration/area-1");
    expect(calls[0]!.body).toEqual({ action: "start" });
  });

  test("getLightState reads on/brightness/color", async () => {
    const client = new HueClipClient({
      host: "10.77.0.29",
      applicationKey: "appkey",
      fetch: fakeFetch(() => ({
        status: 200,
        body: { data: [{ id: "light-1", type: "light", on: { on: true }, dimming: { brightness: 75 }, color: { xy: { x: 0.3, y: 0.3 } } }], errors: [] },
      })),
    });
    const state = await client.getLightState("light-1");
    expect(state.on).toBe(true);
    expect(state.brightnessPercent).toBe(75);
    expect(state.color).toMatch(/^#[0-9a-f]{6}$/u);
  });

  test("getLightState throws not_found for an empty data array", async () => {
    const client = new HueClipClient({
      host: "10.77.0.29",
      applicationKey: "appkey",
      fetch: fakeFetch(() => ({ status: 200, body: { data: [], errors: [] } })),
    });
    await expect(client.getLightState("nope")).rejects.toThrow(HueClipError);
  });

  test("a non-2xx response throws protocol error", async () => {
    const client = new HueClipClient({
      host: "10.77.0.29",
      applicationKey: "appkey",
      fetch: fakeFetch(() => ({ status: 500, body: {} })),
    });
    await expect(client.turnOn("light-1")).rejects.toThrow(HueClipError);
  });

  test("a bridge error array throws protocol error even with HTTP 200", async () => {
    const client = new HueClipClient({
      host: "10.77.0.29",
      applicationKey: "appkey",
      fetch: fakeFetch(() => ({ status: 200, body: { data: [], errors: [{ description: "bad request" }] } })),
    });
    await expect(client.turnOn("light-1")).rejects.toThrow(HueClipError);
  });

  test("a fetch that throws is reported as unreachable", async () => {
    const client = new HueClipClient({
      host: "10.77.0.29",
      applicationKey: "appkey",
      fetch: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
    });
    await expect(client.turnOn("light-1")).rejects.toThrow(HueClipError);
  });

  test("setColorHex sends xy derived from the hex value", async () => {
    const calls: unknown[] = [];
    const client = new HueClipClient({
      host: "10.77.0.29",
      applicationKey: "appkey",
      fetch: fakeFetch((_url, init) => {
        calls.push(init?.body ? JSON.parse(String(init.body)) : undefined);
        return { status: 200, body: { data: [{}], errors: [] } };
      }),
    });
    await client.setColorHex("light-1", "#00ff00");
    const body = calls[0] as { color: { xy: { x: number; y: number } } };
    expect(body.color.xy.x).toBeGreaterThan(0);
    expect(body.color.xy.y).toBeGreaterThan(0);
  });
});

test("Kelvin converts to mirek, respects hardware bounds, and reads actual white mode", async () => {
  const writes: unknown[] = [];
  const client = new HueClipClient({ host: "10.77.0.29", applicationKey: "test", fetch: fakeFetch((_url, init) => {
    if (init?.method === "PUT") writes.push(JSON.parse(String(init.body)));
    return { status: 200, body: { data: [{ id: "light", type: "light", on: { on: true }, dimming: { brightness: 20 }, color_temperature: { mirek: 370, mirek_valid: true, mirek_schema: { mirek_minimum: 153, mirek_maximum: 500 } } }], errors: [] } };
  }) });
  await client.setColorTemperature("light", 2700);
  expect(writes).toEqual([{ color_temperature: { mirek: 370 } }]);
  expect((await client.getLightState("light")).colorTemperatureKelvin).toBe(2703);
  await expect(client.setColorTemperature("light", 7000)).rejects.toThrow();
  await expect(client.setColorTemperature("light", NaN)).rejects.toThrow();
  await expect(client.setBrightness("light", 101)).rejects.toThrow();
  expect(writes).toHaveLength(1);
});

test("color readback is independent of dimmer and does not invent a temperature in color mode", async () => {
  let brightness = 100;
  const [x, y] = hexToXy("#ff8800");
  const client = new HueClipClient({ host: "10.77.0.29", applicationKey: "test", fetch: fakeFetch(() => ({ status: 200, body: { data: [{ id: "light", type: "light", on: { on: true }, dimming: { brightness }, color: { xy: { x, y } }, color_temperature: { mirek: null, mirek_valid: false } }], errors: [] } })) });
  const full = await client.getLightState("light");
  brightness = 10;
  await client.listResources(); // Refresh the bridge snapshot after the simulated external change.
  const dim = await client.getLightState("light");
  expect(dim.color).toBe(full.color);
  expect(dim.colorTemperatureKelvin).toBeUndefined();
  expect(dim.brightnessPercent).toBe(10);
});

test("normalizing RGB together preserves a mixed color through xy", () => {
  const [x, y] = hexToXy("#ff8800");
  const color = xyToHex(x, y, 100);
  expect(parseInt(color.slice(1, 3), 16)).toBe(255);
  expect(Math.abs(parseInt(color.slice(3, 5), 16) - 136)).toBeLessThan(3);
});

test("black turns the light off instead of sending a white chromaticity", async () => {
  const writes: unknown[] = [];
  const client = new HueClipClient({ host: "10.77.0.29", applicationKey: "test", fetch: fakeFetch((_url, init) => {
    writes.push(JSON.parse(String(init?.body)));
    return { status: 200, body: { data: [{}], errors: [] } };
  }) });
  await client.setColorHex("light", "#000000");
  expect(writes).toEqual([{ on: { on: false } }]);
});

test("a dashboard shares one inventory read for all lights and refreshes after a write", async () => {
  let reads = 0;
  let brightness = 50;
  const client = new HueClipClient({ host: "10.77.0.29", applicationKey: "test", fetch: fakeFetch((_url, init) => {
    if (init?.method === "PUT") brightness = JSON.parse(String(init.body)).dimming.brightness;
    else reads++;
    return { status: 200, body: { data: Array.from({ length: 21 }, (_, n) => ({ id: `light-${n}`, type: "light", on: { on: true }, dimming: { brightness } })), errors: [] } };
  }) });
  await Promise.all(Array.from({ length: 21 }, (_, n) => client.getLightState(`light-${n}`)));
  expect(reads).toBe(1);
  await client.setBrightness("light-0", 80);
  expect((await client.getLightState("light-0")).brightnessPercent).toBe(80);
  expect(reads).toBe(2);
});
