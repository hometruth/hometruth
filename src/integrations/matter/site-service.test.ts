import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { resolve } from "node:path";
import { MatterBridgeService } from "./site-service";

class Child extends EventEmitter {
  readonly signals: string[] = [];
  graceful = true;
  kill(signal: string) {
    this.signals.push(signal);
    if (this.graceful || signal === "SIGKILL") this.emit("exit", 0, signal);
    return true;
  }
}
const services: MatterBridgeService[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.stop(); });

function fixture(env: NodeJS.ProcessEnv = {}) {
  const children: Child[] = [];
  const calls: { command: string; args: string[]; options: any }[] = [];
  const service = new MatterBridgeService({
    port: 43917, env, retryMs: 10, shutdownMs: 10,
    spawn: ((command: string, args: string[], options: any) => {
      calls.push({ command, args, options });
      const child = new Child(); children.push(child); return child;
    }) as unknown as typeof spawn,
  });
  services.push(service);
  return { service, children, calls };
}

test("starts one managed Node child against the actual HomeTruth port and existing pairing store", async () => {
  const { service, calls, children } = fixture({ HOMETRUTH_NODE_BINARY: "/node24", HOMETRUTH_URL: "http://wrong-host:3000", HOMETRUTH_TOKEN: "test-token" });
  service.start(); service.start();
  expect(calls).toHaveLength(1);
  expect(calls[0]!.command).toBe("/node24");
  expect(calls[0]!.args[0]).toBe("--experimental-strip-types");
  expect(calls[0]!.args[1]).toEndWith("/integrations/matter/main.ts");
  expect(calls[0]!.options.env.HOMETRUTH_URL).toBe("http://127.0.0.1:43917");
  expect(calls[0]!.options.env.HOMETRUTH_MATTER_STORAGE).toBe(resolve(".hometruth/matter"));
  expect(calls[0]!.options.env.HOMETRUTH_TOKEN).toBe("test-token");
  expect(calls[0]!.options.stdio).toEqual(["ignore", "inherit", "inherit", "ipc"]);
  expect(calls[0]!.options.serialization).toBe("json");
  expect(calls[0]!.options.detached).toBeUndefined();
  children[0]!.emit("message", { type: "matter-status", running: true, commissioned: true, switches: [{ reachable: true }] });
  expect(service.status()).toEqual({ availability: "online", detail: "Paired with Apple Home; 1/1 switches reachable" });
});

test("bridge failures are visible and retried without throwing into the application", async () => {
  const { service, children } = fixture();
  service.start();
  children[0]!.emit("error", new Error("Node executable missing"));
  expect(service.status().availability).toBe("offline");
  expect(service.status().detail).toContain("Node executable missing");
  children[0]!.emit("exit", -1, null);
  await Bun.sleep(30);
  expect(children).toHaveLength(2);
  children[0]!.emit("message", { type: "matter-status", running: true, commissioned: true, switches: [] });
  expect(service.status().availability).toBe("unknown");
  children[1]!.emit("message", { type: "matter-status", running: true, commissioned: true, switches: [{ reachable: false }] });
  expect(service.status().availability).toBe("degraded");
  expect(service.events().some(event => event.message.includes("Node executable missing"))).toBe(true);
});

test("stopping closes the bridge once and cancels any future restart", async () => {
  const { service, children } = fixture();
  service.start();
  await Promise.all([service.stop(), service.stop()]);
  service.start();
  await Bun.sleep(30);
  expect(children).toHaveLength(1);
  expect(children[0]!.signals).toEqual(["SIGTERM"]);
  expect(service.status().availability).toBe("offline");
});

test("a startup failure keeps its actionable reason on the Services page", () => {
  const { service, children } = fixture();
  service.start();
  children[0]!.emit("message", { type: "matter-error", detail: "The Matter bridge is already running as PID 123" });
  children[0]!.emit("exit", 1, null);
  expect(service.status()).toEqual({ availability: "offline", detail: "The Matter bridge is already running as PID 123" });
});

test("a bridge stuck during shutdown is reaped before a new worker takes its storage", async () => {
  const { service, children } = fixture();
  service.start(); children[0]!.graceful = false;
  await service.stop();
  expect(children[0]!.signals).toEqual(["SIGTERM", "SIGKILL"]);
});

test("stopping during retry prevents another bridge from being spawned", async () => {
  const { service, children } = fixture();
  service.start(); children[0]!.emit("exit", 1, null);
  await service.stop(); await Bun.sleep(30);
  expect(children).toHaveLength(1);
});

test("an explicitly disabled bridge opens no process", () => {
  const { service, calls } = fixture({ HOMETRUTH_MATTER_ENABLED: "0" });
  service.start();
  expect(calls).toHaveLength(0);
  expect(service.status().detail).toContain("Disabled");
});
