import { describe, expect, test } from "bun:test";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { RtspProbe } from "../../../protocols/rtsp/probe";
import { RtspProbeError } from "../../../protocols/rtsp/probe";
import { deviceKindOf } from "../../../site";
import { WYZE_CAM_V3, WYZE_CAM_V3_CONFIG_SCHEMA, WYZE_CAM_V3_SECRETS_SCHEMA, WyzeCamV3, wyzeCamV3MediaSource } from "./index";

const instance = { id: "wyze-cam-v3", name: "Wyze Cam v3" };
const online: RtspProbe = async () => ({ statusCode: 200, server: "prudynt-t", methods: ["OPTIONS", "DESCRIBE"], authRequired: false });
const offline: RtspProbe = async ({ host, port }) => { throw new RtspProbeError(`${host}:${port} is unreachable`, "unreachable"); };

const DEVICE_INFORMATION = `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl">
  <s:Body>
    <tds:GetDeviceInformationResponse>
      <tds:Manufacturer>Thingino</tds:Manufacturer>
      <tds:Model>wyze_cam3_t31x_gc2053_atbm6031</tds:Model>
      <tds:FirmwareVersion>2026-08-14</tds:FirmwareVersion>
      <tds:SerialNumber>2caa8e000001</tds:SerialNumber>
      <tds:HardwareId>t31x</tds:HardwareId>
    </tds:GetDeviceInformationResponse>
  </s:Body>
</s:Envelope>`;

