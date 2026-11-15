/** Revalidate long-lived responses without buffering or retaining revoked subscriptions. */
export function protectStream(response: Response, authorized: () => boolean, intervalMs = 1000): Response {
  if (!response.body || !/^(text\/event-stream|multipart\/|audio\/|video\/|application\/octet-stream)/i.test(response.headers.get("content-type") ?? "")) return response;
  const reader = response.body.getReader();
  let done = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let close: () => void;
  const stop = () => {
    if (done) return;
    done = true;
    clearInterval(timer);
    void reader.cancel().catch(() => {});
    close();
  };
  const allowed = () => {
    try { return authorized(); } catch { return false; }
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      close = () => { try { controller.close(); } catch { /* Already cancelled. */ } };
      timer = setInterval(() => { if (!allowed()) stop(); }, intervalMs);
      timer.unref?.();
    },
    async pull(controller) {
      if (done) return;
      if (!allowed()) { stop(); return; }
      try {
        const chunk = await reader.read();
        if (done) return;
        if (chunk.done || !allowed()) { stop(); return; }
        controller.enqueue(chunk.value);
      } catch (error) {
        if (done) return;
        done = true;
        clearInterval(timer);
        controller.error(error);
        void reader.cancel().catch(() => {});
      }
    },
    cancel() { stop(); },
  }, { highWaterMark: 0 });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
