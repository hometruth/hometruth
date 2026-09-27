import { createCipheriv, createDecipheriv } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { BroadlinkBlaster } from "./index.ts";
import { BroadlinkClient, BroadlinkError, describeSignalPacket, type BroadlinkTransport } from "../../../protocols/broadlink/protocol";
import { InfraredBlaster, IrRfBlasterError, RadioFrequencyBlaster } from "../../../models/blaster";
import { validators } from "../../../validation";

const DEFAULT_KEY = Buffer.from([
  0x09, 0x76, 0x28, 0x34, 0x3f, 0xe9, 0x9e, 0x23,
  0x76, 0x5c, 0x15, 0x13, 0xac, 0xcf, 0x8b, 0x02,
]);
const DEFAULT_IV = Buffer.from([
  0x56, 0x2e, 0x17, 0x99, 0x6d, 0x09, 0x3d, 0x28,
  0xdd, 0xb3, 0xba, 0x69, 0x5a, 0x2e, 0x6f, 0x58,
]);
const DEVICE_KEY = Buffer.from("0123456789abcdef", "ascii");

function encryptWith(key: Buffer, payload: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-cbc", key, DEFAULT_IV);
  cipher.setAutoPadding(false);
  const padded = Buffer.concat([payload, Buffer.alloc((16 - (payload.length % 16)) % 16)]);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}

function decryptWith(key: Buffer, payload: Buffer): Buffer {
  const decipher = createDecipheriv("aes-128-cbc", key, DEFAULT_IV);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(payload), decipher.final()]);
}

function fakeAuthResponse(): Buffer {
  const decrypted = Buffer.alloc(0x14);
  DEVICE_KEY.copy(decrypted, 0x04);
  const encrypted = encryptWith(DEFAULT_KEY, decrypted);
  const packet = Buffer.alloc(0x38 + encrypted.length);
  packet.writeInt16LE(0, 0x22);
  encrypted.copy(packet, 0x38);
  return packet;
}

function fakeCommandResponse(errorCode: number, decryptedBody?: Buffer): Buffer {
  const encrypted = decryptedBody ? encryptWith(DEVICE_KEY, decryptedBody) : Buffer.alloc(0);
  const packet = Buffer.alloc(0x38 + encrypted.length);
  packet.writeInt16LE(errorCode, 0x22);
  encrypted.copy(packet, 0x38);
  return packet;
}

/** Wraps response data the way rmminib/rm4pro frame it: 2-byte length + 4-byte echoed sub-command + data. */
function rmAck(data: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(data.length + 4, 0x00);
  return fakeCommandResponse(0, Buffer.concat([header, data]));
}

/** A transport that authenticates once and answers every later command with `respond`. */
function transportWith(respond: (packet: Buffer) => Buffer): BroadlinkTransport {
  return async (_host, _port, packet) => {
    const command = packet.readUInt16LE(0x26);
    if (command === 0x65) return fakeAuthResponse();
    return respond(packet);
  };
}

function blasterWithTransport(transport: BroadlinkTransport, host = "10.77.0.12"): BroadlinkBlaster {
  return new BroadlinkBlaster({ id: "b1", host, client: new BroadlinkClient({ host, transport }) });
}

