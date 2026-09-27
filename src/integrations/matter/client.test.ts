import { describe, expect, test } from "bun:test";
import { HomeTruthSwitchClient } from "./client.ts";

function fakeFetch(handler: (url: URL, init: RequestInit) => Response | Promise<Response>): typeof globalThis.fetch {
  return ((input: string | URL | Request, init?: RequestInit) => Promise.resolve(handler(
    new URL(input instanceof Request ? input.url : input), init ?? {},
  ))) as typeof globalThis.fetch;
}

function state(id = "relay", value = "off", availability = "online") {
  return { id, state: { availability, value, observedAt: "2026-09-08T00:00:00Z" } };
}

describe("HomeTruthSwitchClient", () => {
  test("discovers all binary switches, including offline and synthetic switches, without including lights or buttons", async () => {
    const client = new HomeTruthSwitchClient({
      url: "http://127.0.0.1:3000",
      fetch: fakeFetch((url, init) => {
        expect(url.href).toBe("http://127.0.0.1:3000/api/devices");
        expect(init.method).toBe("GET");
        expect(init.signal).toBeInstanceOf(AbortSignal);
        return Response.json({ devices: [
          { id: "relay", name: "Relay", capabilities: ["binarySwitch"], availability: "offline" },
          { id: "lamp", name: "Lamp", capabilities: ["light"] },
          { id: "scene", name: "Evening", capabilities: ["binarySwitch"] },
          { id: "candles-on", name: "Candles on", capabilities: ["button"] },
          { id: "candles", name: "Candles", capabilities: ["binarySwitch"], room: "Living Room" },
        ] });
      }),
    });
    expect(await client.discover()).toEqual([{ id: "relay", name: "Relay" }, { id: "scene", name: "Evening" }, { id: "candles", name: "Candles", room: "Living Room" }]);
  });

  test("rejects malformed inventories and duplicate device identities", async () => {
    for (const body of [null, {}, { devices: {} }, { devices: [null] }, { devices: [{ id: "relay", name: "Relay", capabilities: "binarySwitch" }] }]) {
      const client = new HomeTruthSwitchClient({ fetch: fakeFetch(() => Response.json(body)) });
      await expect(client.discover()).rejects.toThrow("invalid device");
    }
    const relay = { id: "relay", name: "Relay", capabilities: ["binarySwitch"] };
    const duplicate = new HomeTruthSwitchClient({ fetch: fakeFetch(() => Response.json({ devices: [relay, relay] })) });
    await expect(duplicate.discover()).rejects.toThrow("duplicate device id relay");
  });

  test("reads exact observed on and off values and safely encodes device ids", async () => {
    let on = false;
    const client = new HomeTruthSwitchClient({
      url: "https://example.test/hometruth",
      fetch: fakeFetch((url) => {
        expect(url.pathname).toBe("/hometruth/api/switches/relay%3A1");
        return Response.json(state("relay:1", on ? "on" : "off"));
      }),
    });
    expect(await client.read("relay:1")).toEqual({ on: false, reachable: true });
    on = true;
    expect(await client.read("relay:1")).toEqual({ on: true, reachable: true });
  });

  test("reports unreachable snapshots without exposing an invented or stale state", async () => {
    for (const availability of ["offline", "unknown", "degraded"]) {
      const client = new HomeTruthSwitchClient({ fetch: fakeFetch(() => Response.json(state("relay", "on", availability))) });
      expect(await client.read("relay")).toEqual({ reachable: false });
    }
  });

  test("rejects wrong identities, missing state, and invalid online state", async () => {
    for (const body of [state("other"), { id: "relay" }, state("relay", "maybe"), state("relay", "on", "bogus"), { id: "relay", state: { availability: "online", value: true } }]) {
      const client = new HomeTruthSwitchClient({ fetch: fakeFetch(() => Response.json(body)) });
      await expect(client.read("relay")).rejects.toThrow("invalid switch");
    }
  });

  test("sends one absolute on/off command and returns observed hardware state", async () => {
    const calls: string[] = [];
    const client = new HomeTruthSwitchClient({
      fetch: fakeFetch((url, init) => {
        calls.push(url.pathname);
        expect(init.method).toBe("POST");
        expect(new Headers(init.headers).get("content-type")).toBe("application/json");
        expect(init.body).toBe("{}");
        expect(init.redirect).toBe("error");
        // The device can auto-reset or change outside HomeTruth immediately after a write.
        return Response.json(state("relay", "off"));
      }),
    });
    expect(await client.write("relay", true)).toEqual({ on: false, reachable: true });
    expect(await client.write("relay", false)).toEqual({ on: false, reachable: true });
    expect(calls).toEqual(["/api/switches/relay/turn-on", "/api/switches/relay/turn-off"]);
  });

  test("rejects an unreadable write result without retrying a physical action", async () => {
    let calls = 0;
    const client = new HomeTruthSwitchClient({ fetch: fakeFetch(() => {
      calls++;
      return Response.json({ id: "relay", state: { availability: "offline" } });
    }) });
    await expect(client.write("relay", true)).rejects.toThrow("state is unknown");
    expect(calls).toBe(1);
  });

  test("includes HTTP and API errors and does not retry failed writes", async () => {
    let calls = 0;
    const client = new HomeTruthSwitchClient({ fetch: fakeFetch(() => {
      calls++;
      return Response.json({ error: { code: "switch_unreachable", message: "relay is unreachable" } }, { status: 502 });
    }) });
    await expect(client.write("relay", true)).rejects.toThrow("HTTP 502: relay is unreachable");
    expect(calls).toBe(1);
  });

  test("reports malformed JSON and network errors meaningfully", async () => {
    const nonJson = new HomeTruthSwitchClient({ fetch: fakeFetch(() => new Response("not json")) });
    await expect(nonJson.read("relay")).rejects.toThrow("invalid JSON");
    const unreachable = new HomeTruthSwitchClient({ fetch: fakeFetch(() => { throw new Error("connection refused"); }) });
    await expect(unreachable.read("relay")).rejects.toThrow("connection refused");
  });

  test("aborts requests within the configured timeout", async () => {
    const client = new HomeTruthSwitchClient({ timeoutMs: 10, fetch: fakeFetch((_url, init) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    })) });
    await expect(client.read("relay")).rejects.toThrow("timed out after 10 ms");
  });

  test("validates the server URL and timeout before making requests", () => {
    for (const url of ["garbage", "ftp://example.test", "http://user:pass@example.test", "http://example.test?query=1", "http://example.test#fragment"]) {
      expect(() => new HomeTruthSwitchClient({ url })).toThrow("HOMETRUTH_URL");
    }
    for (const timeoutMs of [0, -1, NaN, 1.5, Infinity]) {
      expect(() => new HomeTruthSwitchClient({ timeoutMs })).toThrow("timeout");
    }
  });

  test("rejects malformed target ids before sending an action", async () => {
    let calls = 0;
    const client = new HomeTruthSwitchClient({ fetch: fakeFetch(() => { calls++; return Response.json(state()); }) });
    for (const id of ["", "../relay", "relay/action", "relay?value=off"]) {
      await expect(client.write(id, true)).rejects.toThrow("valid device id");
    }
    expect(calls).toBe(0);
  });
});
