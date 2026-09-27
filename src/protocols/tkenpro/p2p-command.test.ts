import { describe, expect, test } from "bun:test";
import {
  buildMeariCommonHttpRequest,
  buildVvpCommandAuth,
  decodeVvpCommandFrame,
  encodeVvpCommandFrame,
  formatMeariLicenceId,
  parseMeariHttpResponse,
  VVP_COMMAND_RESPONSE,
  VVP_WIRE_MAGIC,
} from "./p2p-command.ts";

const auth = {
  hostKey: "0123456789abcdef0123456789abcdef",
  protocolVersion: 2,
  licenceId: "00000000000100000001",
};

describe("Meari P2P command codec", () => {
  test("matches the native VVP 0x8000 frame and authenticator", () => {
    expect(formatMeariLicenceId("100000001")).toBe("00000000000100000001");
    expect(buildVvpCommandAuth(4, { ...auth, sequence: 7 })).toBe(
      "1b04677264b1613b6cc2af65ec3ae037",
    );

    const frame = encodeVvpCommandFrame("test", { ...auth, sequence: 7 });
    expect(frame.readUInt32BE(0)).toBe(VVP_WIRE_MAGIC);
    expect(frame.subarray(0, 16).toString("hex")).toBe(
      "56565099000000010000000700008000",
    );
    expect(frame.toString("ascii", 16, 48)).toBe("1b04677264b1613b6cc2af65ec3ae037");
    expect(frame.readUInt32BE(48)).toBe(4);
    expect(decodeVvpCommandFrame(frame)).toMatchObject({
      command: 0x8000,
      sequence: 7,
      payloadLength: 4,
      payload: Buffer.from("test"),
    });
  });

  test("serializes POST as the native authenticated HTTP/1.0 request", () => {
    const request = {
      action: "POST" as const,
      deviceurl: "http://127.0.0.1/devices/settings",
      volume: 42,
    };
    const payload = buildMeariCommonHttpRequest(request, auth);
    const [header, body] = payload.toString("utf8").split("\r\n\r\n");
    expect(header).toContain("POST /devices/settings HTTP/1.0");
    expect(header).toContain("Host: 127.0.0.1");
    expect(header).toContain("Content-Type: text/plain, charset=us-ascii");
    expect(header).toContain(
      `Authorization: Basic ${Buffer.from(`admin:${auth.hostKey}`).toString("base64")}`,
    );
    expect(header).toContain(`Content-Length: ${Buffer.byteLength(JSON.stringify(request))}`);
    expect(body).toBe(JSON.stringify(request));
  });

  test("matches CloudEdge's empty HTTP/1.1 settings read", () => {
    const request = {
      action: "GET" as const,
      deviceurl: "http://127.0.0.1/devices/settings",
    };
    const payload = buildMeariCommonHttpRequest(request, auth);
    const [header, body] = payload.toString("utf8").split("\r\n\r\n");
    expect(header).toContain("GET /devices/settings HTTP/1.1");
    expect(header).toContain("Content-Type: application/json");
    expect(header).toContain("Content-Length: 0");
    expect(body).toBe("");
  });

  test("includes CloudEdge's wrapper JSON body on ordinary GET routes", () => {
    const request = {
      action: "GET" as const,
      deviceurl: "http://127.0.0.1/devices/storage",
    };
    const payload = buildMeariCommonHttpRequest(request, auth);
    const [header, body] = payload.toString("utf8").split("\r\n\r\n");
    expect(header).toContain("GET /devices/storage HTTP/1.0");
    expect(header).toContain("Content-Type: text/plain, charset=us-ascii");
    expect(header).toContain(`Content-Length: ${Buffer.byteLength(JSON.stringify(request))}`);
    expect(body).toBe(JSON.stringify(request));
  });

  test("validates the paired 0x8001 response and parses its HTTP body", () => {
    const http = Buffer.from(
      "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"ok\":true}",
    );
    const responseFrame = encodeVvpCommandFrame(http, {
      ...auth,
      command: VVP_COMMAND_RESPONSE,
      sequence: 7,
    });
    const response = decodeVvpCommandFrame(responseFrame, 7);
    expect(parseMeariHttpResponse(response.payload)).toMatchObject({
      status: 200,
      statusText: "OK",
      bodyText: '{"ok":true}',
    });
    expect(() => decodeVvpCommandFrame(responseFrame, 8)).toThrow("sequence");
  });

  test("parses the JSON envelope returned by modern cameras", () => {
    const payload = Buffer.from(JSON.stringify({
      http_code: 200,
      http_result: '{"led_enable":1}',
    }));
    expect(parseMeariHttpResponse(payload)).toMatchObject({
      status: 200,
      statusText: "OK",
      bodyText: '{"led_enable":1}',
    });
  });
});
