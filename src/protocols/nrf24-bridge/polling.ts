import type { Nrf24RadioBridge } from "./client";

/** Owns one non-overlapping collector loop, independent of browser tabs.
 * Does not start RF capture, restart firmware, or transmit anything.
 */
export function startNrf24CapturePolling(bridges: () => readonly Nrf24RadioBridge[], options: {
  activeMs?: number; idleMs?: number; onError?: (error: unknown) => void;
} = {}) {
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void>;
  const lastHealth = new WeakMap<Nrf24RadioBridge, number>();
  const tick = async () => {
    let active = false;
    for (const bridge of bridges()) {
      if (closed) break;
      try {
        // Drain observations before spending time on optional diagnostics.
        const state = await bridge.listener();
        active ||= state.listening;
        if (!closed && Date.now() - (lastHealth.get(bridge) ?? 0) > 60000) {
          lastHealth.set(bridge, Date.now());
          await bridge.health();
        }
      } catch (error) { options.onError?.(error); }
    }
    if (!closed) {
      timer = setTimeout(() => { running = tick(); }, active ? options.activeMs ?? 1000 : options.idleMs ?? 5000);
      timer.unref();
    }
  };
  running = tick();
  return { async stop() { closed = true; clearTimeout(timer); await running; } };
}
