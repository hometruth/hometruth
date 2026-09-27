import { describe, expect, test } from "bun:test";
import { ThinginoError, ThinginoWebApi, parseHeartbeat } from "./index";

/** Heartbeat fixture for the ciao+2c3eca5 API shape, with night-mode settings. */
const HEARTBEAT = {
  time_now: 1788674872, uptime: 1019, daynight_brightness: 47, total_gain: null, daynight_mode: "night",
  rec_ch0: 0, rec_ch1: 0, motion_enabled: 0, privacy_enabled: 0, color_mode: 1, mic_enabled: 1, spk_enabled: 1,
  daynight_enabled: 0, ircut_state: 0, ir850_state: 1, ir940_state: 1, white_state: null, wg_status: 0,
};

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

function fakeFetch(handler: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchImpl = async (input: string | URL, init?: RequestInit) => {
    const call: Call = {
      url: typeof input === "string" ? input : input.toString(),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([key, value]) => [key.toLowerCase(), value])),
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    };
    calls.push(call);
    return handler(call);
  };
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("parseHeartbeat", () => {
  test("decodes the slow heartbeat into named switches", () => {
    expect(parseHeartbeat(HEARTBEAT)).toEqual({
      uptimeSeconds: 1019, dayNightMode: "night", dayNightAuto: false, irCut: false, ir850: true, ir940: true,
      monochrome: true, privacy: false, microphone: true, speaker: true, motionDetection: false, recordingMain: false, recordingSub: false,
      raw: HEARTBEAT,
    });
  });

  test("leaves unknown or null fields out and rejects non-objects", () => {
    expect(parseHeartbeat({ daynight_mode: "dusk", white_state: null })).toEqual({ raw: { daynight_mode: "dusk", white_state: null } });
    expect(() => parseHeartbeat([])).toThrow(ThinginoError);
  });
});

describe("ThinginoWebApi", () => {
  const options = { host: "10.78.0.76", apiKey: "k3y/with=chars" };

  test("reads the heartbeat with the token in the query string", async () => {
    const { calls, fetchImpl } = fakeFetch(() => json(HEARTBEAT));
    const api = new ThinginoWebApi({ ...options, fetch: fetchImpl });
    const state = await api.heartbeat();
    expect(state.ir850).toBe(true);
    expect(calls).toEqual([{ url: "http://10.78.0.76/x/json-heartbeat-slow.cgi?token=k3y%2Fwith%3Dchars", method: "GET", headers: {} }]);
  });

  test("flips imaging switches and day/night through json-imp.cgi", async () => {
    const { calls, fetchImpl } = fakeFetch(() => json({ code: 200, result: "success", message: "" }));
    const api = new ThinginoWebApi({ ...options, fetch: fetchImpl });
    await api.setSwitch("ir940", false);
    await api.setDayNight("day");
    expect(calls.map((call) => [call.url, call.method, call.body])).toEqual([
      ["http://10.78.0.76/x/json-imp.cgi?token=k3y%2Fwith%3Dchars", "POST", '{"cmd":"ir940","val":0}'],
      ["http://10.78.0.76/x/json-imp.cgi?token=k3y%2Fwith%3Dchars", "POST", '{"cmd":"daynight","val":"day"}'],
    ]);
  });

  test("privacy, audio, and motion go to prudynt on 8080 with the X-API-Key header", async () => {
    const { calls, fetchImpl } = fakeFetch((call) => json(JSON.parse(call.body ?? "{}")));
    const api = new ThinginoWebApi({ ...options, fetch: fetchImpl });
    expect(await api.setPrivacy(true)).toEqual({ privacy: { enabled: true } });
    await api.setAudio("microphone", false);
    await api.setMotionDetection(true);
    expect(calls.map((call) => [call.url, call.headers["x-api-key"], call.body])).toEqual([
      ["http://10.78.0.76:8080/api/v1/config", "k3y/with=chars", '{"privacy":{"enabled":true}}'],
      ["http://10.78.0.76:8080/api/v1/config", "k3y/with=chars", '{"audio":{"mic_enabled":false}}'],
      ["http://10.78.0.76:8080/api/v1/config", "k3y/with=chars", '{"motion":{"enabled":true}}'],
    ]);
  });

  test("maps 401 to unauthorized, a refused imp command and non-JSON to protocol, and a thrown fetch to unreachable", async () => {
    const unauthorized = new ThinginoWebApi({ ...options, fetch: fakeFetch(() => json({ error: "Authentication required" }, 401)).fetchImpl });
    await expect(unauthorized.heartbeat()).rejects.toMatchObject({ code: "unauthorized" });
    const refused = new ThinginoWebApi({ ...options, fetch: fakeFetch(() => json({ code: 400, result: "error" })).fetchImpl });
    await expect(refused.setSwitch("ir850", true)).rejects.toMatchObject({ code: "protocol" });
    const html = new ThinginoWebApi({ ...options, fetch: fakeFetch(() => new Response("<html>", { status: 200 })).fetchImpl });
    await expect(html.heartbeat()).rejects.toMatchObject({ code: "protocol" });
    const bare = new ThinginoWebApi({ ...options, fetch: fakeFetch(() => new Response("success\n", { status: 200 })).fetchImpl });
    await expect(bare.setDayNight("night")).resolves.toBeUndefined();
    const down = new ThinginoWebApi({ ...options, fetch: fakeFetch(() => { throw new Error("ECONNREFUSED"); }).fetchImpl });
    await expect(down.heartbeat()).rejects.toMatchObject({ code: "unreachable" });
  });

  test("refuses public hosts and an empty key up front", () => {
    expect(() => new ThinginoWebApi({ host: "8.8.8.8", apiKey: "x" })).toThrow(ThinginoError);
    expect(() => new ThinginoWebApi({ host: "10.78.0.76", apiKey: "" })).toThrow(ThinginoError);
  });
});