describe("BroadlinkBlaster", () => {
  test("rejects a public host", () => {
    expect(() => new BroadlinkBlaster({ id: "b1", host: "example.com" })).toThrow(IrRfBlasterError);
  });

  test("authenticates lazily, once, across multiple sends", async () => {
    let authCalls = 0;
    const transport: BroadlinkTransport = async (_host, _port, packet) => {
      if (packet.readUInt16LE(0x26) === 0x65) {
        authCalls += 1;
        return fakeAuthResponse();
      }
      return rmAck();
    };
    const blaster = blasterWithTransport(transport);

    await blaster.send("infrared", Buffer.from([1, 2, 3]).toString("base64"));
    expect(authCalls).toBe(1);
    await blaster.send("infrared", Buffer.from([4, 5, 6]).toString("base64"));
    expect(authCalls).toBe(1);
  });

  /** Decrypts the RM command payload a fake transport received and returns the signal packet after the 4-byte sub-command. */
  function sentPacket(packet: Buffer): Buffer {
    const decrypted = decryptWith(DEVICE_KEY, packet.subarray(0x38));
    const length = decrypted.readUInt16LE(0);
    return decrypted.subarray(6, 2 + length);
  }

  // 0x26 = infrared, no repeats, 8 pulse bytes: 4 × 100 ticks + a 0x00-prefixed 16-bit gap of 0x0d05 ticks.
  const frame = Buffer.from([0x26, 0x00, 0x08, 0x00, 100, 100, 100, 100, 0x00, 0x0d, 0x05, 0x00]);

  test("describeSignalPacket reads the repeat byte and sums pulse ticks into a frame duration", () => {
    const shape = describeSignalPacket(frame);
    expect(shape?.repeats).toBe(0);
    expect(shape?.frameMs).toBeCloseTo((400 + 0x0d05) * 269 / 8192, 3);
    expect(describeSignalPacket(Buffer.from([0x26, 0x00]))).toBeUndefined();
  });

  test("sends the packet once, untouched, when no hold is asked for", async () => {
    const packets: Buffer[] = [];
    const blaster = blasterWithTransport(transportWith((packet) => { packets.push(sentPacket(packet)); return rmAck(); }));
    await blaster.send("infrared", frame.toString("base64"));
    await blaster.send("infrared", frame.toString("base64"), { durationMs: 0 });
    expect(packets).toHaveLength(2);
    expect(packets[0]!.equals(frame)).toBe(true);
    expect(packets[1]!.equals(frame)).toBe(true);
  });

  test("a hold is filled with the packet's repeat byte so the device transmits back-to-back", async () => {
    const packets: Buffer[] = [];
    const blaster = blasterWithTransport(transportWith((packet) => { packets.push(sentPacket(packet)); return rmAck(); }));
    const frameMs = describeSignalPacket(frame)!.frameMs; // ≈ 122 ms
    await blaster.send("infrared", frame.toString("base64"), { durationMs: 1000 });
    expect(packets).toHaveLength(1);
    const expectedFrames = Math.ceil(1000 / frameMs);
    expect(packets[0]![1]).toBe(expectedFrames - 1);
    expect(packets[0]!.subarray(2).equals(frame.subarray(2))).toBe(true);
  });

  test("a hold longer than 256 frames is split across consecutive packets", async () => {
    const packets: Buffer[] = [];
    const blaster = blasterWithTransport(transportWith((packet) => { packets.push(sentPacket(packet)); return rmAck(); }));
    // A tiny frame (one 1-tick pulse ≈ 0.033 ms) so a short hold needs many frames without a long test.
    const tiny = Buffer.from([0x26, 0x00, 0x01, 0x00, 0x01]);
    await blaster.send("infrared", tiny.toString("base64"), { durationMs: 10 });
    const framesNeeded = Math.ceil(10 / (269 / 8192)); // 305
    expect(packets.length).toBe(Math.ceil(framesNeeded / 256));
    expect(packets[0]![1]).toBe(255);
    expect(packets[packets.length - 1]![1]).toBe((framesNeeded - 256 * (packets.length - 1)) - 1);
  });

  test("rejects an empty or invalid code", async () => {
    const blaster = blasterWithTransport(transportWith(() => rmAck()));
    await expect(blaster.send("infrared", "")).rejects.toThrow(/empty/);
  });

  test("maps a protocol error to IrRfBlasterError", async () => {
    const blaster = blasterWithTransport(transportWith(() => fakeCommandResponse(-4)));
    await expect(blaster.send("infrared", Buffer.from([1]).toString("base64"))).rejects.toThrow(IrRfBlasterError);
  });

  test("learn polls until a code is captured and returns it base64-encoded", async () => {
    const signal = Buffer.from([0x26, 0x00, 0x01, 0x02, 0x03]);
    let polls = 0;
    const blaster = blasterWithTransport(transportWith(() => {
      polls += 1;
      if (polls === 1) return rmAck(); // enterLearning ack
      if (polls < 3) return fakeCommandResponse(-1); // not ready yet
      return rmAck(signal);
    }));

    const learned = await blaster.learn({ channel: "infrared", timeoutMs: 5_000 });
    const captured = Buffer.from(learned.code, "base64");
    expect(captured.equals(signal)).toBe(true);
    expect(learned.frequencyHz).toBeUndefined();
  });

  test("learn times out when nothing is ever captured", async () => {
    let polls = 0;
    const blaster = blasterWithTransport(transportWith(() => {
      polls += 1;
      return polls === 1 ? rmAck() : fakeCommandResponse(-1); // enterLearning ack, then never ready
    }));
    await expect(blaster.learn({ channel: "infrared", timeoutMs: 50 })).rejects.toThrow(/No signal was captured/);
  });

  test("learn on radio-frequency detects the carrier first, then captures", async () => {
    const signal = Buffer.from([0x26, 0x00, 0x01, 0x02, 0x03]);
    let polls = 0;
    const blaster = blasterWithTransport(transportWith((packet) => {
      polls += 1;
      const decrypted = decryptWith(DEVICE_KEY, packet.subarray(0x38));
      const subCommand = decrypted.readUInt32LE(0x02);
      if (subCommand === 0x19) return rmAck(); // sweepFrequency ack
      if (subCommand === 0x1a) {
        // checkFrequency: first poll "not ready", second reports 433.92MHz found.
        if (polls < 3) return fakeCommandResponse(-1);
        const body = Buffer.alloc(5);
        body[0] = 1;
        body.writeUInt32LE(433920, 1);
        return rmAck(body);
      }
      if (subCommand === 0x1b) return rmAck(); // findRfPacket ack
      // checkData (0x04): not ready once, then the captured signal.
      if (polls < 5) return fakeCommandResponse(-1);
      return rmAck(signal);
    }));

    const learned = await blaster.learn({ channel: "radio-frequency", timeoutMs: 5_000 });
    expect(Buffer.from(learned.code, "base64").equals(signal)).toBe(true);
    expect(learned.frequencyHz).toBe(433920000);
  });

  test("learn on radio-frequency with a known frequency skips carrier detection", async () => {
    const signal = Buffer.from([0x26, 0x00, 0x01, 0x02, 0x03]);
    let polls = 0;
    let sawSweep = false;
    let findRfFrequency: number | undefined;
    const blaster = blasterWithTransport(transportWith((packet) => {
      polls += 1;
      const decrypted = decryptWith(DEVICE_KEY, packet.subarray(0x38));
      const subCommand = decrypted.readUInt32LE(0x02);
      if (subCommand === 0x19) { sawSweep = true; return rmAck(); }
      if (subCommand === 0x1b) {
        findRfFrequency = decrypted.readUInt32LE(0x06) * 1000;
        return rmAck();
      }
      if (polls < 2) return fakeCommandResponse(-1);
      return rmAck(signal);
    }));

    const learned = await blaster.learn({ channel: "radio-frequency", frequencyHz: 315_000_000, timeoutMs: 5_000 });
    expect(sawSweep).toBe(false);
    expect(findRfFrequency).toBe(315_000_000);
    expect(learned.frequencyHz).toBe(315_000_000);
    expect(Buffer.from(learned.code, "base64").equals(signal)).toBe(true);
  });

  test("the send control accepts a bare code or { code, durationMs } and validates the hold", async () => {
    const packets: Buffer[] = [];
    const blaster = blasterWithTransport(transportWith((packet) => { packets.push(sentPacket(packet)); return rmAck(); }));
    const infrared = new InfraredBlaster("b1", blaster);
    await infrared.invoke("send", frame.toString("base64"));
    await infrared.invoke("send", { code: frame.toString("base64"), durationMs: 500 });
    expect(packets).toHaveLength(2);
    expect(packets[0]![1]).toBe(0);
    expect(packets[1]![1]).toBeGreaterThan(0);
    await expect(infrared.invoke("send", { code: frame.toString("base64"), durationMs: 60001 })).rejects.toThrow(/durationMs/);
    await expect(infrared.invoke("send", { code: frame.toString("base64"), durationMs: 1.5 })).rejects.toThrow(/durationMs/);
    await expect(infrared.invoke("send", { durationMs: 500 })).rejects.toThrow(/signal code/);
  });

  test("probe succeeds once authenticated and fails when unreachable", async () => {
    const okBlaster = blasterWithTransport(transportWith(() => rmAck()));
    await expect(okBlaster.probe()).resolves.toBeUndefined();

    const failingTransport: BroadlinkTransport = async () => {
      throw new BroadlinkError("boom", "unreachable");
    };
    const failingBlaster = blasterWithTransport(failingTransport, "10.77.0.13");
    await expect(failingBlaster.probe()).rejects.toThrow(IrRfBlasterError);
  });

  test("the infrared and radio-frequency capabilities validate against their schemas", async () => {
    const blaster = blasterWithTransport(transportWith(() => rmAck()));

    const infrared = await new InfraredBlaster("b1", blaster).describe();
    expect(validators.infraredBlaster(infrared), JSON.stringify(validators.infraredBlaster.errors)).toBe(true);
    expect(infrared.state.availability).toBe("online");

    const radioFrequency = await new RadioFrequencyBlaster("b1", blaster).describe();
    expect(validators.radioFrequencyBlaster(radioFrequency), JSON.stringify(validators.radioFrequencyBlaster.errors)).toBe(true);
    expect(radioFrequency.state.availability).toBe("online");
  });

  test("the capabilities report offline without throwing when unreachable", async () => {
    const failingTransport: BroadlinkTransport = async () => {
      throw new BroadlinkError("boom", "unreachable");
    };
    const blaster = blasterWithTransport(failingTransport);

    const infrared = await new InfraredBlaster("b1", blaster).describe();
    expect(infrared.state.availability).toBe("offline");
    const radioFrequency = await new RadioFrequencyBlaster("b1", blaster).describe();
    expect(radioFrequency.state.availability).toBe("offline");
  });
});
