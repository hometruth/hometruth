/** Classic AWS IoT shadows, inferred from the community Zephyr app client.
 * No device-side plaintext has been captured yet. Pure, transport-free logic.
 */
import { isDeepStrictEqual } from "node:util";

export type Json = null | boolean | number | string | Json[] | ObjectValue;
export interface ObjectValue { [key: string]: Json }
export interface ShadowDocument {
  state: ObjectValue;
  metadata: ObjectValue;
  version: number;
}
export interface ShadowRecord {
  document: ShadowDocument | null;
  version: number;
  deletedAt: number | null;
}
export interface ShadowMessage { topic: string; body: ObjectValue }
export interface ShadowResult {
  record: ShadowRecord;
  messages: ShadowMessage[];
  accepted: boolean;
}
export const emptyShadow = (): ShadowRecord => ({ document: null, version: 0, deletedAt: null });
export const isObject = (value: unknown): value is ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const forbidden = new Set(["__proto__", "constructor", "prototype"]);

export class ShadowError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

export function parseTopic(topic: string): { thing: string; suffix: string; prefix: string } | undefined {
  const match = /^\$aws\/things\/([A-Za-z0-9:_-]{1,128})\/shadow\/(.+)$/.exec(topic);
  return match ? { thing: match[1]!, suffix: match[2]!, prefix: `$aws/things/${match[1]}/shadow` } : undefined;
}

function inspect(value: Json, depth = 0): void {
  if (depth > 6) throw new ShadowError(400, "JSON contains too many levels of nesting; maximum is 6");
  if (typeof value === "number" && !Number.isFinite(value)) throw new ShadowError(400, "Invalid JSON number");
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (entry === null) throw new ShadowError(400, "Arrays cannot contain null");
      inspect(entry, depth + 1);
    }
  } else if (isObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (forbidden.has(key)) throw new ShadowError(400, "Unsafe object property");
      inspect(entry, depth + 1);
    }
  }
}

/** RFC-style recursive merge: null removes, arrays replace atomically. */
export function merge(target: ObjectValue, patch: ObjectValue): ObjectValue {
  const result = structuredClone(target);
  for (const [key, value] of Object.entries(patch)) {
    if (forbidden.has(key)) throw new ShadowError(400, "Unsafe object property");
    if (value === null) delete result[key];
    else result[key] = isObject(value) ? merge(isObject(result[key]) ? result[key] : {}, value) : structuredClone(value);
  }
  return result;
}

function stamped(value: Json, timestamp: number): Json {
  if (!isObject(value)) return value === null ? null : { timestamp };
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, stamped(item, timestamp)]));
}

function mergeMetadata(state: ObjectValue, metadata: ObjectValue, patch: ObjectValue, timestamp: number): ObjectValue {
  const result = structuredClone(metadata);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else if (isObject(value)) result[key] = mergeMetadata(isObject(state[key]) ? state[key] : {},
      isObject(state[key]) && isObject(metadata[key]) ? metadata[key] : {}, value, timestamp);
    else result[key] = { timestamp };
  }
  return result;
}

export function delta(desired: ObjectValue, reported: ObjectValue): ObjectValue {
  const result: ObjectValue = {};
  for (const [key, value] of Object.entries(desired)) {
    if (isDeepStrictEqual(value, reported[key])) continue;
    if (isObject(value) && isObject(reported[key])) {
      const nested = delta(value, reported[key]);
      if (Object.keys(nested).length) result[key] = nested;
    } else result[key] = structuredClone(value);
  }
  return result;
}

function pickMetadata(fields: ObjectValue, metadata: ObjectValue): ObjectValue {
  return Object.fromEntries(Object.entries(fields).flatMap(([key, value]) => {
    const stamp = metadata[key];
    if (stamp === undefined) return [];
    return [[key, isObject(value) && isObject(stamp) ? pickMetadata(value, stamp) : structuredClone(stamp)]];
  }));
}

function withDelta(document: ShadowDocument): ObjectValue {
  const copy = structuredClone(document);
  const difference = delta(isObject(copy.state.desired) ? copy.state.desired : {}, isObject(copy.state.reported) ? copy.state.reported : {});
  if (Object.keys(difference).length) {
    copy.state.delta = difference;
    copy.metadata.delta = pickMetadata(difference, isObject(copy.metadata.desired) ? copy.metadata.desired : {});
  }
  return { state: copy.state, metadata: copy.metadata, version: copy.version };
}

