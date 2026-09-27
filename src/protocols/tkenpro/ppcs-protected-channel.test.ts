import { describe, expect, test } from "bun:test";
import { PpcsProtectedChannelCodec } from "./ppcs-protected-channel.ts";

describe("protected PPCS channel codec", () => {
  test("round-trips protected data and acknowledgment frames", () => {
    const codec = new PpcsProtectedChannelCodec({
      hostKey: "0123456789abcdef0123456789",
    });
    const data = codec.encodeData(2, 0x1234, Buffer.from([0x40, 0x01, 0x02]));
    const parsedData = codec.decode(data);
    expect(parsedData.type).toBe("data");
    if (parsedData.type === "data") {
      expect(parsedData.frame.channel).toBe(2);
      expect(parsedData.frame.sequence).toBe(0x1234);
      expect(parsedData.frame.payload).toEqual(Buffer.from([0x40, 0x01, 0x02]));
    }

    const ack = codec.encodeAck(2, [0x1234, 0x1235]);
    const parsedAck = codec.decode(ack);
    expect(parsedAck.type).toBe("ack");
    if (parsedAck.type === "ack") {
      expect(parsedAck.frame.channel).toBe(2);
      expect(parsedAck.frame.sequences).toEqual([0x1234, 0x1235]);
    }
  });

  test("supports a confirmed raw inner-frame mode", () => {
    const codec = new PpcsProtectedChannelCodec({
      hostKey: "0123456789abcdef",
      protect: false,
    });
    const packet = codec.encodeData(1, 7, Buffer.from("voice"));
    expect(codec.decode(packet)).toMatchObject({
      type: "data",
      frame: { channel: 1, sequence: 7, payload: Buffer.from("voice") },
    });
  });
});
