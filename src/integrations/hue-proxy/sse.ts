/** Incremental SSE decoder: handles split UTF-8, CRLF, comments and multi-line data. */
export async function readSse(body: ReadableStream<Uint8Array>, receive: (data: string, id?: string) => void, signal?: AbortSignal): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "", lines: string[] = [], eventId: string | undefined;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) return;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      if (pending.length > 2_000_000) throw new Error("Hue event stream line exceeds limit");
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/u, "");
        pending = pending.slice(newline + 1);
        if (!line) {
          if (lines.length) receive(lines.join("\n"), eventId);
          lines = [];
          continue;
        }
        if (line.startsWith("data:")) lines.push(line.slice(5).replace(/^ /u, ""));
        if (line.startsWith("id:") && !line.includes("\0")) eventId = line.slice(3).replace(/^ /u, "");
        if (lines.reduce((sum, value) => sum + value.length, 0) > 2_000_000) throw new Error("Hue event exceeds limit");
      }
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
