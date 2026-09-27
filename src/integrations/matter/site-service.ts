import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EventLog, type EventFilter, type ServiceEventListener } from "../../models/event-log";
import { Service, type ServiceStatus } from "../../models/service";

declare module "../../models/device" { interface SiteServices { matterBridge?: MatterBridgeService } }

interface Options {
  /** The actual public HTTP port, including PORT=0. */
  port: number;
  env?: NodeJS.ProcessEnv;
  spawn?: typeof spawn;
  retryMs?: number;
  shutdownMs?: number;
}

/** Node owns the Matter SDK; the live HomeTruth application owns this child. */
export class MatterBridgeService extends Service {
  private readonly log = new EventLog(200);
  private state: ServiceStatus = { availability: "unknown", detail: "Starting Apple Home bridge" };
  private child: ReturnType<typeof spawn> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private failures = 0;
  private closing?: Promise<void>;

  constructor(private readonly options: Options) { super("matter-bridge", "Apple Home bridge"); }

  override status(): ServiceStatus { return this.state; }
  override events(limit?: number, filter?: EventFilter) { return this.log.recent(limit, filter); }
  override subscribe(listener: ServiceEventListener, filter?: EventFilter) { return this.log.subscribe(listener, filter); }

  private update(availability: ServiceStatus["availability"], detail: string): void {
    if (this.state.availability === availability && this.state.detail === detail) return;
    this.state = { availability, detail };
    this.log.record("matter_bridge", detail, { level: availability === "offline" || availability === "degraded" ? "warn" : "info" });
  }

  start(): void {
    if (this.stopped || this.child || this.retry) return;
    const env = this.options.env ?? process.env;
    if (env.HOMETRUTH_MATTER_ENABLED === "0") {
      this.update("offline", "Disabled by HOMETRUTH_MATTER_ENABLED=0");
      return;
    }
    this.update("unknown", "Starting Apple Home bridge");
    try {
      const child = (this.options.spawn ?? spawn)(env.HOMETRUTH_NODE_BINARY || "node", [
        "--experimental-strip-types", fileURLToPath(new URL("./main.ts", import.meta.url)),
      ], {
        // Inherit the worker's process group, so its supervisor also reaps this child.
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        serialization: "json",
        env: {
          ...env,
          HOMETRUTH_URL: `http://127.0.0.1:${this.options.port}`,
          HOMETRUTH_MATTER_STORAGE: resolve(env.HOMETRUTH_MATTER_STORAGE || ".hometruth/matter"),
        },
      });
      this.child = child;
      let failureDetail: string | undefined;
      const armWatchdog = () => {
        clearTimeout(this.watchdog);
        this.watchdog = setTimeout(() => {
          if (this.child !== child || this.stopped) return;
          this.update("offline", "Apple Home bridge stopped reporting status; restarting it");
          child.kill("SIGKILL");
        }, 90_000).unref();
      };
      armWatchdog();
      child.on("message", message => {
        if (this.child !== child || this.stopped || !message || typeof message !== "object") return;
        if ("type" in message && message.type === "matter-error" && "detail" in message && typeof message.detail === "string") {
          failureDetail = message.detail;
          this.update("degraded", message.detail);
        }
        if (!("type" in message) || message.type !== "matter-status" || !("running" in message) || message.running !== true
          || !("commissioned" in message) || typeof message.commissioned !== "boolean"
          || !("switches" in message) || !Array.isArray(message.switches)) return;
        armWatchdog();
        this.failures = 0;
        failureDetail = undefined;
        const reachable = message.switches.filter(item => item && item.reachable === true).length;
        this.update(reachable === message.switches.length ? "online" : "degraded",
          `${message.commissioned ? "Paired with Apple Home" : "Ready to pair"}; ${reachable}/${message.switches.length} switches reachable`);
      });
      const ended = (detail: string) => {
        if (this.child !== child) return;
        this.child = undefined;
        clearTimeout(this.watchdog);
        if (this.stopped) return;
        this.update("offline", failureDetail ?? detail);
        this.schedule();
      };
      child.once("error", error => ended(`Apple Home bridge could not start: ${error.message}`));
      child.once("exit", (code, signal) => ended(`Apple Home bridge exited (${signal ?? code}); retrying`));
    } catch (error) {
      this.update("offline", `Apple Home bridge could not start: ${error instanceof Error ? error.message : String(error)}`);
      this.schedule();
    }
  }

  private schedule(): void {
    const delay = this.options.retryMs ?? Math.min(30_000, 1_000 * 2 ** Math.min(this.failures++, 5));
    this.retry = setTimeout(() => { this.retry = undefined; this.start(); }, delay).unref();
  }

  override stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retry);
    clearTimeout(this.watchdog);
    this.update("offline", "Apple Home bridge stopped");
    return this.closing ??= new Promise(resolve => {
      const child = this.child;
      if (!child) { resolve(); return; }
      const deadline = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, this.options.shutdownMs ?? 400);
      child.once("exit", () => { clearTimeout(deadline); resolve(); });
      child.kill("SIGTERM");
    });
  }
}
