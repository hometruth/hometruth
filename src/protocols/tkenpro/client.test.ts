import { describe, expect, test } from "bun:test";
import {
  DestructiveControlError,
  IOT_CODES,
  MeariClient,
  TKENPRO_PROFILE,
  resolveAppProfile,
  encodeUserAccount,
  encryptPassword,
  formatSn,
  getAvailableControls,
  getDeviceCapabilities,
  hmacSha1Base64,
  PET3T_CONTROL_BY_ID,
} from "./index.ts";
import type { FetchLike, MeariClientConfig } from "./index.ts";

interface CapturedRequest {
  readonly url: URL;
  readonly init: RequestInit | undefined;
  readonly form: URLSearchParams;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function makeHarness(
  extra: Partial<MeariClientConfig> = {},
  openapiReplies: readonly unknown[] = [],
): { client: MeariClient; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const replies = [...openapiReplies];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
    requests.push({ url, init, form });
    switch (url.pathname) {
      case "/ppstrongs/redirect":
        return jsonResponse({
          resultCode: "1001",
          result: {
            apiServer: "https://apis-us-frankfurt.cloudedge360.com",
            countryCode: "US",
          },
        });
      case "/meari/app/login":
        return jsonResponse({
          resultCode: "1001",
          result: {
            userID: 42,
            clientId: "client-1",
            userToken: "token-not-a-real-secret",
            countryCode: "US",
            phoneCode: "1",
            iot: {
              pfKey: {
                accessid: "access-id",
                accesskey: "access-key",
                openapiDomain: "https://openapi-usce.mearicloud.com",
                platformDomain: "usce.mearicloud.com",
              },
              mqtt: { host: "events-usce.mearicloud.com", port: 1883 },
            },
          },
        });
      case "/v2/app/config/pf/init":
        return jsonResponse({
          resultCode: "1001",
          result: {
            pfApi: {
              openapi: { domain: "https://openapi-usce.mearicloud.com" },
              mqtt: { host: "events-usce.mearicloud.com", port: 1883 },
              platform: { domain: "usce.mearicloud.com" },
            },
          },
        });
      case "/v1/app/device/info/get":
        return jsonResponse({
          resultCode: "1001",
          result: {
            ipc: [{
              deviceID: 7,
              deviceName: "PET3T",
              snNum: "ppsl1234567890123456",
              deviceSignature: "device-signature-not-a-real-secret",
              t: 1_700_000_001,
              iotType: 3,
              capability: JSON.stringify({ caps: { pet: 1, pfp: 1, ptz2: 1, md: 1, sd: 1 } }),
            }],
          },
        });
      case "/openapi/device/config":
        return jsonResponse(replies.shift() ?? { code: 100001, action: "set", name: "iot" });
      default:
        throw new Error(`Unexpected request: ${url.pathname}`);
    }
  };
  const client = new MeariClient({
    email: "owner@example.com",
    password: "correct horse battery staple",
    countryCode: "US",
    includeSharedHomes: false,
    fetch,
    clock: () => 1_700_000_000_000,
    random: () => 0.25,
    ...extra,
    profile: { ...resolveAppProfile(extra.profile), caKey: "test-app-key", caSecret: "test-app-secret" },
  });
  return { client, requests };
}

function decodedIotPayload(request: CapturedRequest): Record<string, unknown> {
  const encoded = request.url.searchParams.get("params");
  if (!encoded) throw new Error("missing params");
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Record<string, unknown>;
}

