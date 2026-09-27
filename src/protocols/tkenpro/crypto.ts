import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
} from "node:crypto";

const DES_KEY = Buffer.from("123456781234567812345678", "utf8");
const DES_IV = Buffer.from("01234567", "utf8");

export function hmacSha1Base64(message: string, key: string): string {
  return createHmac("sha1", key).update(message, "utf8").digest("base64");
}

export function md5Hex(message: string): string {
  return createHash("md5").update(message, "utf8").digest("hex");
}

/**
 * The mobile SDK calls this DES, but ships the 24-byte key to a 3DES-CBC
 * implementation. Its repeated 8-byte component makes the result compatible
 * with the older single-DES implementation too.
 */
export function encryptPassword(password: string): string {
  const cipher = createCipheriv("des-ede3-cbc", DES_KEY, DES_IV);
  return Buffer.concat([cipher.update(password, "utf8"), cipher.final()]).toString(
    "base64",
  );
}

export function aesEncrypt(plaintext: string, keyText: string): string {
  const key = Buffer.from(keyText, "utf8");
  if (key.byteLength !== 16) throw new RangeError("AES key must be 16 bytes");
  const cipher = createCipheriv("aes-128-cbc", key, key);
  return Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]).toString(
    "base64",
  );
}

export function aesDecrypt(ciphertext: string, keyText: string): string {
  const key = Buffer.from(keyText, "utf8");
  if (key.byteLength !== 16) throw new RangeError("AES key must be 16 bytes");
  const decipher = createDecipheriv("aes-128-cbc", key, key);
  return Buffer.concat([
    decipher.update(Buffer.from(padBase64(ciphertext), "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export function encodeUserAccount(
  account: string,
  apiPath: string,
  timestampMs: number,
  partnerId: string,
  ttid: string,
): string {
  const raw = `${apiPath}${partnerId}${ttid}${timestampMs}`;
  const key = Buffer.from(raw, "utf8").toString("base64").slice(0, 16);
  return aesEncrypt(account, key);
}

export function padBase64(value: string): string {
  const remainder = value.length % 4;
  return remainder === 0 ? value : value + "=".repeat(4 - remainder);
}
