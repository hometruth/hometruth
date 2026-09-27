import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const STUN_MAGIC_COOKIE = 0x2112_a442;
export const STUN_BINDING_REQUEST = 0x0001;
export const STUN_BINDING_SUCCESS = 0x0101;
export const STUN_HEADER_SIZE = 20;

export const STUN_ATTRIBUTES = Object.freeze({
  USERNAME: 0x0006,
  MESSAGE_INTEGRITY: 0x0008,
  XOR_MAPPED_ADDRESS: 0x0020,
  PRIORITY: 0x0024,
  USE_CANDIDATE: 0x0025,
  SOFTWARE: 0x8022,
  FINGERPRINT: 0x8028,
  ICE_CONTROLLED: 0x8029,
  ICE_CONTROLLING: 0x802a,
});

export interface StunAttributeInput {
  readonly type: number;
  readonly value?: Uint8Array;
}

export interface ParsedStunAttribute {
  readonly type: number;
  readonly length: number;
  readonly value: Buffer;
  /** Byte offset of this attribute's four-byte header in the STUN message. */
  readonly offset: number;
  readonly byteLength: number;
}

export interface ParsedStunMessage {
  readonly type: number;
  readonly messageLength: number;
  readonly transactionId: Buffer;
  readonly attributes: readonly ParsedStunAttribute[];
  readonly byteLength: number;
  readonly bytes: Buffer;
}

export interface IceBindingRequestOptions {
  readonly localUsernameFragment: string;
  readonly remoteUsernameFragment: string;
  readonly remotePassword: string;
  readonly priority?: number;
  readonly useCandidate?: boolean;
  readonly transactionId?: Uint8Array;
  readonly tieBreaker?: bigint;
}

