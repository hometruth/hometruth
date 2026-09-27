import { afterEach, describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SAMSUNG_FRAME, SamsungFrame, SamsungFrameTelevision } from "./index";
import { TelevisionError } from "../../../models/television";
import { SamsungTokenStore } from "../../../vendors/samsung/token-store";
import { validators } from "../../../validation";
import type { SamsungFetch } from "../../../protocols/samsung/client";

const DEVICE_INFO = {
  device: { FrameTVSupport: "true", TokenAuthSupport: "true", PowerState: "on", name: "[TV] Lounge", model: "22_PONTUSM_FTV", modelName: "QN55LS03B" },
  version: "2.0.25",
};

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryStore(): Promise<SamsungTokenStore> {
  const directory = await mkdtemp(join(tmpdir(), "hometruth-samsung-"));
  directories.push(directory);
  return new SamsungTokenStore(directory);
}

function fakeFetch(body: unknown = DEVICE_INFO, status = 200): { fetch: SamsungFetch; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    },
  };
}

/**
 * A socket that answers the handshake the client waits for, then records every
 * command. Art requests are answered from `artValues` by the request name, with
 * the uuid the client generated echoed back so the waiter resolves.
 */
function fakeSockets(artValues: Record<string, string> = {}): { factory: (url: string) => WebSocket; sent: string[]; urls: string[] } {
  const sent: string[] = [];
  const urls: string[] = [];
  const factory = (url: string): WebSocket => {
    urls.push(url);
    const art = url.includes("com.samsung.art-app");
    const socket = {
      readyState: 1,
      onmessage: undefined as ((event: MessageEvent) => void) | undefined,
      onerror: undefined as (() => void) | undefined,
      onclose: undefined as (() => void) | undefined,
      send(raw: string) {
        sent.push(raw);
        const envelope = JSON.parse(raw) as { params?: { event?: string; data?: string } };
        if (envelope.params?.event !== "art_app_request" || typeof envelope.params.data !== "string") return;
        const request = JSON.parse(envelope.params.data) as { request: string; id: string };
        // The set answers every art request, so the fake does too; `artValues`
        // only chooses what a particular read comes back with.
        const value = artValues[request.request] ?? "off";
        queueMicrotask(() => socket.onmessage?.({
          data: JSON.stringify({ event: "d2d_service_message", data: JSON.stringify({ event: "artmode_status", value, id: request.id, request_id: request.id }) }),
        } as MessageEvent));
      },
      close() {
        socket.readyState = 3;
      },
    };
    // The set answers the handshake as soon as the socket is live.
    queueMicrotask(() => socket.onmessage?.({
      data: JSON.stringify(art
        ? { event: "ms.channel.ready", data: {} }
        : { event: "ms.channel.connect", data: { token: "17091234", clients: [] } }),
    } as MessageEvent));
    return socket as unknown as WebSocket;
  };
  return { factory, sent, urls };
}

/** A set that is already paired unless a test says otherwise, since that is the state it spends its life in. */
async function television(options: { artValues?: Record<string, string>; body?: unknown; status?: number; paired?: boolean } = {}) {
  const { fetch, urls } = fakeFetch(options.body ?? DEVICE_INFO, options.status ?? 200);
  const { factory, sent, urls: socketUrls } = fakeSockets(options.artValues ?? { get_artmode_status: "off" });
  const store = await temporaryStore();
  if (options.paired !== false) await store.save("lounge-frame", "17091234");
  const set = new SamsungFrameTelevision({ id: "lounge-frame", host: "10.77.0.50", tokenStore: store, fetch, socketFactory: factory });
  return { set, sent, urls, socketUrls, store };
}

/** Poll for something a fire-and-forget write will produce, so no test waits on a fixed duration. */
async function until<T>(read: () => Promise<T | undefined>, timeoutMs = 1_000): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined || Date.now() > deadline) return value;
    await Bun.sleep(5);
  }
}

/** The Tizen key name of the one key command sent, for a test that means to assert exactly one. */
function keysOf(sent: string[]): string[] {
  return sent
    .map((raw) => JSON.parse(raw) as { method: string; params: { Cmd?: string; DataOfCmd?: string } })
    .filter((command) => command.method === "ms.remote.control")
    .map((command) => `${command.params.Cmd}:${command.params.DataOfCmd}`);
}

