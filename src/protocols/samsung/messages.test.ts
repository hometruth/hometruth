import { describe, expect, test } from "bun:test";
import {
  ART_CHANNEL,
  REMOTE_CHANNEL,
  artRequestCommand,
  channelUrl,
  deviceInfoUrl,
  launchAppCommand,
  parseArtPayload,
  parseDeviceInfo,
  parseFrame,
  remoteKeyCommand,
  tokenOf,
} from "./messages";

describe("channelUrl", () => {
  test("base64s the client name and carries the token when there is one", () => {
    const url = new URL(channelUrl({ host: "10.77.0.50", channel: REMOTE_CHANNEL, name: "HomeTruth", token: "17091234" }));
    expect(url.protocol).toBe("wss:");
    expect(url.port).toBe("8002");
    expect(url.pathname).toBe("/api/v2/channels/samsung.remote.control");
    expect(url.searchParams.get("name")).toBe("SG9tZVRydXRo");
    expect(Buffer.from(url.searchParams.get("name")!, "base64").toString()).toBe("HomeTruth");
    expect(url.searchParams.get("token")).toBe("17091234");
  });

  test("omits the token before the set has issued one, which is what makes it prompt", () => {
    const url = new URL(channelUrl({ host: "tv.local", channel: ART_CHANNEL, name: "HomeTruth" }));
    expect(url.searchParams.has("token")).toBe(false);
    expect(url.pathname).toBe("/api/v2/channels/com.samsung.art-app");
  });

  test("device info is plain HTTP on the unauthenticated port", () => {
    expect(deviceInfoUrl("10.77.0.50")).toBe("http://10.77.0.50:8001/api/v2/");
  });
});

describe("commands", () => {
  test("a key click is the SendRemoteKey shape the set expects", () => {
    expect(JSON.parse(remoteKeyCommand("KEY_POWER"))).toEqual({
      method: "ms.remote.control",
      params: { Cmd: "Click", DataOfCmd: "KEY_POWER", Option: "false", TypeOfRemote: "SendRemoteKey" },
    });
  });

  test("press and release carry the same shape with their own Cmd", () => {
    expect(JSON.parse(remoteKeyCommand("KEY_POWER", "Press")).params.Cmd).toBe("Press");
    expect(JSON.parse(remoteKeyCommand("KEY_POWER", "Release")).params.Cmd).toBe("Release");
  });

  test("an app launch is a channel emit, not a remote key", () => {
    const command = JSON.parse(launchAppCommand("3201606009684")) as { method: string; params: { event: string; data: { appId: string } } };
    expect(command.method).toBe("ms.channel.emit");
    expect(command.params.event).toBe("ed.apps.launch");
    expect(command.params.data.appId).toBe("3201606009684");
  });

  test("an art request nests its payload as a JSON string and echoes the id both ways", () => {
    const command = JSON.parse(artRequestCommand("set_artmode_status", "abc-123", { value: "on" })) as { method: string; params: { event: string; to: string; data: string } };
    expect(command.method).toBe("ms.channel.emit");
    expect(command.params.event).toBe("art_app_request");
    expect(command.params.to).toBe("host");
    expect(typeof command.params.data).toBe("string");
    expect(JSON.parse(command.params.data)).toEqual({ request: "set_artmode_status", value: "on", id: "abc-123", request_id: "abc-123" });
  });
});

describe("parseFrame", () => {
  test("reads an event frame", () => {
    expect(parseFrame('{"event":"ms.channel.ready","data":{}}')).toEqual({ event: "ms.channel.ready", data: {} });
  });

  test("anything that is not an event frame is not one", () => {
    expect(parseFrame("not json")).toBeUndefined();
    expect(parseFrame('{"data":{}}')).toBeUndefined();
    expect(parseFrame("[]")).toBeUndefined();
  });

  test("the token comes only from a connect frame", () => {
    const connect = parseFrame('{"event":"ms.channel.connect","data":{"token":"17091234","clients":[]}}')!;
    expect(tokenOf(connect)).toBe("17091234");
    expect(tokenOf(parseFrame('{"event":"ms.channel.ready","data":{"token":"x"}}')!)).toBeUndefined();
    expect(tokenOf(parseFrame('{"event":"ms.channel.connect","data":{}}')!)).toBeUndefined();
  });
});

describe("parseArtPayload", () => {
  test("unwraps the JSON string a d2d frame carries", () => {
    const frame = parseFrame(JSON.stringify({
      event: "d2d_service_message",
      data: JSON.stringify({ event: "artmode_status", value: "on", id: "abc-123", request_id: "abc-123" }),
    }))!;
    expect(parseArtPayload(frame)).toEqual({ event: "artmode_status", id: "abc-123", value: "on", fields: { event: "artmode_status", value: "on", id: "abc-123", request_id: "abc-123" } });
  });

  test("firmware that echoes only `id` still correlates", () => {
    const frame = parseFrame(JSON.stringify({ event: "d2d_service_message", data: JSON.stringify({ event: "artmode_status", value: "off", id: "only-id" }) }))!;
    expect(parseArtPayload(frame)?.id).toBe("only-id");
  });

  test("an error sub-event keeps its code so the caller can name it", () => {
    const frame = parseFrame(JSON.stringify({ event: "d2d_service_message", data: JSON.stringify({ event: "error", error_code: "404", request_id: "abc" }) }))!;
    expect(parseArtPayload(frame)).toMatchObject({ event: "error", errorCode: "404", id: "abc" });
  });

  test("a non-d2d frame, or one whose data is already an object, is not an art payload", () => {
    expect(parseArtPayload({ event: "ms.channel.ready", data: "{}" })).toBeUndefined();
    expect(parseArtPayload({ event: "d2d_service_message", data: { value: "on" } })).toBeUndefined();
    expect(parseArtPayload({ event: "d2d_service_message", data: "not json" })).toBeUndefined();
  });
});

describe("parseDeviceInfo", () => {
  const body = {
    device: {
      FrameTVSupport: "true",
      TokenAuthSupport: "true",
      PowerState: "on",
      name: "[TV] Living Room",
      model: "22_PONTUSM_FTV",
      modelName: "QN55LS03B",
      wifiMac: "aa:bb:cc:dd:ee:ff",
    },
    version: "2.0.25",
    type: "Samsung SmartTV",
  };

  test("reads the fields HomeTruth uses", () => {
    expect(parseDeviceInfo(body)).toEqual({
      powerState: "on",
      name: "[TV] Living Room",
      model: "22_PONTUSM_FTV",
      modelName: "QN55LS03B",
      wifiMac: "aa:bb:cc:dd:ee:ff",
      firmwareVersion: "2.0.25",
      frameTvSupport: true,
      tokenAuthSupport: true,
    });
  });

  test("standby is a power state, and a set that is not a Frame says so", () => {
    const info = parseDeviceInfo({ ...body, device: { ...body.device, PowerState: "standby", FrameTVSupport: "false" } })!;
    expect(info.powerState).toBe("standby");
    expect(info.frameTvSupport).toBe(false);
  });

  test("an unrecognised power state is absent rather than guessed", () => {
    expect(parseDeviceInfo({ ...body, device: { ...body.device, PowerState: "sleeping" } })!.powerState).toBeUndefined();
  });

  test("a body with no device half is not device info", () => {
    expect(parseDeviceInfo({ version: "2.0.25" })).toBeUndefined();
    expect(parseDeviceInfo(null)).toBeUndefined();
  });
});