function assertUint(name: string, value: number, maximum: number): void {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${name} must be between 0 and ${maximum}`);
  }
}

function bytes(value: Uint8Array): Buffer {
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function transactionId(value?: Uint8Array): Buffer {
  const id = value ? bytes(value) : randomBytes(12);
  if (id.byteLength !== 12) throw new TypeError("STUN transactionId must be 12 bytes");
  return Buffer.from(id);
}

export function encodeStunAttribute(input: StunAttributeInput): Buffer {
  assertUint("STUN attribute type", input.type, 0xffff);
  const value = input.value ? bytes(input.value) : Buffer.alloc(0);
  assertUint("STUN attribute length", value.byteLength, 0xffff);
  const paddedLength = (value.byteLength + 3) & ~3;
  const attribute = Buffer.alloc(4 + paddedLength);
  attribute.writeUInt16BE(input.type, 0);
  attribute.writeUInt16BE(value.byteLength, 2);
  value.copy(attribute, 4);
  return attribute;
}

export function encodeStunMessage(
  type: number,
  attributes: readonly StunAttributeInput[],
  id?: Uint8Array,
): Buffer {
  assertUint("STUN message type", type, 0xffff);
  const encoded = Buffer.concat(attributes.map(encodeStunAttribute));
  assertUint("STUN message length", encoded.byteLength, 0xffff);
  const message = Buffer.allocUnsafe(STUN_HEADER_SIZE + encoded.byteLength);
  message.writeUInt16BE(type, 0);
  message.writeUInt16BE(encoded.byteLength, 2);
  message.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
  transactionId(id).copy(message, 8);
  encoded.copy(message, STUN_HEADER_SIZE);
  return message;
}

export function decodeStunMessage(input: Uint8Array): ParsedStunMessage {
  const message = bytes(input);
  if (message.byteLength < STUN_HEADER_SIZE) throw new Error("Truncated STUN header");
  if (((message[0] as number) & 0xc0) !== 0) throw new Error("Invalid STUN message type bits");
  if (message.readUInt32BE(4) !== STUN_MAGIC_COOKIE) throw new Error("Invalid STUN magic cookie");
  const messageLength = message.readUInt16BE(2);
  const byteLength = STUN_HEADER_SIZE + messageLength;
  if (message.byteLength !== byteLength) {
    throw new Error(`STUN message length mismatch: expected ${byteLength}, received ${message.byteLength}`);
  }
  const attributes: ParsedStunAttribute[] = [];
  let offset = STUN_HEADER_SIZE;
  while (offset < byteLength) {
    if (byteLength - offset < 4) throw new Error("Truncated STUN attribute header");
    const type = message.readUInt16BE(offset);
    const length = message.readUInt16BE(offset + 2);
    const paddedLength = (length + 3) & ~3;
    const attributeLength = 4 + paddedLength;
    if (attributeLength > byteLength - offset) throw new Error("Truncated STUN attribute value");
    attributes.push({
      type,
      length,
      value: Buffer.from(message.subarray(offset + 4, offset + 4 + length)),
      offset,
      byteLength: attributeLength,
    });
    offset += attributeLength;
  }
  return {
    type: message.readUInt16BE(0),
    messageLength,
    transactionId: Buffer.from(message.subarray(8, 20)),
    attributes,
    byteLength,
    bytes: Buffer.from(message),
  };
}

/** Verify RFC 5389 MESSAGE-INTEGRITY using the short-term ICE password. */
export function verifyStunMessageIntegrity(
  message: ParsedStunMessage | Uint8Array,
  password: string,
): boolean {
  const parsed = message instanceof Uint8Array ? decodeStunMessage(message) : message;
  const integrity = parsed.attributes.find(
    (attribute) => attribute.type === STUN_ATTRIBUTES.MESSAGE_INTEGRITY,
  );
  if (!integrity || integrity.value.byteLength !== 20) return false;
  const header = Buffer.from(parsed.bytes.subarray(0, STUN_HEADER_SIZE));
  header.writeUInt16BE(integrity.offset - STUN_HEADER_SIZE + 24, 2);
  const expected = createHmac("sha1", password)
    .update(header)
    .update(parsed.bytes.subarray(STUN_HEADER_SIZE, integrity.offset))
    .digest();
  return timingSafeEqual(expected, integrity.value);
}

/** Build the authenticated ICE connectivity check used by factory-10 cameras. */
export function encodeIceBindingRequest(options: IceBindingRequestOptions): Buffer {
  if (!options.localUsernameFragment || !options.remoteUsernameFragment) {
    throw new TypeError("Both ICE username fragments are required");
  }
  if (!options.remotePassword) throw new TypeError("ICE remotePassword is required");
  const id = transactionId(options.transactionId);
  const priority = options.priority ?? 1_862_270_975;
  assertUint("ICE priority", priority, 0xffff_ffff);
  const priorityBytes = Buffer.allocUnsafe(4);
  priorityBytes.writeUInt32BE(priority);
  const tieBreakerBytes = Buffer.allocUnsafe(8);
  tieBreakerBytes.writeBigUInt64BE(
    options.tieBreaker ?? randomBytes(8).readBigUInt64BE(),
  );
  const attributes: StunAttributeInput[] = [
    {
      type: STUN_ATTRIBUTES.USERNAME,
      value: Buffer.from(
        `${options.remoteUsernameFragment}:${options.localUsernameFragment}`,
        "utf8",
      ),
    },
    { type: STUN_ATTRIBUTES.PRIORITY, value: priorityBytes },
    { type: STUN_ATTRIBUTES.ICE_CONTROLLING, value: tieBreakerBytes },
  ];
  if (options.useCandidate ?? true) {
    attributes.push({ type: STUN_ATTRIBUTES.USE_CANDIDATE });
  }
  const beforeIntegrity = Buffer.concat(attributes.map(encodeStunAttribute));
  const integrityHeader = Buffer.allocUnsafe(STUN_HEADER_SIZE);
  integrityHeader.writeUInt16BE(STUN_BINDING_REQUEST, 0);
  integrityHeader.writeUInt16BE(beforeIntegrity.byteLength + 24, 2);
  integrityHeader.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
  id.copy(integrityHeader, 8);
  const integrity = createHmac("sha1", options.remotePassword)
    .update(integrityHeader)
    .update(beforeIntegrity)
    .digest();
  return encodeStunMessage(
    STUN_BINDING_REQUEST,
    [...attributes, { type: STUN_ATTRIBUTES.MESSAGE_INTEGRITY, value: integrity }],
    id,
  );
}

/** The native client answers camera checks with an intentionally bare success. */
export function encodeIceBindingSuccess(transaction: Uint8Array): Buffer {
  return encodeStunMessage(STUN_BINDING_SUCCESS, [], transaction);
}
