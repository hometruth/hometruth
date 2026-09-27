import { beforeEach, describe, expect, test } from "bun:test";
import { clearSayClips, registerSayClip, sayClip, type SaySynthesizer } from "./say";

beforeEach(() => clearSayClips());

function countingSynthesizer(): { synthesize: SaySynthesizer; calls: string[] } {
  const calls: string[] = [];
  const synthesize: SaySynthesizer = async (text) => {
    calls.push(text);
    return new TextEncoder().encode(`clip:${text}`);
  };
  return { synthesize, calls };
}

/** A minimal valid mono 16-bit PCM WAV at 22050 Hz, `sampleCount` samples of silence. */
function fakeWav(sampleCount: number, sampleRate = 22050): Uint8Array {
  const dataBytes = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  return new Uint8Array(buffer);
}

describe("registerSayClip / sayClip", () => {
  test("registers a clip whose bytes come from the synthesizer", async () => {
    const { synthesize } = countingSynthesizer();
    const { path } = await registerSayClip("hello there", synthesize);

    expect(path).toMatch(/^\/local-media\/say\/[0-9a-f-]{36}\.wav$/u);
    const id = path.split("/").at(-1)?.replace(/\.wav$/u, "");
    expect(new TextDecoder().decode(sayClip(id!))).toBe("clip:hello there");
  });

  test("an unknown clip id returns undefined", () => {
    expect(sayClip("00000000-0000-0000-0000-000000000000")).toBeUndefined();
  });

  test("saying the same text again reuses the clip instead of re-synthesizing", async () => {
    const { synthesize, calls } = countingSynthesizer();

    const first = await registerSayClip("good morning", synthesize);
    const second = await registerSayClip("good morning", synthesize);

    expect(second).toEqual(first);
    expect(calls).toEqual(["good morning"]);
  });

  test("different text synthesizes a distinct clip", async () => {
    const { synthesize, calls } = countingSynthesizer();

    const first = await registerSayClip("good morning", synthesize);
    const second = await registerSayClip("good night", synthesize);

    expect(second.path).not.toBe(first.path);
    expect(calls).toEqual(["good morning", "good night"]);
  });

  test("computes duration from the WAV's own headers, not text length", async () => {
    // 3 seconds of audio, well above the padding floor, so the reported
    // duration reflects the real clip rather than the minimum-length pad.
    const threeSeconds: SaySynthesizer = async () => fakeWav(22050 * 3);

    const clip = await registerSayClip("a longer sentence with many words", threeSeconds);

    expect(clip.durationSeconds).toBeCloseTo(3, 2);
  });

  test("pads a clip shorter than the minimum with trailing silence, since Sonos silently refuses to play very short clips", async () => {
    // ~0.25s of audio — well under the ~1s threshold observed on real
    // Sonos hardware (a clip under roughly 1.1s never leaves STOPPED).
    const quarterSecond: SaySynthesizer = async () => fakeWav(Math.round(22050 * 0.25));

    const clip = await registerSayClip("hi", quarterSecond);
    const id = clip.path.split("/").at(-1)?.replace(/\.wav$/u, "");
    const bytes = sayClip(id!);

    expect(clip.durationSeconds).toBeGreaterThanOrEqual(1.5);
    expect(bytes).toBeDefined();
    // The padded file must still be a well-formed WAV whose RIFF size and
    // data-chunk size agree with its actual byte length.
    const view = new DataView(bytes!.buffer, bytes!.byteOffset, bytes!.byteLength);
    expect(view.getUint32(4, true)).toBe(bytes!.length - 8);
    expect(view.getUint32(40, true)).toBe(bytes!.length - 44);
  });

  test("leaves a clip at or above the minimum duration untouched", async () => {
    const twoSeconds: SaySynthesizer = async () => fakeWav(22050 * 2);

    const clip = await registerSayClip("a clip that is already long enough", twoSeconds);

    expect(clip.durationSeconds).toBeCloseTo(2, 2);
  });
});
