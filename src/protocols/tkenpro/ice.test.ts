import { describe, expect, test } from "bun:test";
import {
  decodeStunMessage,
  encodeIceBindingRequest,
  encodeIceBindingSuccess,
  STUN_ATTRIBUTES,
  STUN_BINDING_REQUEST,
  STUN_BINDING_SUCCESS,
  verifyStunMessageIntegrity,
} from "./ice.ts";

const capturedCameraCheck = Buffer.from(
  "000100642112a4421b8e8cf5a0cf253d47052ada" +
  "00240004ffffff7e" +
  "802900080000000000000000" +
  "8022000d7874732d6963652d312e302e30000000" +
  "000600083262373363306535" +
  "0006001132623733633065353a3038333635353239000000" +
  "000800143357d7e2ba9755d1d89692b986494dbacc2cf4fb",
  "hex",
);

describe("Meari ICE/STUN codec", () => {
  test("parses the camera's captured connectivity check including duplicate usernames", () => {
    const parsed = decodeStunMessage(capturedCameraCheck);
    expect(parsed).toMatchObject({
      type: STUN_BINDING_REQUEST,
      messageLength: 100,
      transactionId: Buffer.from("1b8e8cf5a0cf253d47052ada", "hex"),
    });
    expect(parsed.attributes.filter((attribute) => attribute.type === STUN_ATTRIBUTES.USERNAME)
      .map((attribute) => attribute.value.toString("utf8"))).toEqual([
      "2b73c0e5",
      "2b73c0e5:08365529",
    ]);
    expect(parsed.attributes.find((attribute) => attribute.type === STUN_ATTRIBUTES.PRIORITY)?.value.readUInt32BE()).toBe(0xffff_ff7e);
    expect(encodeIceBindingSuccess(parsed.transactionId).toString("hex")).toBe(
      "010100002112a4421b8e8cf5a0cf253d47052ada",
    );
  });

  test("builds and validates the official app's authenticated binding request", () => {
    const request = encodeIceBindingRequest({
      localUsernameFragment: "08365529",
      remoteUsernameFragment: "2b73c0e5",
      remotePassword: "0123456789abcdef01234567",
      transactionId: Buffer.from("000102030405060708090a0b", "hex"),
      tieBreaker: 0x0102_0304_0506_0708n,
    });
    const parsed = decodeStunMessage(request);
    expect(parsed.type).toBe(STUN_BINDING_REQUEST);
    expect(parsed.attributes.map((attribute) => attribute.type)).toEqual([
      STUN_ATTRIBUTES.USERNAME,
      STUN_ATTRIBUTES.PRIORITY,
      STUN_ATTRIBUTES.ICE_CONTROLLING,
      STUN_ATTRIBUTES.USE_CANDIDATE,
      STUN_ATTRIBUTES.MESSAGE_INTEGRITY,
    ]);
    expect(verifyStunMessageIntegrity(parsed, "0123456789abcdef01234567")).toBe(true);
    expect(verifyStunMessageIntegrity(parsed, "wrong-password")).toBe(false);
  });

  test("recognizes a bare binding success", () => {
    const response = decodeStunMessage(encodeIceBindingSuccess(Buffer.alloc(12, 7)));
    expect(response).toMatchObject({ type: STUN_BINDING_SUCCESS, messageLength: 0 });
  });
});
