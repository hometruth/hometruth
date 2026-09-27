import { execFile, spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { parseMatterSnapshot, type MatterSnapshot } from "./snapshot";

const WORKER_PATH = fileURLToPath(new URL("./worker.ts", import.meta.url));
const STORAGE_ROOT = resolve(".hometruth/aqara/matter-controller");

export async function readMatter(peerId: string): Promise<MatterSnapshot> {
  if (!/^peer[1-9][0-9]*$/.test(peerId)) throw new Error("Invalid Matter peer id");
  const value = await new Promise<unknown>((accept, reject) => {
    const child = execFile(process.env.HOMETRUTH_NODE_BINARY ?? "node", [WORKER_PATH], {
      timeout: 8000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
      env: { ...process.env, DEBUG: "" },
    }, (error, stdout) => {
      if (error) return reject(new Error("Matter connection unavailable"));
      try { accept(JSON.parse(stdout.trim().split("\n").pop() ?? "")); } catch { reject(new Error("Invalid Matter response")); }
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify({ peerId, storagePath: STORAGE_ROOT }));
  });
  return parseMatterSnapshot(value);
}

export interface MatterSubscription {
  /** Stop the subscription: no further reports arrive, and the worker is not restarted. */
  stop(): void;
}

const RESTART_MIN_MS = 2_000;
const RESTART_MAX_MS = 60_000;
/**
 * Backstop for a worker stuck somewhere its own internal timeout does not
 * cover. Longer than the worker's own 15 s connect deadline
 * (`src/protocols/matter/worker.ts`'s `CONNECT_TIMEOUT_MS`) so that deadline
 * wins first in the normal case; this only fires when the worker's own
 * bound somehow didn't.
 */
const WATCHDOG_MS = 25_000;

/**
 * A live Matter subscription to a peer's attributes: spawns a persistent worker
 * (`worker.ts` in `subscribe` mode) that stays connected and streams one JSON
 * `MatterSnapshot` line per attribute-change report. The worker restarts with
 * backoff if it exits unexpectedly (a dropped connection, a hub reboot); `stop()`
 * ends the subscription for good.
 */
export function subscribeMatter(peerId: string, onReport: (snapshot: MatterSnapshot) => void, options: { spawnWorker?: typeof spawn; onError?: (detail: string) => void; watchdogMs?: number } = {}): MatterSubscription {
  if (!/^peer[1-9][0-9]*$/.test(peerId)) throw new Error("Invalid Matter peer id");
  const spawnFn = options.spawnWorker ?? spawn;
  const watchdogMs = options.watchdogMs ?? WATCHDOG_MS;
  let stopped = false;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let restartDelay = RESTART_MIN_MS;
  let current: ReturnType<typeof spawn> | undefined;

  function start(): void {
    if (stopped) return;
    const child = spawnFn(process.env.HOMETRUTH_NODE_BINARY ?? "node", [WORKER_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, DEBUG: "" },
    });
    current = child;
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify({ peerId, storagePath: STORAGE_ROOT, subscribe: true }));
    // Backstop: nothing has arrived at all (no report, no {error} line) within the watchdog
    // window, so whatever this worker is stuck inside, it never got the chance to bound itself.
    const watchdog: ReturnType<typeof setTimeout> = setTimeout(() => {
      console.error(JSON.stringify({ event: "matter_worker_watchdog_kill", peerId, watchdogMs }));
      options.onError?.("Matter worker did not respond in time; it was killed and will be retried");
      child.kill("SIGKILL");
    }, watchdogMs);
    child.stderr?.on("data", chunk => {
      const text = String(chunk).trim();
      if (text) console.error(JSON.stringify({ event: "matter_worker_stderr", peerId, detail: text }));
    });
    if (child.stdout) {
      const lines = createInterface({ input: child.stdout });
      lines.on("line", line => {
        if (!line.trim()) return;
        let value: unknown;
        try { value = JSON.parse(line); } catch { return; }
        clearTimeout(watchdog);
        if (value && typeof value === "object" && "error" in value) {
          const detail = String((value as { error: unknown }).error);
          console.error(JSON.stringify({ event: "matter_worker_error", peerId, detail }));
          options.onError?.(detail);
          return;
        }
        try { onReport(parseMatterSnapshot(value)); restartDelay = RESTART_MIN_MS; } catch { /* malformed report, wait for the next one */ }
      });
    }
    child.on("exit", (code, signal) => {
      clearTimeout(watchdog);
      current = undefined;
      if (stopped) return;
      console.error(JSON.stringify({ event: "matter_worker_exited", peerId, code, signal, retryingInMs: restartDelay }));
      restartTimer = setTimeout(() => { restartDelay = Math.min(restartDelay * 2, RESTART_MAX_MS); start(); }, restartDelay);
    });
  }
  start();

  return {
    stop(): void {
      stopped = true;
      if (restartTimer) clearTimeout(restartTimer);
      current?.stdin?.end();
      current?.kill();
    },
  };
}