describe("SamsungFrameTelevision", () => {
  test("declares art mode and the HDMI inputs, so the document offers both", async () => {
    const { set } = await television();
    expect(set.supportsArtMode()).toBe(true);
    expect(set.supportsAbsoluteVolume()).toBe(false);
    expect(set.inputs().map((input) => input.id)).toEqual(["hdmi1", "hdmi2", "hdmi3", "hdmi4", "tv"]);
    expect(set.controlIds).toContain("setArtMode");
    expect(set.controlIds).toContain("setInput");
    expect(set.controlIds).not.toContain("setVolume");
  });

  test("reads power from the unauthenticated REST port and art mode from the art channel", async () => {
    const { set, urls } = await television({ artValues: { get_artmode_status: "on" } });
    expect(await set.getState()).toEqual({ power: "on", artMode: "on" });
    expect(urls[0]).toBe("http://10.77.0.50:8001/api/v2/");
  });

  test("a set in standby has no art channel, so art mode is not asked for", async () => {
    const { set, socketUrls } = await television({ body: { ...DEVICE_INFO, device: { ...DEVICE_INFO.device, PowerState: "standby" } } });
    expect(await set.getState()).toEqual({ power: "standby" });
    expect(socketUrls).toEqual([]);
  });

  test("turnOn wakes a set in standby", async () => {
    const { set, sent } = await television({ body: { ...DEVICE_INFO, device: { ...DEVICE_INFO.device, PowerState: "standby" } } });
    await set.turnOn();
    expect(keysOf(sent)).toEqual(["Click:KEY_POWER"]);
  });

  test("turnOn leaves an already-on set alone, because the click would only show art", async () => {
    const { set, sent } = await television();
    await set.turnOn();
    expect(keysOf(sent)).toEqual([]);
  });

  test("turnOff holds the power key rather than clicking it", async () => {
    const { set, sent } = await television();
    await set.turnOff();
    expect(keysOf(sent)).toEqual(["Press:KEY_POWER", "Release:KEY_POWER"]);
  });

  test("the generic keys reach the set as Tizen key names", async () => {
    const { set, sent } = await television();
    await set.press("select");
    await set.press("fastForward");
    await set.press("channelUp");
    expect(keysOf(sent)).toEqual(["Click:KEY_ENTER", "Click:KEY_FF", "Click:KEY_CHUP"]);
  });

  test("volume and mute are key presses, since the set will not report them", async () => {
    const { set, sent } = await television();
    await set.volumeUp();
    await set.volumeDown();
    await set.toggleMute();
    expect(keysOf(sent)).toEqual(["Click:KEY_VOLUP", "Click:KEY_VOLDOWN", "Click:KEY_MUTE"]);
  });

  test("setInput jumps straight to the named input and refuses one the set does not have", async () => {
    const { set, sent } = await television();
    await set.setInput("hdmi3");
    expect(keysOf(sent)).toEqual(["Click:KEY_HDMI3"]);
    await expect(set.setInput("scart")).rejects.toThrow(TelevisionError);
  });

  test("setArtMode sends the art request with the value it was given", async () => {
    const { set, sent } = await television();
    await set.setArtMode(true);
    const request = sent.map((raw) => JSON.parse(raw) as { params?: { data?: string } }).find((command) => command.params?.data);
    expect(JSON.parse(request!.params!.data!)).toMatchObject({ request: "set_artmode_status", value: "on" });
  });

  test("an unpaired set is never asked for art mode, so polling cannot put its prompt on screen", async () => {
    const { set, socketUrls } = await television({ paired: false, artValues: { get_artmode_status: "on" } });
    expect(await set.paired()).toBe(false);
    expect(await set.getState()).toEqual({ power: "on" });
    expect(socketUrls).toEqual([]);
  });

  test("pair opens the remote channel, sends no key, and keeps the token the set issues", async () => {
    const { set, sent, socketUrls, store } = await television({ paired: false });
    await set.pair();
    expect(socketUrls).toHaveLength(1);
    expect(socketUrls[0]).toContain("samsung.remote.control");
    expect(sent).toEqual([]);
    // `pair()` awaits the write itself, so this needs no polling.
    expect(await store.load("lounge-frame")).toBe("17091234");
    expect(await set.paired()).toBe(true);
  });

  test("once paired, art mode is read on every state read", async () => {
    const { set } = await television({ artValues: { get_artmode_status: "on" } });
    expect(await set.getState()).toEqual({ power: "on", artMode: "on" });
  });

  test("the pairing token the set issues is persisted, so it prompts once", async () => {
    const store = await temporaryStore();
    const { fetch } = fakeFetch();
    const { factory } = fakeSockets();
    const set = new SamsungFrameTelevision({ id: "lounge-frame", host: "10.77.0.50", tokenStore: store, fetch, socketFactory: factory });
    await set.press("home");
    // The token lands from the connect frame and the write is deliberately not
    // awaited by the control, so wait for the file rather than for a duration.
    expect(await until(() => store.load("lounge-frame"))).toBe("17091234");
  });

  test("a saved token is carried on the channel URL, which is what stops the second prompt", async () => {
    const store = await temporaryStore();
    await store.save("lounge-frame", "99887766");
    const { fetch } = fakeFetch();
    const { factory, urls } = fakeSockets();
    const set = new SamsungFrameTelevision({ id: "lounge-frame", host: "10.77.0.50", tokenStore: store, fetch, socketFactory: factory });
    await set.press("home");
    expect(new URL(urls[0]!).searchParams.get("token")).toBe("99887766");
  });

  test("an unreachable set describes as offline instead of throwing", async () => {
    const { factory } = fakeSockets();
    const set = new SamsungFrameTelevision({
      id: "lounge-frame",
      host: "10.77.0.50",
      tokenStore: await temporaryStore(),
      socketFactory: factory,
      fetch: async () => {
        throw new Error("EHOSTUNREACH");
      },
    });
    const document = await set.describe();
    expect(document.state.availability).toBe("offline");
    expect(document.state.power).toBeUndefined();
    expect(validators.television(document)).toBe(true);
  });

  test("the document validates and declares exactly what this set can do", async () => {
    const { set } = await television({ artValues: { get_artmode_status: "on" } });
    const document = await set.describe();
    expect(validators.television(document)).toBe(true);
    expect(document.state).toMatchObject({ availability: "online", power: "on", artMode: "on" });
    expect(Object.keys(document.actions).sort()).toEqual(["getState", "press", "setArtMode", "setInput", "toggleMute", "turnOff", "turnOn", "volumeDown", "volumeUp"]);
    expect(document.actions.press?.keys).toContain("select");
    expect(document.actions.setInput?.inputs.map((input) => input.id)).toEqual(["hdmi1", "hdmi2", "hdmi3", "hdmi4", "tv"]);
  });

  test("a set that takes the socket and then says nothing is unanswered pairing, not a fault", async () => {
    // This is what a real set does while its prompt is on screen: it completes
    // the WebSocket upgrade and sends no frame at all until someone answers.
    const silent = (): WebSocket => ({ readyState: 1, send() {}, close() {} } as unknown as WebSocket);
    const { fetch } = fakeFetch();
    const set = new SamsungFrameTelevision({
      id: "lounge-frame",
      host: "10.77.0.50",
      timeoutMs: 50,
      tokenStore: await temporaryStore(),
      fetch,
      socketFactory: silent,
    });
    const error = await set.press("home").then(() => undefined, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(TelevisionError);
    expect((error as TelevisionError).code).toBe("not_paired");
    expect((error as TelevisionError).message).toMatch(/did not answer.*accept it/iu);
  });

  test("a public host is refused before anything is sent", async () => {
    const store = await temporaryStore();
    expect(() => new SamsungFrameTelevision({ id: "x", host: "203.0.113.10", tokenStore: store })).toThrow(TelevisionError);
    expect(() => new SamsungFrameTelevision({ id: "x", host: "tv.example.com", tokenStore: store })).toThrow(TelevisionError);
  });
});

describe("SamsungFrame device", () => {
  test("probe proves the set is a Frame and reports the name printed on it", async () => {
    const { fetch } = fakeFetch();
    const { factory } = fakeSockets();
    const device = new SamsungFrame({ id: "lounge-frame", name: "Lounge Frame" }, { host: "10.77.0.50" }, { tokenStore: await temporaryStore(), fetch, socketFactory: factory });
    expect(await device.probe()).toEqual({ model: "QN55LS03B", firmwareVersion: "2.0.25" });
  });

  test("probe rejects a Samsung set that is not a Frame", async () => {
    const { fetch } = fakeFetch({ ...DEVICE_INFO, device: { ...DEVICE_INFO.device, FrameTVSupport: "false" } });
    const { factory } = fakeSockets();
    const device = new SamsungFrame({ id: "lounge-frame", name: "Lounge Frame" }, { host: "10.77.0.50" }, { tokenStore: await temporaryStore(), fetch, socketFactory: factory });
    await expect(device.probe()).rejects.toThrow(/not a Frame/u);
  });

  test("the object document satisfies the model's own schema", async () => {
    const { fetch } = fakeFetch();
    const { factory } = fakeSockets();
    const device = new SamsungFrame({ id: "lounge-frame", name: "Lounge Frame" }, { host: "10.77.0.50" }, { tokenStore: await temporaryStore(), fetch, socketFactory: factory });
    const object = await device.describe();
    expect(validators.homeTruthObject(object)).toBe(true);
    expect(validators.samsungFrame(object)).toBe(true);
    expect(object.status).toBe("online");
  });

  test("the config schema accepts the example config and refuses an unknown key", () => {
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(SAMSUNG_FRAME.configSchema);
    expect(validate({ host: "10.77.0.50" })).toBe(true);
    expect(validate({ host: "frame.local", clientName: "HomeTruth", timeoutMs: 8000 })).toBe(true);
    expect(validate({})).toBe(false);
    expect(validate({ host: "10.77.0.50", token: "17091234" })).toBe(false);
    // A pairing token is issued at runtime and stored outside config; there is
    // nowhere in the schema to put one by hand, which is the point.
    expect(SAMSUNG_FRAME.capabilities).toEqual(["television"]);
    expect(SAMSUNG_FRAME.connectionTypes).toEqual(["direct-local"]);
    expect(SAMSUNG_FRAME.secretsSchema).toBeUndefined();
  });
});
