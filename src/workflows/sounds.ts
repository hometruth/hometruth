/** Built-in synthesized PCM bell; no installation data or external media service. */
export const DINNER_BELL = { id: "dinnerBell", path: "/local-media/sounds/dinner-bell.wav", durationMs: 3000 } as const;
let cached: Uint8Array | undefined;
export function dinnerBellWav(): Uint8Array {
  if (cached) return cached;
  const rate = 24000; const samples = rate * DINNER_BELL.durationMs / 1000;
  const bytes = new Uint8Array(44 + samples * 2); const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => [...value].forEach((c, i) => { bytes[offset + i] = c.charCodeAt(0); });
  text(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); text(8, "WAVEfmt "); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) {
    const t = i / rate; let value = 0;
    for (const onset of [0, .85]) if (t >= onset) { const dt = t - onset; value += Math.min(1, dt * 300) * Math.exp(-dt * 3) * (Math.sin(2 * Math.PI * 784 * dt) + .45 * Math.sin(2 * Math.PI * 1176 * dt)); }
    view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, value * .45)) * 32767), true);
  }
  return cached = bytes;
}
