import { describe, expect, test } from "bun:test";
import { decodeKasaFrame, encodeKasaFrame, kasaDecrypt, kasaEncrypt, KasaError, kasaFrameLength } from "./codec";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const bytes = (value: string) => new Uint8Array(Buffer.from(value, "hex"));

describe("Kasa XOR-autokey codec", () => {
  test("encrypts get_sysinfo byte-exactly, length prefix included", () => {
    expect(hex(encodeKasaFrame({ system: { get_sysinfo: {} } })))
      .toBe("0000001dd0f281f88bff9af7d5ef94b6d1b4c09fec95e68fe187e8caf08bf68bf6");
  });

  test("encrypts emeter get_realtime byte-exactly", () => {
    expect(hex(encodeKasaFrame({ emeter: { get_realtime: {} } })))
      .toBe("0000001ed0f297fa9feb8efcdee49fbddabfcb94e683e28efa93fe9bb983f885f885");
  });

  test("the first byte is XORed with 171 and each ciphertext byte keys the next", () => {
    expect([...kasaEncrypt(new Uint8Array([0x7b, 0x7b, 0x00]))]).toEqual([0x7b ^ 171, 0x7b ^ 0x7b ^ 171, 0x7b ^ 0x7b ^ 171]);
    expect([...kasaDecrypt(new Uint8Array([0xd0, 0xab]))]).toEqual([0xd0 ^ 171, 0xab ^ 0xd0]);
  });

  test("decrypt inverts encrypt for arbitrary bytes", () => {
    const plain = new Uint8Array(512).map((_, index) => (index * 37 + 11) & 0xff);
    expect([...kasaDecrypt(kasaEncrypt(plain))]).toEqual([...plain]);
  });

  test("decodes a framed response", () => {
    const response = { system: { get_sysinfo: { model: "EP10(US)", relay_state: 1, err_code: 0 } } };
    expect(decodeKasaFrame(encodeKasaFrame(response))).toEqual(response);
  });

  test("decodes UTF-8 aliases", () => {
    expect(decodeKasaFrame(encodeKasaFrame({ alias: "Café lamp" }))).toEqual({ alias: "Café lamp" });
  });

  test("frame length waits for the prefix and rejects oversized frames", () => {
    expect(kasaFrameLength(bytes("0000"))).toBeUndefined();
    expect(kasaFrameLength(bytes("0000001d"))).toBe(33);
    expect(() => kasaFrameLength(bytes("00100001"))).toThrow(KasaError);
  });

  test("rejects truncated, padded, non-JSON and non-object frames", () => {
    const frame = encodeKasaFrame({ ok: true });
    expect(() => decodeKasaFrame(frame.subarray(0, frame.length - 1))).toThrow(KasaError);
    expect(() => decodeKasaFrame(new Uint8Array([...frame, 0]))).toThrow(KasaError);
    const garbage = new Uint8Array([0, 0, 0, 3, ...kasaEncrypt(new TextEncoder().encode("{x}"))]);
    expect(() => decodeKasaFrame(garbage)).toThrow("not valid JSON");
    expect(() => decodeKasaFrame(encodeKasaFrame([1, 2]))).toThrow("not a JSON object");
  });
});