/** The input record is never mutated, including on rejected requests. */
export function shadowRequest(record: ShadowRecord, topic: string, payload: Uint8Array, timestamp: number): ShadowResult {
  const parsed = parseTopic(topic);
  if (!parsed || !["get", "update", "delete"].includes(parsed.suffix)) throw new ShadowError(400, "Unsupported shadow request topic");
  const { prefix, suffix } = parsed;
  let token: string | undefined;
  const response = (kind: string, body: ObjectValue): ShadowMessage => ({ topic: `${prefix}/${kind}`, body: { ...body, timestamp, ...(token === undefined ? {} : { clientToken: token }) } });
  try {
    // Bound parsing separately from the AWS 8 KiB state limit.
    if (payload.byteLength > 16_384) throw new ShadowError(413, "The payload exceeds the maximum size allowed");
    let request: ObjectValue = {};
    if (suffix !== "delete" && payload.byteLength) {
      try {
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
        if (!isObject(value)) throw new Error();
        request = value;
      } catch { throw new ShadowError(400, "Invalid JSON"); }
      if (request.clientToken !== undefined) {
        if (typeof request.clientToken !== "string" || Buffer.byteLength(request.clientToken) > 64) throw new ShadowError(400, "Invalid clientToken");
        token = request.clientToken;
      }
    }
    if (suffix === "get") {
      if (!record.document) throw new ShadowError(404, "No shadow exists");
      return { record, accepted: true, messages: [response("get/accepted", withDelta(record.document))] };
    }
    if (suffix === "delete") {
      if (!record.document) throw new ShadowError(404, "No shadow exists");
      // AWS ignores the delete payload and retains the version for 48 hours.
      return { record: { document: null, version: record.version, deletedAt: timestamp }, accepted: true,
        messages: [response("delete/accepted", { version: record.version })] };
    }
    if (!isObject(request.state)) throw new ShadowError(400, "State node must be an object");
    for (const [key, value] of Object.entries(request.state)) {
      if (!["desired", "reported"].includes(key)) throw new ShadowError(400, "State contains an invalid node");
      if (value !== null && !isObject(value)) throw new ShadowError(400, `${key} node must be an object`);
      inspect(value);
    }
    const previousVersion = record.deletedAt !== null && timestamp - record.deletedAt >= 172_800 ? 0 : record.version;
    if (request.version !== undefined) {
      if (typeof request.version !== "number" || !Number.isSafeInteger(request.version) || request.version < 0) throw new ShadowError(400, "Invalid version");
      if (request.version !== previousVersion) throw new ShadowError(409, "Version conflict");
    }
    const state = merge(record.document?.state ?? {}, request.state);
    if (Buffer.byteLength(JSON.stringify(state)) > 8192) throw new ShadowError(413, "The payload exceeds the maximum size allowed");
    const patchMetadata = stamped(request.state, timestamp) as ObjectValue;
    const metadata = mergeMetadata(record.document?.state ?? {}, record.document?.metadata ?? {}, request.state, timestamp);
    const document: ShadowDocument = { state, metadata, version: previousVersion + 1 };
    const difference = delta(isObject(state.desired) ? state.desired : {}, isObject(state.reported) ? state.reported : {});
    const messages = [response("update/accepted", { state: structuredClone(request.state), metadata: patchMetadata, version: document.version })];
    if (Object.keys(difference).length) messages.push(response("update/delta", {
      state: difference, metadata: pickMetadata(difference, isObject(metadata.desired) ? metadata.desired : {}), version: document.version,
    }));
    const asJson = (doc: ShadowDocument): ObjectValue => ({ state: doc.state, metadata: doc.metadata, version: doc.version });
    messages.push(response("update/documents", { previous: record.document ? asJson(record.document) : null, current: asJson(document) }));
    return { record: { document, version: document.version, deletedAt: null }, messages, accepted: true };
  } catch (error) {
    if (!(error instanceof ShadowError)) throw error;
    return { record, accepted: false, messages: [response(`${suffix}/rejected`, { code: error.code, message: error.message })] };
  }
}
