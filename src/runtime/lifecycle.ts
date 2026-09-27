/** Resource ownership starts at allocation, including partially failed startup. */
export class Lifecycle {
  private readonly cleanups: (() => unknown | Promise<unknown>)[] = [];
  private readonly waits = new Set<() => void>();

  constructor(private readonly cleanupTimeoutMs = 500) {}
  private closing: Promise<void> | undefined;
  private stopped = false;

  defer(cleanup: () => unknown | Promise<unknown>): void { this.cleanups.push(cleanup); }

  background(name: string, start: () => Promise<unknown>): void {
    void (async () => {
      let failures = 0;
      while (!this.stopped) {
        try { await start(); return; }
        catch (error) {
          console.error(JSON.stringify({ event: "service_start_failed", service: name, detail: String(error) }));
          // Unref so retries never keep a retiring process alive.
          await new Promise<void>(resolve => {
            const done = () => { clearTimeout(timer); this.waits.delete(done); resolve(); };
            const timer = setTimeout(done, Math.min(30_000, 500 * 2 ** Math.min(failures++, 6))).unref();
            this.waits.add(done);
            if (this.stopped) done();
          });
        }
      }
    })();
  }

  close(): Promise<void> {
    this.stopped = true;
    for (const done of this.waits) done();
    return this.closing ??= (async () => {
      // Reverse allocation order preserves dependencies (flush writers before
      // closing their database/broker). A hung resource must not skip the rest.
      for (const cleanup of this.cleanups.reverse()) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.resolve().then(cleanup),
            new Promise<void>(resolve => { timer = setTimeout(resolve, this.cleanupTimeoutMs); }),
          ]);
        } catch (error) {
          console.warn(JSON.stringify({ event: "cleanup_failed", detail: String(error) }));
        } finally { clearTimeout(timer); }
      }
    })();
  }
}