function validator(schema: object) {
  const ajv = new Ajv({ strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

describe("firmware profiles", () => {
  test("Thingino: RTSP /ch0 on 554, factory login when no secret is set, HTTP snapshot only with the web API key", () => {
    expect(wyzeCamV3MediaSource({ host: "10.78.0.250", firmware: "thingino" })).toEqual({
      streamUri: "rtsp://10.78.0.250:554/ch0",
      username: "thingino",
      password: "thingino",
    });
    expect(wyzeCamV3MediaSource({ host: "10.78.0.250", firmware: "thingino", stream: "sub" }).streamUri).toBe("rtsp://10.78.0.250:554/ch1");
    expect(wyzeCamV3MediaSource({ host: "10.78.0.250", firmware: "thingino", webApiKey: "k3y/with=chars" }).snapshotUri).toBe("http://10.78.0.250/x/dl0.jpg?token=k3y%2Fwith%3Dchars");
    expect(wyzeCamV3MediaSource({ host: "10.78.0.250", firmware: "thingino", stream: "sub", webApiKey: "abcdefgh" }).snapshotUri).toBe("http://10.78.0.250/x/dl1.jpg?token=abcdefgh");
  });

  test("Wyze RTSP beta: stream0 on 554, RTSPS on 322 when secure, no snapshot endpoint", () => {
    const plain = wyzeCamV3MediaSource({ host: "10.78.0.250", firmware: "wyze-rtsp", credentials: { username: "hometruth", password: "s3cret" } });
    expect(plain).toEqual({ streamUri: "rtsp://10.78.0.250:554/stream0/", username: "hometruth", password: "s3cret" });
    const secure = wyzeCamV3MediaSource({ host: "10.78.0.250", firmware: "wyze-rtsp", secure: true });
    expect(secure).toEqual({ streamUri: "rtsps://10.78.0.250:322/stream0/" });
  });

  test("wz_mini_hacks: v4l2rtspserver on 8554 with a port override, secure ignored", () => {
    expect(wyzeCamV3MediaSource({ host: "10.78.0.250", firmware: "wz-mini-hacks", secure: true })).toEqual({ streamUri: "rtsp://10.78.0.250:8554/video1_unicast" });
    expect(wyzeCamV3MediaSource({ host: "10.78.0.250", firmware: "wz-mini-hacks", rtspPort: 8555, stream: "sub" }).streamUri).toBe("rtsp://10.78.0.250:8555/video2_unicast");
  });
});

describe("config and secrets schemas", () => {
  test("accept the example entry and reject a public host, an unknown firmware, or extra keys", () => {
    const validate = validator(WYZE_CAM_V3_CONFIG_SCHEMA);
    expect(validate({ host: "10.78.0.250", firmware: "thingino" })).toBe(true);
    expect(validate({ host: "10.78.0.250", firmware: "wyze-rtsp", secure: true, stream: "sub", rtspPort: 554, timeoutMs: 2000 })).toBe(true);
    expect(validate({ host: "10.78.0.250" })).toBe(false);
    expect(validate({ host: "10.78.0.250", firmware: "stock" })).toBe(false);
    expect(validate({ host: "10.78.0.250", firmware: "thingino", password: "x" })).toBe(false);
    // The schema admits any hostname shape; the constructor rejects public addresses.
    expect(() => new WyzeCamV3(instance, { host: "8.8.8.8", firmware: "thingino" })).toThrow(/private LAN address/u);
  });

  test("secrets are an optional RTSP login and an optional web API key", () => {
    const validate = validator(WYZE_CAM_V3_SECRETS_SCHEMA);
    expect(validate({})).toBe(true);
    expect(validate({ rtsp: { username: "thingino", password: "changed" } })).toBe(true);
    expect(validate({ web: { apiKey: "0123456789abcdef" } })).toBe(true);
    expect(validate({ rtsp: { username: "thingino" } })).toBe(false);
    expect(validate({ web: { apiKey: "short" } })).toBe(false);
    expect(validate({ onvif: { username: "a", password: "b" } })).toBe(false);
  });
});

describe("WyzeCamV3 device", () => {
  test("is a camera plus motion sensor that gets the camera page", () => {
    expect(WYZE_CAM_V3.capabilities).toEqual(["camera", "motionSensor"]);
    expect(deviceKindOf(WYZE_CAM_V3)).toBe("camera");
  });

  test("describes itself online with stream and snapshot when RTSP answers OPTIONS; motion is unknown without a broker", async () => {
    const camera = new WyzeCamV3(instance, { host: "10.78.0.250", firmware: "thingino" }, {}, { probe: online });
    const object = await camera.describe();
    expect(object.status).toBe("online"); // a motion sensor nothing has reached yet says nothing about the device
    expect(object.capabilities.camera).toEqual({
      id: "camera",
      state: { availability: "online", streamAvailable: true, snapshotAvailable: true },
      actions: { snapshot: { mediaTypes: ["image/jpeg"] } },
    });
    expect(object.capabilities.motionSensor).toEqual({ id: "motion", state: { availability: "unknown" }, actions: {} });
    expect(camera.controls()).toEqual([...camera.camera.controlIds]);
    expect(await camera.locate()).toEqual({ host: "10.78.0.250" });
    expect(camera.mediaSource().snapshotUri).toBeUndefined();
    const keyed = new WyzeCamV3(instance, { host: "10.78.0.250", firmware: "thingino" }, { web: { apiKey: "0123456789abcdef" } }, { probe: online });
    expect(keyed.mediaSource().snapshotUri).toBe("http://10.78.0.250/x/dl0.jpg?token=0123456789abcdef");
  });

  test("reports offline, not an error, when the RTSP server is unreachable", async () => {
    const camera = new WyzeCamV3(instance, { host: "10.78.0.250", firmware: "wz-mini-hacks" }, {}, { probe: offline });
    const object = await camera.describe();
    expect(object.status).toBe("offline"); // the unknown motion sensor does not soften a plainly offline camera
    expect(object.capabilities.camera?.state).toEqual({ availability: "offline", streamAvailable: false, snapshotAvailable: false });
    expect(await camera.locate()).toBeUndefined();
  });

  test("uses the stored RTSP login for the stream and the probe port from the profile", async () => {
    const probed: { host: string; port: number; path?: string }[] = [];
    const probe: RtspProbe = async (options) => { probed.push({ host: options.host, port: options.port, ...(options.path ? { path: options.path } : {}) }); return online(options); };
    const camera = new WyzeCamV3(instance, { host: "10.78.0.250", firmware: "wyze-rtsp", secure: true }, { rtsp: { username: "hometruth", password: "s3cret" } }, { probe });
    await camera.camera.state();
    expect(probed).toEqual([{ host: "10.78.0.250", port: 322, path: "/stream0/" }]);
    expect(camera.mediaSource()).toEqual({ streamUri: "rtsps://10.78.0.250:322/stream0/", username: "hometruth", password: "s3cret" });
  });

  test("Thingino: probe reads identity over ONVIF and reboot is offered", async () => {
    const requests: string[] = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(`${new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url).pathname} ${String(init?.body ?? "").includes("GetDeviceInformation") ? "GetDeviceInformation" : "other"}`);
      return new Response(DEVICE_INFORMATION, { status: 200, headers: { "content-type": "application/soap+xml" } });
    };
    const camera = new WyzeCamV3(instance, { host: "10.78.0.250", firmware: "thingino" }, { rtsp: { username: "thingino", password: "changed" } }, { probe: online, fetch });
    expect(await camera.probe()).toEqual({ model: "wyze_cam3_t31x_gc2053_atbm6031", firmwareVersion: "2026-08-14", serialNumber: "2caa8e000001" });
    expect(requests).toEqual(["/onvif/device_service GetDeviceInformation"]);
    expect(typeof camera.reboot).toBe("function");
    const object = await camera.describe();
    expect(object.model).toBe("wyze_cam3_t31x_gc2053_atbm6031");
    expect(object.firmwareVersion).toBe("2026-08-14");
    expect(object.serialNumber).toBe("2caa8e000001");
  });

  test("firmware without ONVIF: probe falls back to the RTSP Server header and reboot is absent", async () => {
    const camera = new WyzeCamV3(instance, { host: "10.78.0.250", firmware: "wyze-rtsp" }, {}, { probe: online });
    expect(await camera.probe()).toEqual({ model: "Cam v3 (prudynt-t)" });
    expect(camera.reboot).toBeUndefined();
    const unreachable = new WyzeCamV3(instance, { host: "10.78.0.250", firmware: "wyze-rtsp" }, {}, { probe: offline });
    await expect(unreachable.probe()).rejects.toBeInstanceOf(RtspProbeError);
  });

  test("the model factory builds an instance from validated config and secrets", () => {
    const device = WYZE_CAM_V3.create(instance, { host: "10.78.0.250", firmware: "thingino" }, {}, { rtsp: { username: "thingino", password: "x" } });
    expect(device).toBeInstanceOf(WyzeCamV3);
    expect(device.model.id).toBe("wyze-cam-v3");
  });
});

describe("Thingino controls", () => {
  const HEARTBEAT = {
    uptime: 1019, daynight_mode: "night", daynight_enabled: 0, ircut_state: 0, ir850_state: 1, ir940_state: 1, white_state: null,
    color_mode: 1, privacy_enabled: 0, mic_enabled: 1, spk_enabled: 1, motion_enabled: 0, rec_ch0: 0, rec_ch1: 0,
  };
  type Call = { url: string; body?: string };
  const webFetch = (calls: Call[]) => async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    if (url.includes("json-heartbeat-slow")) return new Response(JSON.stringify(HEARTBEAT), { status: 200 });
    if (url.includes("json-imp")) return new Response(JSON.stringify({ code: 200, result: "success", message: "" }), { status: 200 });
    return new Response(init?.body ?? "{}", { status: 200 });
  };
  const keyed = (calls: Call[]) => new WyzeCamV3(instance, { host: "10.78.0.250", firmware: "thingino" }, { web: { apiKey: "0123456789abcdef" } }, { probe: online, webFetch: webFetch(calls) });

  test("lists the product controls after the generic ones", () => {
    const camera = keyed([]);
    expect(camera.controls()).toEqual([
      "pan.left", "pan.right", "pan.home", "tilt.up", "tilt.down", "tilt.home", "stopMovement", "setPrivacy",
      "readSettings", "nightVision.mode", "nightVision.irCut", "nightVision.irNear", "nightVision.irFar", "video.monochrome", "audio.microphone", "audio.speaker", "detection.motion",
    ]);
  });

  test("state carries privacy, audio, and recording from the heartbeat and offers setPrivacy", async () => {
    const camera = keyed([]);
    const document = await camera.camera.describe();
    expect(document.state).toEqual({ availability: "online", streamAvailable: true, snapshotAvailable: true, privacyEnabled: false, microphoneEnabled: true, speakerEnabled: true, recording: false });
    expect(document.actions).toEqual({ snapshot: { mediaTypes: ["image/jpeg"] }, setPrivacy: {} });
  });

  test("readSettings returns every control's current value", async () => {
    const camera = keyed([]);
    expect(await camera.invokeControl("readSettings")).toEqual({
      "nightVision.mode": "night", "nightVision.irCut": false, "nightVision.irNear": true, "nightVision.irFar": true,
      "video.monochrome": true, "audio.microphone": true, "audio.speaker": true, "detection.motion": false,
    });
  });

  test("writes go to json-imp.cgi or prudynt with validated values", async () => {
    const calls: Call[] = [];
    const camera = keyed(calls);
    await camera.invokeControl("nightVision.irFar", false);
    await camera.invokeControl("nightVision.mode", "auto");
    await camera.invokeControl("nightVision.mode", "day");
    await camera.invokeControl("setPrivacy", true);
    await camera.invokeControl("detection.motion", true);
    expect(calls.map((call) => [call.url.replace(/token=[^&]+/u, "token=…"), call.body])).toEqual([
      ["http://10.78.0.250/x/json-imp.cgi?token=…", '{"cmd":"ir940","val":0}'],
      ["http://10.78.0.250/x/json-imp.cgi?token=…", '{"cmd":"auto","val":1}'],
      ["http://10.78.0.250/x/json-imp.cgi?token=…", '{"cmd":"daynight","val":"day"}'],
      ["http://10.78.0.250:8080/api/v1/config", '{"privacy":{"enabled":true}}'],
      ["http://10.78.0.250:8080/api/v1/config", '{"motion":{"enabled":true}}'],
    ]);
    await expect(camera.invokeControl("nightVision.irFar", "yes")).rejects.toMatchObject({ code: "invalid_value" });
    await expect(camera.invokeControl("nightVision.mode", "dusk")).rejects.toMatchObject({ code: "invalid_value" });
    await expect(camera.invokeControl("pan.left")).rejects.toMatchObject({ code: "not_supported" });
  });

  test("without the web API key the product controls answer not_supported and privacy is not offered", async () => {
    const camera = new WyzeCamV3(instance, { host: "10.78.0.250", firmware: "thingino" }, {}, { probe: online });
    await expect(camera.invokeControl("nightVision.irFar", false)).rejects.toMatchObject({ code: "not_supported" });
    await expect(camera.invokeControl("setPrivacy", true)).rejects.toMatchObject({ code: "not_supported" });
    expect((await camera.camera.actions()).setPrivacy).toBeUndefined();
    const other = new WyzeCamV3(instance, { host: "10.78.0.250", firmware: "wyze-rtsp" }, { web: { apiKey: "0123456789abcdef" } }, { probe: online });
    expect(other.webApi).toBeUndefined();
  });
});

describe("motion sensor (MQTT)", () => {
  function fakeBroker() {
    const handlers = new Map<string, Set<(topic: string, payload: Buffer) => void>>();
    const unsubscribeCalls: string[] = [];
    return {
      broker: {
        hostname: "127.0.0.1",
        port: 1883,
        onMessage(topic: string, handler: (topic: string, payload: Buffer) => void) {
          const set = handlers.get(topic) ?? new Set();
          set.add(handler);
          handlers.set(topic, set);
          return () => { unsubscribeCalls.push(topic); set.delete(handler); };
        },
      },
      publish(topic: string, payload: string) {
        for (const handler of handlers.get(topic) ?? []) handler(topic, Buffer.from(payload));
      },
      unsubscribeCalls,
    };
  }

  test("subscribes to thingino/<device id> and reports motion true right after a publish", async () => {
    const { broker, publish } = fakeBroker();
    const camera = new WyzeCamV3(instance, { host: "10.78.0.250", firmware: "thingino" }, {}, { probe: online, mqttBroker: broker });
    expect(await camera.motionSensor.state()).toEqual({ availability: "unknown" });

    publish("thingino/wyze-cam-v3", JSON.stringify({ camera_id: "abc", timestamp: 1000 }));
    const state = await camera.motionSensor.state();
    expect(state.availability).toBe("online");
    expect(state.motion).toBe(true);
    expect(typeof state.observedAt).toBe("string");
    expect(state.lastMotionAt).toBe(state.observedAt);
  });

  test("falls back to false (still online) once the pulse goes stale, without a second message", async () => {
    const { broker, publish } = fakeBroker();
    const camera = new WyzeCamV3(instance, { host: "10.78.0.250", firmware: "thingino" }, {}, { probe: online, mqttBroker: broker });
    publish("thingino/wyze-cam-v3", "{}");
    const fresh = await camera.motionSensor.state();
    expect(fresh.motion).toBe(true);

    // Directly exercise PushedMotionState's staleness with a far-future "now" rather than sleeping in the test.
    const stale = (camera.motionSensor as unknown as { pushed: { state(now?: Date): unknown } }).pushed.state(new Date(Date.now() + 60_000));
    expect(stale).toMatchObject({ availability: "unknown" });
  });

  test("a message on a different device's topic is ignored", async () => {
    const { broker, publish } = fakeBroker();
    const camera = new WyzeCamV3(instance, { host: "10.78.0.250", firmware: "thingino" }, {}, { probe: online, mqttBroker: broker });
    publish("thingino/some-other-camera", "{}");
    expect(await camera.motionSensor.state()).toEqual({ availability: "unknown" });
  });

  test("has no configurable actions or controls, and offers no methods beyond the generic ones", async () => {
    const camera = new WyzeCamV3(instance, { host: "10.78.0.250", firmware: "thingino" }, {}, { probe: online, mqttBroker: fakeBroker().broker });
    expect(await camera.motionSensor.actions()).toEqual({});
    expect(camera.motionSensor.controlIds).toEqual([]);
  });

  test("without a broker the sensor stays unknown forever and is not subscribed to anything", async () => {
    const camera = new WyzeCamV3(instance, { host: "10.78.0.250", firmware: "thingino" }, {}, { probe: online });
    expect(await camera.motionSensor.state()).toEqual({ availability: "unknown" });
  });

  test("close() unsubscribes from the broker", async () => {
    const { broker, unsubscribeCalls } = fakeBroker();
    const camera = new WyzeCamV3(instance, { host: "10.78.0.250", firmware: "thingino" }, {}, { probe: online, mqttBroker: broker });
    await camera.close?.();
    expect(unsubscribeCalls).toEqual(["thingino/wyze-cam-v3"]);
  });
});