describe("TKENPRO Meari client", () => {
  test("normalizes email accounts and derives TKENPRO regional routing metadata", async () => {
    const { client, requests } = makeHarness({
      email: "  Owner@Example.COM  ",
      countryCode: "gb",
    });

    await client.redirect();

    const redirect = requests[0]?.url;
    expect(redirect?.searchParams.get("countryCode")).toBe("GB");
    expect(redirect?.searchParams.get("phoneCode")).toBe("44");
    expect(redirect?.searchParams.get("userAccount")).toBe(encodeUserAccount(
      "owner@example.com",
      "/ppstrongs/redirect",
      1_700_000_000_000,
      TKENPRO_PROFILE.partnerId,
      TKENPRO_PROFILE.ttid,
    ));
  });

  test("uses the exact encrypted TKENPRO 6.2.0 profile through full login", async () => {
    const { client, requests } = makeHarness();
    const result = await client.login();

    expect(TKENPRO_PROFILE).toMatchObject({
      sourceApp: "124",
      partnerId: "124",
      appVer: "6.2.0",
      appVerCode: "1041",
      encryptedLogin: true,
    });
    expect(requests.map((request) => request.url.pathname)).toEqual([
      "/ppstrongs/redirect",
      "/meari/app/login",
      "/v2/app/config/pf/init",
      "/v1/app/device/info/get",
    ]);
    const login = requests[1];
    expect(login?.form.get("sourceApp")).toBe("124");
    expect(login?.form.get("appVer")).toBe("6.2.0");
    expect(login?.form.get("appVerCode")).toBe("1041");
    expect(login?.form.get("encryStatus")).toBe("1");
    expect(login?.form.get("password")).not.toContain("correct horse");
    expect(login?.form.get("userAccount")).not.toContain("owner@example.com");
    expect(result.devices).toHaveLength(1);
    expect(result.session.accessId).toBe("access-id");
  });

  test("encodes IoT reads and always dispenses one treat with the single-portion action", async () => {
    const { client, requests } = makeHarness({}, [
      { code: 100001, action: "get", iot: { "114": { value: 1 }, "115": "64G" } },
      { code: 100001, action: "set" },
    ]);
    await client.login();
    requests.splice(0);

    const values = await client.getIotValues("ppsl1234567890123456", [114, 115]);
    await client.feed("ppsl1234567890123456");
    expect(() => client.setControl("ppsl1234567890123456", "feed", 3)).toThrow(/exactly one treat/u);

    expect(values).toEqual({ "114": 1, "115": "64G" });
    expect(decodedIotPayload(requests[0] as CapturedRequest)).toEqual({
      code: 100001,
      action: "get",
      name: "iot",
      iot: ["114", "115"],
    });
    expect(decodedIotPayload(requests[1] as CapturedRequest)).toEqual({
      code: 100001,
      action: "set",
      name: "iot",
      iot: { "845": 1 },
    });
    expect(requests[1]?.url.searchParams.has("target")).toBe(false);
  });

  test("matches CloudEdge's PET3T codecs for audio, duration, RGB, PTZ actions, and restart", async () => {
    const { client, requests } = makeHarness({}, [
      { code: 100001, action: "get", iot: { "105": 0 } },
    ]);
    await client.login();
    requests.splice(0);

    const storage = await client.getStorageInfo("ppsl1234567890123456");
    await client.setStorageRecordDuration("ppsl1234567890123456", 20);
    await client.setFeedSound("ppsl1234567890123456", "http://camera.lan/feed.wav");
    await client.setPetCallSound("ppsl1234567890123456", "http://camera.lan/call.wav");
    await client.playFeedCall("ppsl1234567890123456");
    await client.watchFoodBowl("ppsl1234567890123456");
    await client.setControl("ppsl1234567890123456", "newFeedPlan", JSON.stringify([{ time: "08:00", count: 1 }]));
    await client.setControl("ppsl1234567890123456", "todayFeedPlan", JSON.stringify([{ time: "08:00", count: 1, enable: 1 }]));
    await client.setControl("ppsl1234567890123456", "petKeyLock", true);
    await client.setControl("ppsl1234567890123456", "stuckFeedRepair", true);
    await client.setControl("ppsl1234567890123456", "noEatDetection", true);
    await client.setControl("ppsl1234567890123456", "noEatWaitTime", 6);
    await client.setControl("ppsl1234567890123456", "remainingGrain", { enable: 1, mode: 2 });
    await client.setRgbColor("ppsl1234567890123456", 0xff8001);
    await client.startPtzPatrol("ppsl1234567890123456");
    await client.calibratePtz("ppsl1234567890123456");
    await client.goToPtzPreset("ppsl1234567890123456", 4);
    await client.resetDevice("ppsl1234567890123456", "RESET_DEVICE");

    expect(storage.recordDurationSeconds).toBe(60);
    expect(requests.slice(1).map((request) => (decodedIotPayload(request) as { iot: unknown }).iot)).toEqual([
      { "105": 3 },
      { "843": JSON.stringify({ url: "http://camera.lan/feed.wav" }) },
      { "860": JSON.stringify({ url: "http://camera.lan/call.wav" }) },
      { "844": 1 },
      { "868": 1 },
      { "338": JSON.stringify([{ time: "08:00", count: 1 }]) },
      { "344": JSON.stringify([{ time: "08:00", count: 1, enable: 1 }]) },
      { "415": 1 },
      { "875": JSON.stringify({ fix: 1 }) },
      { "353": 1 },
      { "355": 6 },
      { "387": JSON.stringify({ enable: 1, mode: 2 }) },
      { "198": JSON.stringify([255, 128, 1]) },
      { "822": "{}" },
      { "847": 1 },
      { "848": JSON.stringify({ idx: 4 }) },
      { "800": "1" },
    ]);
  });

  test("matches CloudEdge's timezone-shifted OpenAPI expiry and signature", async () => {
    const { client, requests } = makeHarness({}, [
      { code: 100001, action: "set", name: "iot" },
    ]);
    await client.login();
    requests.splice(0);

    await client.feedOnePortion("ppsl1234567890123456");

    const request = requests[0] as CapturedRequest;
    expect(decodedIotPayload(request)).toEqual({
      code: 100001,
      action: "set",
      name: "iot",
      iot: { "845": 1 },
    });
    const expiresAt = 1_700_000_000_000 + 60_000;
    const expires = String(
      Math.floor(expiresAt / 1_000) + new Date(expiresAt).getTimezoneOffset() * 60,
    );
    expect(request.url.searchParams.get("expires")).toBe(expires);
    expect(request.url.searchParams.get("signature")).toBe(hmacSha1Base64(
      `GET\n\n\n${expires}\n/openapi/device/config\nset`,
      "access-key",
    ));
  });

  test("refreshes expired platform credentials and retries an IoT command like CloudEdge", async () => {
    const { client, requests } = makeHarness({}, [
      { errid: 401, reason: "Timeout" },
      { code: 100001, action: "set", name: "iot" },
    ]);
    await client.login();
    requests.splice(0);

    await client.feedOnePortion("ppsl1234567890123456");

    expect(requests.map((request) => request.url.pathname)).toEqual([
      "/openapi/device/config",
      "/v2/app/config/pf/init",
      "/openapi/device/config",
    ]);
    expect(requests[1]?.url.searchParams.get("iotType")).toBe("4");
    expect(requests[1]?.url.searchParams.get("refresh")).toBe("1");
    expect(decodedIotPayload(requests[2] as CapturedRequest)).toEqual({
      code: 100001,
      action: "set",
      name: "iot",
      iot: { "845": 1 },
    });
  });

  test("atomically configures legacy ONVIF with a standard Base64 password", async () => {
    const { client, requests } = makeHarness();
    await client.login();
    requests.splice(0);

    await client.configureOnvif("ppsl1234567890123456", {
      enabled: true,
      password: "PetCam-2026!",
    });

    expect(requests).toHaveLength(1);
    expect(decodedIotPayload(requests[0] as CapturedRequest)).toEqual({
      code: 100001,
      action: "set",
      name: "iot",
      iot: {
        "121": 1,
        "122": "UGV0Q2FtLTIwMjYh",
      },
    });
    expect(requests[0]?.url.searchParams.get("target")).toBe("server");
    expect(requests[0]?.url.searchParams.get("token")).toBe(
      "device-signature-not-a-real-secret",
    );
    expect(requests[0]?.url.searchParams.get("t")).toBe("1700000001");
    expect(requests[0]?.url.searchParams.get("clientid")).toBe("42");
  });

  test("rejects passwords outside the legacy svc=3 ONVIF limits before writing", async () => {
    const { client, requests } = makeHarness();
    await client.login();
    requests.splice(0);

    expect(() => client.configureOnvif("ppsl1234567890123456", {
      enabled: true,
      password: "",
    })).toThrow("must not be empty");
    expect(() => client.configureOnvif("ppsl1234567890123456", {
      enabled: true,
      password: "12345678901234567",
    })).toThrow("at most 16");
    expect(() => client.configureOnvif("ppsl1234567890123456", {
      enabled: true,
      password: "café",
    })).toThrow("printable ASCII");
    expect(() => client.configureOnvif("ppsl1234567890123456", {
      enabled: true,
      password: "line\nbreak",
    })).toThrow("printable ASCII");
    expect(requests).toHaveLength(0);
  });

  test("always sends PTZ stop from finally when the movement lease fails", async () => {
    const leaseError = new Error("lease aborted");
    const { client, requests } = makeHarness({ sleep: async () => { throw leaseError; } });
    await client.login();
    requests.splice(0);

    await expect(client.movePtz("ppsl1234567890123456", "left")).rejects.toBe(leaseError);

    expect(requests).toHaveLength(2);
    expect(decodedIotPayload(requests[0] as CapturedRequest)).toMatchObject({
      action: "set",
      iot: { "841": "{\"ps\":-80,\"ts\":0,\"zs\":0}" },
    });
    expect(decodedIotPayload(requests[1] as CapturedRequest)).toMatchObject({
      action: "set",
      iot: { "842": "{}" },
    });
  });

  test("blocks destructive raw writes until the matching confirmation is explicit", async () => {
    const { client, requests } = makeHarness();
    await client.login();
    requests.splice(0);

    await expect(
      client.setIotValue("ppsl1234567890123456", IOT_CODES.FORMAT_SD_CARD, "{}"),
    ).rejects.toBeInstanceOf(DestructiveControlError);
    await expect(
      client.setIotValue("ppsl1234567890123456", IOT_CODES.RESET_DEVICE, "{}"),
    ).rejects.toBeInstanceOf(DestructiveControlError);
    expect(requests).toHaveLength(0);

    await client.formatStorage("ppsl1234567890123456", "FORMAT_STORAGE");
    expect(decodedIotPayload(requests[0] as CapturedRequest)).toMatchObject({
      iot: { "806": "{}" },
    });
  });
});

