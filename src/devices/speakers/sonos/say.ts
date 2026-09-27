/**
 * Clips registered for a speaker's `say()` control: a short-lived, in-memory
 * store keyed by id so a speaker can fetch its own clip back over HTTP
 * (`say.ts` generates the bytes and a path; `src/vendors/sonos/routes.ts`
 * serves them). Speech is synthesized with macOS's built-in `say` command
 * (no API key, no cloud dependency) — this only works on a Mac; a HomeTruth
 * server running elsewhere needs a different `synthesizeSayClip`.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class SayError extends Error {
  constructor(message: string, readonly code: "unsupported" | "synthesis_failed") {
    super(message);
    this.name = "SayError";
  }
}

/** Turns text into WAV bytes. Narrow enough to fake in tests without spawning a real TTS process. */
export type SaySynthesizer = (text: string) => Promise<Uint8Array>;

interface SayClip {
  readonly bytes: Uint8Array;
  readonly createdAt: number;
  readonly textHash: string;
  readonly durationSeconds: number;
}

export interface RegisteredSayClip {
  readonly path: string;
  /** From the WAV's own `data` chunk size and `fmt` sample rate — Sonos needs this in the DIDL-Lite `<res>` metadata for very short clips, or it can silently fail to determine a playable duration and never start. */
  readonly durationSeconds: number;
}

/** Reads sample rate/channels/bits and the `data` chunk size straight from a PCM WAV's headers to compute its duration. */
function wavDurationSeconds(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 44 || view.getUint32(0, false) !== 0x52494646 /* "RIFF" */ || view.getUint32(8, false) !== 0x57415645 /* "WAVE" */) {
    return 0;
  }
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let dataBytes = 0;
  while (offset + 8 <= bytes.length) {
    const chunkId = view.getUint32(offset, false);
    const chunkSize = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (chunkId === 0x666d7420 /* "fmt " */ && body + 16 <= bytes.length) {
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (chunkId === 0x64617461 /* "data" */) {
      dataBytes = Math.min(chunkSize, bytes.length - body);
    }
    offset = body + chunkSize + (chunkSize % 2);
  }
  const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
  return bytesPerSecond > 0 ? dataBytes / bytesPerSecond : 0;
}

/**
 * Sonos silently refuses to play a clip shorter than roughly one second —
 * observed directly: a ~1.08s clip never starts (`GetTransportInfo` never
 * leaves STOPPED), a ~1.12s clip plays immediately, regardless of correct
 * DIDL-Lite `<res duration>` metadata and a correct Content-Length. Padding
 * a short WAV with trailing silence keeps the spoken audio intact while
 * clearing that threshold with margin. Only WAV's own `data` chunk grows;
 * every other chunk (and the RIFF size field) is left in place.
 */
const MINIMUM_CLIP_SECONDS = 1.5;

function padWavWithSilence(bytes: Uint8Array, minimumSeconds: number): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 44 || view.getUint32(0, false) !== 0x52494646 || view.getUint32(8, false) !== 0x57415645) {
    return bytes;
  }
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataSize = 0;
  while (offset + 8 <= bytes.length) {
    const chunkId = view.getUint32(offset, false);
    const chunkSize = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (chunkId === 0x666d7420 && body + 16 <= bytes.length) {
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (chunkId === 0x64617461) {
      dataOffset = body;
      dataSize = Math.min(chunkSize, bytes.length - body);
    }
    offset = body + chunkSize + (chunkSize % 2);
  }
  const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
  if (dataOffset < 0 || bytesPerSecond <= 0 || dataSize / bytesPerSecond >= minimumSeconds) return bytes;

  const targetDataSize = Math.ceil(minimumSeconds * bytesPerSecond);
  const padded = new Uint8Array(bytes.length + (targetDataSize - dataSize));
  padded.set(bytes.subarray(0, dataOffset + dataSize));
  padded.fill(0, dataOffset + dataSize, dataOffset + targetDataSize);
  padded.set(bytes.subarray(dataOffset + dataSize), dataOffset + targetDataSize);

  const paddedView = new DataView(padded.buffer);
  paddedView.setUint32(4, padded.length - 8, true);
  paddedView.setUint32(dataOffset - 4, targetDataSize, true);
  return padded;
}

const CLIP_TTL_MS = 5 * 60_000;
const clips = new Map<string, SayClip>();
/** Same text said again reuses its clip instead of re-synthesizing (macOS `say` takes real wall-clock time per call). */
const clipIdByTextHash = new Map<string, string>();

function evictExpired(now: number): void {
  const cutoff = now - CLIP_TTL_MS;
  for (const [id, clip] of clips) {
    if (clip.createdAt < cutoff) {
      clips.delete(id);
      if (clipIdByTextHash.get(clip.textHash) === id) clipIdByTextHash.delete(clip.textHash);
    }
  }
}

async function hashText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Buffer.from(digest).toString("hex");
}

/** Synthesize `text` as a mono 16-bit WAV via macOS's `say` command. */
export const synthesizeSayClipWithMacSay: SaySynthesizer = async (text) => {
  if (process.platform !== "darwin") {
    throw new SayError("say() needs macOS's `say` command; this server is not running on macOS", "unsupported");
  }
  const directory = await mkdtemp(join(tmpdir(), "hometruth-say-"));
  const path = join(directory, "clip.wav");
  try {
    const proc = Bun.spawn(["say", "-o", path, "--data-format=LEI16@22050", "--channels=1", "--file-format=WAVE", text], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new SayError(`macOS say exited with code ${exitCode}: ${stderr.trim()}`, "synthesis_failed");
    }
    return new Uint8Array(await readFile(path));
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
};

/** Generate and register a clip for `text`, returning the path it is served at and its duration. Repeating the same text reuses its clip rather than re-synthesizing. */
export async function registerSayClip(text: string, synthesize: SaySynthesizer = synthesizeSayClipWithMacSay): Promise<RegisteredSayClip> {
  const now = Date.now();
  evictExpired(now);
  const textHash = await hashText(text);
  const existingId = clipIdByTextHash.get(textHash);
  const existing = existingId ? clips.get(existingId) : undefined;
  if (existingId && existing) return { path: `/local-media/say/${existingId}.wav`, durationSeconds: existing.durationSeconds };

  const id = crypto.randomUUID();
  const synthesized = await synthesize(text);
  const bytes = padWavWithSilence(synthesized, MINIMUM_CLIP_SECONDS);
  const durationSeconds = wavDurationSeconds(bytes);
  clips.set(id, { bytes, createdAt: now, textHash, durationSeconds });
  clipIdByTextHash.set(textHash, id);
  return { path: `/local-media/say/${id}.wav`, durationSeconds };
}

/** The bytes for a registered, unexpired clip id; `undefined` when unknown or expired. */
export function sayClip(id: string): Uint8Array | undefined {
  evictExpired(Date.now());
  return clips.get(id)?.bytes;
}

/** Test-only: drop every cached clip so tests don't see clips registered by other tests/files. */
export function clearSayClips(): void {
  clips.clear();
  clipIdByTextHash.clear();
}
