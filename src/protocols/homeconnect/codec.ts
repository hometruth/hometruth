import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const hmac = (key: Uint8Array, data: Uint8Array | string) => createHmac("sha256", key).update(data).digest();

/** Home Connect's AES WebSocket framing. Each connection has independent CBC/MAC chains.
 * Protocol references: osresearch/hcpy and chris-mc1/homeconnect_websocket (MIT).
 */
export class HomeConnectCodec {
  private readonly iv: Buffer;
  private readonly macKey: Buffer;
  private readonly encoder;
  private readonly decoder;
  private txMac: Buffer = Buffer.alloc(16);
  private rxMac: Buffer = Buffer.alloc(16);

  constructor(key: string, iv: string) {
    if (!/^[A-Za-z0-9_-]+={0,2}$/u.test(key) || !/^[A-Za-z0-9_-]+={0,2}$/u.test(iv)) throw new Error("Invalid Home Connect credentials");
    const psk = Buffer.from(key, "base64url");
    this.iv = Buffer.from(iv, "base64url");
    if (psk.length !== 32 || this.iv.length !== 16) throw new Error("Invalid Home Connect credential lengths");
    const encKey = hmac(psk, "ENC");
    this.macKey = hmac(psk, "MAC");
    this.encoder = createCipheriv("aes-256-cbc", encKey, this.iv).setAutoPadding(false);
    this.decoder = createDecipheriv("aes-256-cbc", encKey, this.iv).setAutoPadding(false);
  }

  encrypt(message: string): Buffer {
    const plain = Buffer.from(message);
    let length = 16 - plain.length % 16;
    if (length === 1) length += 16;
    const padding = Buffer.concat([Buffer.from([0]), randomBytes(length - 2), Buffer.from([length])]);
    const encrypted = this.encoder.update(Buffer.concat([plain, padding]));
    this.txMac = this.mac(0x45, this.txMac, encrypted);
    return Buffer.concat([encrypted, this.txMac]);
  }

  decrypt(frame: Uint8Array): string {
    const data = Buffer.from(frame);
    if (data.length < 32 || data.length % 16 !== 0 || data.length > 1_048_576) throw new Error("Invalid Home Connect frame length");
    const encrypted = data.subarray(0, -16);
    const tag = data.subarray(-16);
    if (!timingSafeEqual(tag, this.mac(0x43, this.rxMac, encrypted))) throw new Error("Home Connect message authentication failed");
    const plain = this.decoder.update(encrypted);
    const padding = plain.at(-1)!;
    if (padding < 2 || padding > 17 || padding > plain.length || plain[plain.length - padding] !== 0) throw new Error("Invalid Home Connect padding");
    this.rxMac = Buffer.from(tag);
    return plain.subarray(0, -padding).toString("utf8");
  }

  private mac(direction: number, previous: Buffer, encrypted: Buffer): Buffer {
    return hmac(this.macKey, Buffer.concat([this.iv, Buffer.from([direction]), previous, encrypted])).subarray(0, 16);
  }
}
