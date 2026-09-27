import { describe, expect, test } from "bun:test";
import {
  decodeIvaFrame,
  decodeKcpSegments,
  encodeIvaData,
  encodeIvaHandshake,
  encodeKcpSegment,
  IVA_TYPE_DATA,
  IVA_TYPE_HANDSHAKE,
  KCP_COMMAND_ACK,
  KCP_COMMAND_PUSH,
  MEARI_KCP_CONVERSATION,
  MeariKcpTunnel,
} from "./kcp-tunnel.ts";

describe("Meari KCP and IVA codecs", () => {
  test("matches the native 24-byte little-endian KCP header", () => {
    const segment = encodeKcpSegment({
      command: KCP_COMMAND_PUSH,
      fragment: 2,
      window: 1024,
      timestamp: 0x1122_3344,
      sequence: 7,
      unacknowledged: 3,
      payload: Buffer.from("abc"),
    });
    expect(segment.toString("hex")).toBe(
      "0c0000005102000444332211070000000300000003000000616263",
    );
    expect(decodeKcpSegments(segment)).toEqual([{
      conversation: MEARI_KCP_CONVERSATION,
      command: KCP_COMMAND_PUSH,
      fragment: 2,
      window: 1024,
      timestamp: 0x1122_3344,
      sequence: 7,
      unacknowledged: 3,
      payloadLength: 3,
      payload: Buffer.from("abc"),
      byteLength: 27,
    }]);
    expect(decodeKcpSegments(Buffer.concat([segment, Buffer.alloc(4)]))).toHaveLength(1);
    expect(decodeKcpSegments(Buffer.concat([segment, Buffer.from([0xcd])]))).toHaveLength(1);
  });

  test("encodes exact IVA handshake and data envelopes", () => {
    const handshake = encodeIvaHandshake(0x1122_3344, 0x5566_7788);
    expect(handshake.toString("hex")).toBe(
      "ff01000044332211887766550000127000000000",
    );
    expect(decodeIvaFrame(handshake)).toMatchObject({
      type: IVA_TYPE_HANDSHAKE,
      sessionId1: 0x1122_3344,
      sessionId2: 0x5566_7788,
      payloadLength: 0,
    });
    const data = decodeIvaFrame(encodeIvaData(Buffer.from("feed"), 1, 2));
    expect(data).toMatchObject({
      type: IVA_TYPE_DATA,
      sessionId1: 1,
      sessionId2: 2,
      payload: Buffer.from("feed"),
    });
    const cameraHandshake = Buffer.from(handshake);
    cameraHandshake.writeUInt16LE(0x0100, 12);
    expect(decodeIvaFrame(cameraHandshake).type).toBe(IVA_TYPE_HANDSHAKE);
  });

  test("sends handshake at SN 0 and command at SN 1 without waiting", () => {
    const sent: Buffer[] = [];
    const tunnel = new MeariKcpTunnel({
      send: (datagram) => sent.push(datagram),
      now: () => 10_000,
      sessionId1: 1,
      sessionId2: 2,
    });
    tunnel.sendHandshake();
    tunnel.sendIvaData(Buffer.from("command"));
    expect(sent).toHaveLength(2);
    const handshake = decodeKcpSegments(sent[0] as Buffer)[0];
    const command = decodeKcpSegments(sent[1] as Buffer)[0];
    expect(handshake).toMatchObject({ command: KCP_COMMAND_PUSH, sequence: 0, fragment: 0 });
    expect(decodeIvaFrame(handshake?.payload as Buffer).type).toBe(IVA_TYPE_HANDSHAKE);
    expect(command).toMatchObject({ command: KCP_COMMAND_PUSH, sequence: 1, fragment: 0 });
    expect(decodeIvaFrame(command?.payload as Buffer).payload).toEqual(Buffer.from("command"));
    expect(tunnel.unacknowledgedSendCount).toBe(2);
  });

  test("reassembles out-of-order fragments, queues data, and emits compound ACKs", () => {
    const outbound: Buffer[] = [];
    const tunnel = new MeariKcpTunnel({
      send: (datagram) => outbound.push(datagram),
      maximumSegmentSize: 8,
      sessionId1: 1,
      sessionId2: 2,
    });
    const complete = encodeIvaData(Buffer.from("a complete response"), 9, 10);
    const chunks = [complete.subarray(0, 8), complete.subarray(8, 16), complete.subarray(16)];
    const segments = chunks.map((payload, index) => encodeKcpSegment({
      command: KCP_COMMAND_PUSH,
      fragment: chunks.length - index - 1,
      timestamp: 100 + index,
      sequence: 40 + index,
      payload,
    }));
    expect(tunnel.processDatagram(segments[1] as Buffer)[0]?.type).toBe("fragment");
    expect(tunnel.processDatagram(segments[0] as Buffer)[0]?.type).toBe("fragment");
    expect(tunnel.processDatagram(segments[2] as Buffer)).toEqual([
      { type: "data", payload: Buffer.from("a complete response") },
    ]);
    expect(tunnel.pollMessage()).toEqual(Buffer.from("a complete response"));
    expect(tunnel.pollMessage()).toBeUndefined();

    const acknowledgements = tunnel.flushAcks();
    expect(acknowledgements).toHaveLength(1);
    expect(decodeKcpSegments(acknowledgements[0] as Buffer).map((segment) => segment.sequence)).toEqual([
      40,
      41,
      42,
    ]);
  });

  test("synchronizes on raw XTS media frames when media arrives before IVA", () => {
    const tunnel = new MeariKcpTunnel({ maximumSegmentSize: 8, sessionId1: 1, sessionId2: 2 });
    const complete = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x01, 0xfc]),
      Buffer.from("a raw video frame"),
    ]);
    const chunks = [complete.subarray(0, 8), complete.subarray(8, 16), complete.subarray(16)];
    const segments = chunks.map((payload, index) => encodeKcpSegment({
      command: KCP_COMMAND_PUSH,
      fragment: chunks.length - index - 1,
      timestamp: 100 + index,
      sequence: 40 + index,
      payload,
    }));

    expect(tunnel.processDatagram(segments[1] as Buffer)[0]?.type).toBe("fragment");
    expect(tunnel.processDatagram(segments[0] as Buffer)[0]?.type).toBe("fragment");
    expect(tunnel.processDatagram(segments[2] as Buffer)).toEqual([
      { type: "raw", payload: complete },
    ]);
    expect(tunnel.pollMessage()).toEqual(complete);
  });

  test("applies exact and cumulative acknowledgements to retransmission state", () => {
    const tunnel = new MeariKcpTunnel({ maximumSegmentSize: 2, sessionId1: 1, sessionId2: 2 });
    tunnel.sendMessage(Buffer.from("abcdef"));
    expect(tunnel.unacknowledgedSendCount).toBe(3);
    tunnel.processDatagram(encodeKcpSegment({
      command: KCP_COMMAND_ACK,
      sequence: 1,
      unacknowledged: 1,
    }));
    expect(tunnel.unacknowledgedSendCount).toBe(1);
    expect(decodeKcpSegments(tunnel.retransmitUnacknowledged()[0] as Buffer)[0]?.sequence).toBe(2);
  });
});
