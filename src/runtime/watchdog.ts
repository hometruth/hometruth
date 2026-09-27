/** Startup has its own deadline; heartbeat monitoring begins once the worker is ready. */
export function heartbeatOverdue(worker: { port: number; heartbeat: number; retiring: boolean }, now: number, timeout: number): boolean {
  return !worker.retiring && worker.port > 0 && now - worker.heartbeat > timeout;
}
