import { createCipheriv, createDecipheriv } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { BroadlinkClient, BroadlinkError, type BroadlinkTransport } from "./protocol";

const DEFAULT_KEY = Buffer.from([
  0x09, 0x76, 0x28, 0x34, 0x3f, 0xe9, 0x9e, 0x23,
  0x76, 0x5c, 0x15, 0x13, 0xac, 0xcf, 0x8b, 0x02,
]);
const DEFAULT_IV = Buffer.from([
  0x56, 0x2e, 0x17, 0x99, 0x6d, 0x09, 0x3d, 0x28,
  0xdd, 0xb3, 0xba, 0x69, 0x5a, 0x2e, 0x6f, 0x58,
]);
const DEVICE_KEY = Buffer.from("0123456789abcdef", "ascii");

function decryptWith(key: Buffer, payload: Buffer): Buffer {
  const decipher = createDecipheriv("aes-128-cbc", key, DEFAULT_IV);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(payload), decipher.final()]);
}

function encryptWith(key: Buffer, payload: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-cbc", key, DEFAULT_IV);
  cipher.setAutoPadding(false);
  const padded = Buffer.concat([payload, Buffer.alloc((16 - (payload.length % 16)) % 16)]);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}

function checksum(buffer: Buffer): number {
  let sum = 0xbeaf;
  for (const byte of buffer) sum = (sum + byte) & 0xffff;
  return sum;
}

function fakeAuthResponse(deviceId: Buffer): Buffer {
  const decrypted = Buffer.alloc(0x14);
  deviceId.copy(decrypted, 0x00);
  DEVICE_KEY.copy(decrypted, 0x04);
  const encrypted = encryptWith(DEFAULT_KEY, decrypted);
  const packet = Buffer.alloc(0x38 + encrypted.length);
  packet.writeInt16LE(0, 0x22);
  encrypted.copy(packet, 0x38);
  return packet;
}

/** Wraps response data the way rmminib/rm4pro frame it: 2-byte length + 4-byte echoed sub-command + data. */
function rmResponseBody(data: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(data.length + 4, 0x00);
  return Buffer.concat([header, data]);
}

function fakeCommandResponse(errorCode: number, key?: Buffer, decryptedBody?: Buffer): Buffer {
  const packet = Buffer.alloc(0x38 + (key && decryptedBody ? Math.ceil(decryptedBody.length / 16) * 16 : 0));
  packet.writeInt16LE(errorCode, 0x22);
  if (key && decryptedBody) {
    const encrypted = encryptWith(key, decryptedBody);
    encrypted.copy(packet, 0x38);
  }
  return packet;
}

describe("BroadlinkClient", () => {
  test("authenticates and stores the per-device key from the response", async () => {
    const deviceId = Buffer.from([0x11, 0x22, 0x33, 0x44]);
    let sentPacket: Buffer | undefined;
    const transport: BroadlinkTransport = async (_host, _port, packet) => {
      sentPacket = packet;
      return fakeAuthResponse(deviceId);
    };
    const client = new BroadlinkClient({ host: "10.77.0.50", transport });
    const auth = await client.authenticate();

    expect(auth.deviceId.equals(deviceId)).toBe(true);
    expect(auth.key.equals(DEVICE_KEY)).toBe(true);
    expect(sentPacket).toBeDefined();
    expect(sentPacket!.subarray(0x00, 0x08).toString("hex")).toBe("5aa5aa555aa5aa55");
    expect(sentPacket!.readUInt16LE(0x26)).toBe(0x65);
  });

  test("rejects authentication when the device reports a non-zero error code", async () => {
    const transport: BroadlinkTransport = async () => fakeCommandResponse(-4);
    const client = new BroadlinkClient({ host: "10.77.0.50", transport });
    await expect(client.authenticate()).rejects.toThrow(BroadlinkError);
  });

  test("refuses to send before authentication", async () => {
    const transport: BroadlinkTransport = async () => fakeCommandResponse(0, DEVICE_KEY, rmResponseBody());
    const client = new BroadlinkClient({ host: "10.77.0.50", transport });
    await expect(client.sendCode(Buffer.from([0x01]))).rejects.toThrow(/not authenticated/i);
  });

  test("sends an encrypted code once authenticated", async () => {
    const deviceId = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    let authenticated = false;
    let sentPacket: Buffer | undefined;
    const transport: BroadlinkTransport = async (_host, _port, packet) => {
      if (!authenticated) {
        authenticated = true;
        return fakeAuthResponse(deviceId);
      }
      sentPacket = packet;
      return fakeCommandResponse(0, DEVICE_KEY, rmResponseBody());
    };
    const client = new BroadlinkClient({ host: "10.77.0.50", transport });
    await client.authenticate();
    await client.sendCode(Buffer.from([0xaa, 0xbb, 0xcc]));

    expect(sentPacket).toBeDefined();
    expect(sentPacket!.readUInt16LE(0x26)).toBe(0x6a);
    const decrypted = decryptWith(DEVICE_KEY, sentPacket!.subarray(0x38));
    // 2-byte length + 4-byte sub-command (0x02 = send data) precede the code.
    expect(decrypted.readUInt32LE(0x02)).toBe(0x02);
    expect(decrypted.subarray(0x06, 0x09).equals(Buffer.from([0xaa, 0xbb, 0xcc]))).toBe(true);
  });

  test("checkLearnedCode returns undefined while nothing has been captured", async () => {
    // -1 is the legacy "in progress" answer; RM4-era firmware uses -5 or -10.
    for (const notReady of [-1, -5, -10]) {
      const deviceId = Buffer.from([0x01, 0x02, 0x03, 0x04]);
      let calls = 0;
      const transport: BroadlinkTransport = async () => {
        calls += 1;
        if (calls === 1) return fakeAuthResponse(deviceId);
        return fakeCommandResponse(notReady);
      };
      const client = new BroadlinkClient({ host: "10.77.0.50", transport });
      await client.authenticate();
      expect(await client.checkLearnedCode()).toBeUndefined();
    }
  });

  test("checkLearnedCode decrypts a captured signal", async () => {
    const deviceId = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const signal = Buffer.from([0x26, 0x00, 0x01, 0x02, 0x03]);
    const decryptedBody = rmResponseBody(signal);
    let calls = 0;
    const transport: BroadlinkTransport = async () => {
      calls += 1;
      if (calls === 1) return fakeAuthResponse(deviceId);
      return fakeCommandResponse(0, DEVICE_KEY, decryptedBody);
    };
    const client = new BroadlinkClient({ host: "10.77.0.50", transport });
    await client.authenticate();
    const code = await client.checkLearnedCode();
    expect(code?.equals(signal)).toBe(true);
  });

  test("checksum is embedded in outgoing packets", async () => {
    const deviceId = Buffer.from([0, 0, 0, 0]);
    let sentPacket: Buffer | undefined;
    const transport: BroadlinkTransport = async (_host, _port, packet) => {
      sentPacket = packet;
      return fakeAuthResponse(deviceId);
    };
    const client = new BroadlinkClient({ host: "10.77.0.50", transport });
    await client.authenticate();
    const withFieldZeroed = Buffer.from(sentPacket!);
    withFieldZeroed.writeUInt16LE(0, 0x20);
    expect(sentPacket!.readUInt16LE(0x20)).toBe(checksum(withFieldZeroed));
  });
});