describe("protocol helpers and capability catalog", () => {
  test("matches the vendor 3DES password vector and serial conversion", () => {
    expect(encryptPassword("password")).toBe("hav9vqc40esr/f3mcuC3iA==");
    expect(formatSn("123456789")).toBe("0000000123456789");
    expect(formatSn("ppsl1234567890123456")).toBe("1234567890123456");
  });

  test("discovers feeder/PTZ controls from capability.caps", () => {
    const device = {
      snNum: "ppsl1234567890123456",
      capability: JSON.stringify({ caps: { pet: 1, pfp: 1, ptz2: 1, las: 1, sd: 1 } }),
    };
    expect(getDeviceCapabilities(device)).toMatchObject({ pfp: 1, ptz2: 1 });
    const ids = new Set(getAvailableControls(device).map((control) => control.id));
    expect(ids.has("feed")).toBe(true);
    expect(ids.has("feedSchedule")).toBe(true);
    expect(ids.has("ptzMove")).toBe(true);
    expect(ids.has("ptzPreset")).toBe(true);
    expect(ids.has("ptzCalibration")).toBe(false);
    expect(ids.has("formatStorage")).toBe(true);
    expect(ids.has("watchBowl")).toBe(false);
    expect(ids.has("feedCall")).toBe(false);
    expect(ids.has("h265")).toBe(false);

    const exactIds = new Set(getAvailableControls({
      ...device,
      capability: JSON.stringify({ caps: { pet: 1, pfp: 1, pms: 1, bowl: 1, ptc: 1, pkl: 1, fmr: 1, food: 1, mmn: 1, rgd: 1, uvd: 1, fprm: 1 } }),
    }).map((control) => control.id));
    expect(exactIds.has("feedCall")).toBe(true);
    expect(exactIds.has("watchBowl")).toBe(true);
    expect(exactIds.has("ptzCalibration")).toBe(true);
    expect(exactIds.has("petKeyLock")).toBe(true);
    expect(exactIds.has("stuckFeedRepair")).toBe(true);
    expect(exactIds.has("noEatDetection")).toBe(true);
    expect(exactIds.has("noEatWaitTime")).toBe(true);
    expect(exactIds.has("remainingGrain")).toBe(true);
  });

  test("marks ONVIF as caution because it can disable cloud recording", () => {
    expect(PET3T_CONTROL_BY_ID.onvif).toMatchObject({
      safety: "caution",
      description: expect.stringContaining("disable cloud recording"),
    });
  });
});
