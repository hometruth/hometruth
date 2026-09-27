/** An SSE body read incrementally; each call reads `count` more frames without releasing the underlying stream. */
export class SseFrameReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = "";

  constructor(response: Response) {
    if (!response.body) throw new Error("no body");
    this.reader = response.body.getReader();
  }

  async next(count: number, timeoutMs = 2_000): Promise<{ event: string; data: unknown }[]> {
    const frames: { event: string; data: unknown }[] = [];
    const deadline = Date.now() + timeoutMs;
    while (frames.length < count && Date.now() < deadline) {
      const { value, done } = await this.reader.read();
      if (done) break;
      this.buffer += this.decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = this.buffer.indexOf("\n\n")) !== -1) {
        const frame = this.buffer.slice(0, boundary);
        this.buffer = this.buffer.slice(boundary + 2);
        const eventLine = /^event: (.+)$/mu.exec(frame);
        const dataLine = /^data: (.+)$/mu.exec(frame);
        if (eventLine && dataLine) frames.push({ event: eventLine[1] ?? "", data: JSON.parse(dataLine[1] ?? "null") });
      }
    }
    return frames;
  }

  async close(): Promise<void> {
    await this.reader.cancel();
  }
}
