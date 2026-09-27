/** Generate the short local feeder sound used when emulating CloudEdge's default asset. */
export function localFeedSoundWav(): Uint8Array {
  const sampleRate = 8_000;
  const sampleCount = Math.floor(sampleRate * 0.6);
  const audio = Buffer.alloc(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    const envelope = Math.min(1, index / 240, (sampleCount - index) / 480);
    const sample = Math.round(Math.sin((Math.PI * 2 * 700 * index) / sampleRate) * 9_000 * envelope);
    audio[index] = pcm16ToMuLaw(sample);
  }
  // CloudEdge's built-in pet_msg0.wav is an 8 kHz mono G.711 μ-law WAVE
  // with a fact chunk. Some camera firmware rejects PCM WAV files here.
  const fmtSize = 18;
  const factSize = 12;
  const dataOffset = 12 + 8 + fmtSize + factSize + 8;
  const wav = Buffer.alloc(dataOffset + audio.length);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(fmtSize, 16);
  wav.writeUInt16LE(7, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.writeUInt16LE(0, 36);
  wav.write("fact", 38, "ascii");
  wav.writeUInt32LE(4, 42);
  wav.writeUInt32LE(sampleCount, 46);
  wav.write("data", 50, "ascii");
  wav.writeUInt32LE(audio.length, 54);
  audio.copy(wav, 58);
  return new Uint8Array(wav);
}

function pcm16ToMuLaw(sample: number): number {
  const magnitude = Math.abs(sample) + 0x84;
  const mask = sample < 0 ? 0x7f : 0xff;
  if (magnitude >= 0x8000) return mask & 0x80;

  let exponent = 0;
  let boundary = 0x100;
  while (magnitude >= boundary && exponent < 7) {
    exponent += 1;
    boundary <<= 1;
  }
  const mantissa = (magnitude >> (exponent + 3)) & 0x0f;
  return ((exponent << 4) | mantissa) ^ mask;
}
