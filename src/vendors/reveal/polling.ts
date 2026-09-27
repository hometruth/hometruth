/** Runs independently of HTTP viewers; resolves devices again after inventory reloads. */
export function startRevealPhotoPolling(devices: () => readonly { syncPhotos(signal?: AbortSignal): Promise<void> }[], tickMs = 10_000) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void>;
  const tick = async () => {
    for (const device of devices()) {
      if (controller.signal.aborted) break;
      // The archive records recoverable sync errors; startup/storage errors must
      // not take down other devices or expose credentials in a process log.
      await device.syncPhotos(controller.signal).catch(() => {});
    }
    if (!controller.signal.aborted) {
      timer = setTimeout(() => { running = tick(); }, tickMs);
      timer.unref();
    }
  };
  running = tick();
  return { async stop() { controller.abort(); clearTimeout(timer); await running; } };
}
