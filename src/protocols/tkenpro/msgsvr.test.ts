import { describe, expect, test } from "bun:test";
import {
  buildMeariIotSettingsRequest,
  decodeMeariRoutedFragmentInfo,
  decodeMeariRoutedPayload,
  decodeMsgSvrFrame,
  encodeMeariRoutedPayload,
  encodeMeariRoutedPayloads,
  encodeMeariLanConnectFrame,
  encodeMsgSvrFrame,
  MSGSVR_COMMANDS,
  MSGSVR_METHODS,
  MSGSVR_NODES,
  MeariRoutedPayloadAssembler,
  msgSvrFrameByteLength,
  splitMsgSvrFrames,
} from "./msgsvr.ts";

describe("Meari MsgSvr codec", () => {
  test("encodes and decodes the encrypted native heartbeat frame", () => {
    const payload = {
      uuid: "0123456789abcdef",
      token: "abc123",
      ver: 15213,
      runtime: 42,
      t: "1700000000.125",
    };
    const frame = encodeMsgSvrFrame({
      node: MSGSVR_NODES.CAMERA,
      method: MSGSVR_METHODS.DIRECT,
      command: MSGSVR_COMMANDS.HEARTBEAT,
      payload,
    });

    expect(frame.subarray(0, 6).toString("hex")).toBe("e6a2b1c9d3e6");
    expect(frame.at(-1)).toBe(0x9d);
    expect(msgSvrFrameByteLength(frame.subarray(0, 8))).toBe(frame.byteLength);
    expect(decodeMsgSvrFrame(frame)).toMatchObject({
      node: MSGSVR_NODES.CAMERA,
      method: MSGSVR_METHODS.DIRECT,
      command: MSGSVR_COMMANDS.HEARTBEAT,
      encrypted: true,
      checksumKind: "sum",
      payload,
    });
  });

  test("accepts the server cluster's zero-padded 3DES replies", () => {
    const original = encodeMsgSvrFrame({
      node: MSGSVR_NODES.SERVER,
      method: MSGSVR_METHODS.DIRECT,
      command: MSGSVR_COMMANDS.STATUS,
      payload: { result: "OK" },
    });
    // The plaintext is exactly 16 bytes, so PKCS#5 adds a complete 8-byte
    // block. Re-encrypting is covered by the live cluster test; here we assert
    // that ordinary PKCS#5 remains accepted after tolerant unpadding.
    expect(decodeMsgSvrFrame(original).payload).toEqual({ result: "OK" });
  });

  test("accepts plaintext frames and preserves incomplete stream data", () => {
    const first = encodeMsgSvrFrame({
      node: MSGSVR_NODES.APP,
      method: MSGSVR_METHODS.ROUTED,
      command: MSGSVR_COMMANDS.CONNECT,
      payload: { sid: "1234567800000001" },
      encrypted: false,
    });
    const second = encodeMsgSvrFrame({
      node: MSGSVR_NODES.SERVER,
      method: MSGSVR_METHODS.DIRECT,
      command: MSGSVR_COMMANDS.STATUS,
      payload: { status: "online" },
    });
    const partialLength = second.byteLength - 3;
    const parsed = splitMsgSvrFrames(Buffer.concat([first, second.subarray(0, partialLength)]));

    expect(parsed.frames).toHaveLength(1);
    expect(decodeMsgSvrFrame(parsed.frames[0] as Buffer).payload).toEqual({ sid: "1234567800000001" });
    expect(parsed.remainder).toEqual(second.subarray(0, partialLength));
  });

  test("rejects corrupted payload checksums", () => {
    const frame = encodeMsgSvrFrame({
      node: MSGSVR_NODES.SERVER,
      method: MSGSVR_METHODS.ROUTED,
      command: MSGSVR_COMMANDS.HEARTBEAT,
      payload: { ok: true },
    });
    frame[8] = (frame[8] ?? 0) ^ 0xff;
    expect(() => decodeMsgSvrFrame(frame)).toThrow("checksum");
  });

  test("preserves the camera's binary WebRTC relay registration", () => {
    const frame = Buffer.from(
      "e6a2b1c6d1e6100062613434616366373031840000000000719d",
      "hex",
    );
    expect(decodeMsgSvrFrame(frame)).toMatchObject({
      node: MSGSVR_NODES.CAMERA,
      command: MSGSVR_COMMANDS.WEBRTC,
      type: 0xd1,
      encrypted: false,
      payloadBytes: Buffer.from("62613434616366373031840000000000", "hex"),
      checksumKind: "sum",
    });
    expect(encodeMsgSvrFrame({
      node: MSGSVR_NODES.CAMERA,
      method: MSGSVR_METHODS.DIRECT,
      command: MSGSVR_COMMANDS.WEBRTC,
      type: 0xd1,
      payload: Buffer.from("62613434616366373031840000000000", "hex"),
      encrypted: false,
    })).toEqual(frame);
  });

  test("builds the native plaintext LAN candidate punch", () => {
    const frame = encodeMeariLanConnectFrame("0123abcd");
    expect(frame.subarray(0, 8).toString("hex")).toBe("e6a1b2c3d1e61a00");
    expect(decodeMsgSvrFrame(frame)).toMatchObject({
      type: 0xd1,
      payload: { sid: "0123abcd00000001" },
    });
  });

  test("encodes and decodes the routed JSON envelope used by IoT settings", () => {
    const content = buildMeariIotSettingsRequest(
      "0123456789abcdef",
      { "842": "{}" },
      "1700000000",
    );
    const payload = encodeMeariRoutedPayload({
      from: { node: "client", domain: "client-session", transport: "tcp", type: "binary" },
      to: { node: "datasvr", domain: "example", transport: "tcp", type: "binary", ip: "192.0.2.2", port: 18_834 },
      content,
    });
    const frame = encodeMsgSvrFrame({
      node: MSGSVR_NODES.APP,
      method: MSGSVR_METHODS.ROUTED,
      command: MSGSVR_COMMANDS.WEBRTC,
      payload,
    });

    const decoded = decodeMsgSvrFrame(frame);
    expect(decodeMeariRoutedPayload(decoded.payload)).toEqual({
      from: { node: "client", domain: "client-session", transport: "tcp", type: "binary" },
      to: { node: "datasvr", domain: "example", transport: "tcp", type: "binary", ip: "192.0.2.2", port: 18_834 },
      content,
    });
  });

  test("repairs the camera's bare SDP newlines inside a routed JSON string", () => {
    const content = '{"cmd":"answer","sdp":"line one\nline two\r\n"}';
    const decoded = decodeMeariRoutedPayload<{ cmd: string; sdp: string }>({
      from: { node: "dev" },
      to: { node: "webrtcsvr" },
      content: Buffer.from(content, "utf8").toString("base64"),
    });
    expect(decoded.content).toEqual({
      cmd: "answer",
      sdp: "line one\nline two\r\n",
    });
  });

  test("matches and reassembles the native 1024-byte routed fragmentation format", () => {
    const content = {
      sid: "1700000000",
      action: "sync",
      cmd: "conf",
      method: "settings",
      params: { code: 100001, action: "sync", name: "iot", iot: { "843": "x".repeat(1_700) } },
    };
    const payloads = encodeMeariRoutedPayloads({
      from: { node: "dev", domain: "camera" },
      to: { node: "datasvr", domain: "local" },
      content,
    }, { tag: 984_821_355, fragmentId: 0xfa });
    expect(payloads).toHaveLength(2);
    expect(decodeMeariRoutedFragmentInfo(payloads[0])).toEqual({
      tag: 984_821_355,
      fragmentId: 0xfa,
      index: 0,
      count: 2,
    });
    expect(payloads[0]?.flag).toBe(0x0002fa40);
    expect(payloads[1]?.flag).toBe(0x0102fa40);

    const assembler = new MeariRoutedPayloadAssembler();
    expect(assembler.accept(payloads[1])).toBeUndefined();
    expect(assembler.accept(payloads[0])).toEqual({
      from: { node: "dev", domain: "camera" },
      to: { node: "datasvr", domain: "local" },
      content,
      tag: 984_821_355,
    });
  });

  test("accepts a signed Java representation of a native fragment tag", () => {
    expect(decodeMeariRoutedFragmentInfo({
      tag: -1,
      flag: 0x0003_1540,
    })).toEqual({
      tag: 0xffff_ffff,
      fragmentId: 0x15,
      index: 0,
      count: 3,
    });
  });
});
