import { watch as watchFiles, type FSWatcher } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { heartbeatOverdue } from "./watchdog";
import { forwardToWorker } from "./proxy";
import { runtimePaths } from "./paths";
import { createSourceSnapshot } from "./snapshot";
import { listenerConfig, publicRequestUrl } from "./listener-config";

/**
 * The header carrying the real peer address to the worker.
 *
 * Spelled out here rather than imported, because this file stays free of
 * application imports so the listener survives broken application code. It
 * must match `CLIENT_ADDRESS_HEADER` in `src/auth/network.ts`, which is what
 * reads it; `network.test.ts` asserts the two agree.
 */
const CLIENT_ADDRESS_HEADER = "x-hometruth-client-address";



export interface SupervisorOptions {
  watch?: boolean;
  root?: string;
  installationRoot?: string;
  port?: number;
  hostname?: string;
  /** Test fixture entry point, relative to the source snapshot. */
  entrypoint?: string;
  readyTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}
interface Worker {
  process: Bun.Subprocess;
  snapshot: string;
  generation: string;
  port: number;
  heartbeat: number;
  retiring: boolean;
  failed: boolean;
  activationDeadline: number;
}

/** One stable public listener; replaceable, isolated application generations. */
export async function startSupervisor(options: SupervisorOptions = {}) {
  const startedAt = performance.now();
  const paths = runtimePaths(options.root ?? resolve(import.meta.dir, "../.."), options.installationRoot ?? process.cwd());
  const root = paths.source;
  const installation = paths.installation;
  const { hostname, port, publicOrigin } = listenerConfig({
    ...process.env,
    ...(options.hostname === undefined ? {} : { HOST: options.hostname }),
    ...(options.port === undefined ? {} : { PORT: String(options.port) }),
  });
  const inheritedEnv: Record<string, string | undefined> = { ...process.env };
  let environmentInitialized = false;
  const token = crypto.randomUUID();
  const session = crypto.randomUUID();
  const workers = new Set<Worker>();
  const snapshots = new Set<string>();
  /** Resolves when a worker reports its services are up, so requests can wait rather than 503. */
  const activated = new Map<Worker, Promise<void>>();
  const finishActivation = new Map<Worker, () => void>();
  let active: Worker | undefined;
  let staging: string | undefined;
  let version = "";
  let state = "starting";
  let closed = false;
  let closing: Promise<void> | undefined;
  let busy = false;
  let dirty = true;
  let sequence = 0;
  let failures = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const watchers: FSWatcher[] = [];
  let registration: { stop(): Promise<void> } | undefined;
  let watchConfigInputs: ((env: Record<string, string | undefined>) => void) | undefined;
  const status = () => ({ state, version, pid: active?.process.pid ?? null });
  const unavailable = (request: Request): Response => {
    const options = { status: 503, headers: { "retry-after": "1", "cache-control": "no-store" } };
    if (new URL(request.url).pathname.startsWith("/api/")) {
      return Response.json({ error: { code: "unavailable", message: "HomeTruth is unavailable." } }, options);
    }
    // A live supervisor is not a working application. Never return a page,
    // cached shell, or reload script in place of an unavailable upstream.
    return new Response(request.method === "HEAD" ? null : "HomeTruth is unavailable.\n", {
      ...options, headers: { ...options.headers, "content-type": "text/plain; charset=utf-8" },
    });
  };

  // Bind exactly once, before loading application code or reading config files.
  const server = Bun.serve({
    hostname,
    port, idleTimeout: 60,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/_runtime/status") return Response.json(status(), { headers: { "cache-control": "no-store" } });
      if (url.pathname === "/api/health" && !version.endsWith(":ready")) return unavailable(request);
      // A worker serves nothing until its services are up: a page rendered mid-activation would
      // show every device as unconfigured. Requests wait briefly for it rather than being told
      // the site is down, since activation is normally a second or two.
      const activating = active && active.activationDeadline > 0 ? active : undefined;
      if (activating) await Promise.race([
        activated.get(activating) ?? Promise.resolve(),
        new Promise(resolve => setTimeout(resolve, 10_000)),
      ]);
      const target = active;
      if (!target || target.failed || target.activationDeadline > 0) return unavailable(request);
      const upstream = new URL(request.url);
      upstream.hostname = "127.0.0.1";
      upstream.port = String(target.port);
      upstream.protocol = "http:";
      const headers = new Headers(request.headers);
      headers.set("x-hometruth-worker-token", token);
      headers.set("x-hometruth-original-url", publicRequestUrl(request.url, publicOrigin));
      /**
       * Who is actually asking, from the socket.
       *
       * This is the only place the real peer address exists: everything past
       * here is a loopback hop, so the worker would see 127.0.0.1 for the whole
       * world. Local-network trust is decided from this value, which is why the
       * delete matters as much as the set — without it a client could send the
       * header itself and be believed. `X-Forwarded-For` is left alone; it is a
       * claim, and nothing authorizes on it.
       */
      headers.delete(CLIENT_ADDRESS_HEADER);
      const peer = server.requestIP(request)?.address;
      // Prefixed with the worker's own secret, so the value is worthless to
      // anyone who cannot already reach the worker directly. `--watch` replaces
      // workers and not this process, so a new worker often runs behind an
      // older supervisor, which forwards client headers untouched; a plain
      // address here would be forgeable for exactly as long as that skew lasts.
      // The worker rejects any value not carrying this secret.
      if (peer) headers.set(CLIENT_ADDRESS_HEADER, `${token} ${peer}`);
      try {
        // Preserve streaming bodies, cookies, redirects and the original origin.
        // Never replay a device command after an upstream failure.
        return await forwardToWorker(request, upstream, headers);
      } catch (error) {
        if (!request.signal.aborted) console.warn(JSON.stringify({
          event: "upstream_request_failed", method: request.method, path: url.pathname,
          generation: target.generation, detail: String(error),
        }));
        return unavailable(request);
      }
    },
    error(error) {
      console.error(JSON.stringify({ event: "http_error", detail: String(error) }));
      return Response.json({ error: { code: "unavailable", message: "Request could not complete" } }, { status: 503 });
    },
  });
  const url = `http://${hostname}:${server.port}`;
  console.log(JSON.stringify({ event: "server_started", port: server.port, url, elapsedMs: Math.round(performance.now() - startedAt) }));

  async function stopWorker(worker: Worker) {
    worker.retiring = true;
    try { worker.process.send({ type: "stop" }); } catch { /* Already exited. */ }
    const deadline = setTimeout(() => killWorker(worker), options.shutdownTimeoutMs ?? 3_000);
    await worker.process.exited;
    clearTimeout(deadline);
    // Also reap native helpers that inherited this worker's process group.
    killWorker(worker);
    workers.delete(worker);
  }
  function killWorker(worker: Worker) {
    try { process.kill(-worker.process.pid, "SIGKILL"); } catch { worker.process.kill("SIGKILL"); }
  }
  async function environment() {
    const fromFiles: Record<string, string> = {};
    try { Object.assign(fromFiles, parseEnv(await readFile(join(installation, ".env"), "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const mode = inheritedEnv.NODE_ENV ?? fromFiles.NODE_ENV ?? "development";
    for (const name of [`.env.${mode}`, ...(mode === "test" ? [] : [".env.local"])]) {
      try { Object.assign(fromFiles, parseEnv(await readFile(join(installation, name), "utf8"))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    if (!environmentInitialized) {
      // Bun has already loaded .env in this parent. Remove those inherited
      // values so deleting a key on disk really deletes it in the next child.
      for (const [key, value] of Object.entries(fromFiles)) if (inheritedEnv[key] === value) delete inheritedEnv[key];
      environmentInitialized = true;
    }
    const env: Record<string, string | undefined> = { ...fromFiles, ...inheritedEnv };
    // The public address belongs to the supervisor for its whole lifetime.
    env.HOMETRUTH_PUBLIC_PORT = String(server.port);
    env.HOMETRUTH_WORKER_TOKEN = token;
    env.DEV_HUB = "off";
    watchConfigInputs?.(env);
    return env;
  }
  async function snapshot() {
    const path = await createSourceSnapshot(paths, session);
    snapshots.add(path);
    staging = path;
    return path;
  }
  async function launch(path: string): Promise<Worker> {
    const generation = `${session}-${++sequence}`;
    const env = { ...await environment(), HOMETRUTH_GENERATION: generation };
    let resolveReady!: (worker: Worker) => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<Worker>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    let worker: Worker;
    const earlyMessages: unknown[] = [];
    const child = Bun.spawn([process.execPath, join(path, options.entrypoint ?? "src/runtime/worker.ts")], {
      cwd: installation, env, stdin: "ignore", stdout: "inherit", stderr: "inherit", detached: true,
      ipc(message: unknown) {
        if (!worker) { earlyMessages.push(message); return; }
        if (!message || typeof message !== "object" || !("type" in message)) return;
        if (message.type === "heartbeat") worker.heartbeat = Date.now();
        if (message.type === "ready" && "port" in message && typeof message.port === "number" && message.port > 0 && message.port <= 65535) {
          worker.port = message.port;
          worker.heartbeat = Date.now();
          resolveReady(worker);
        }
        if (message.type === "running" && active === worker && !worker.retiring) {
          worker.activationDeadline = 0;
          finishActivation.get(worker)?.();
          finishActivation.delete(worker);
          worker.failed = false;
          version = `${worker.generation}:ready`;
          state = "running";
          // Stable operation resets crash backoff, not merely opening a socket.
          const stable = setTimeout(() => { if (active === worker) failures = 0; }, 30_000);
          stable.unref();
          console.log(JSON.stringify({ event: "runtime_ready", generation: worker.generation }));
          void prune();
        }
        if (message.type === "failed" && active === worker && !worker.retiring) {
          worker.failed = true;
          worker.activationDeadline = 0;
          finishActivation.get(worker)?.();
          finishActivation.delete(worker);
          version = "";
          scheduleRetry();
        }
      },
    });
    worker = { process: child, snapshot: path, generation, port: 0, heartbeat: Date.now(), retiring: false, failed: false, activationDeadline: 0 };
    workers.add(worker);
    for (const message of earlyMessages) {
      if (message && typeof message === "object" && "type" in message && message.type === "ready"
        && "port" in message && typeof message.port === "number" && message.port > 0 && message.port <= 65535) {
        worker.port = message.port;
        resolveReady(worker);
      }
    }
    const deadline = setTimeout(() => {
      rejectReady(new Error("Application did not become ready before the startup deadline"));
      killWorker(worker);
    }, options.readyTimeoutMs ?? 60_000);
    void child.exited.then(code => {
      clearTimeout(deadline);
      rejectReady(new Error(`Application exited (${code}) before becoming ready`));
      if (active === worker) {
        active = undefined;
        version = "";
        if (!closed && !worker.retiring) scheduleRetry();
      }
      // Never leave a request waiting on a worker that will not finish activating.
      worker.activationDeadline = 0;
      finishActivation.get(worker)?.();
      finishActivation.delete(worker);
      activated.delete(worker);
      killWorker(worker);
      workers.delete(worker);
    });
    try { return await ready; }
    finally { clearTimeout(deadline); }
  }
  async function prune() {
    for (const path of snapshots) {
      if (!closed && (path === staging || [...workers].some(worker => worker.snapshot === path))) continue;
      snapshots.delete(path);
      await rm(path, { recursive: true, force: true });
    }
  }
  function scheduleRetry() {
    if (closed || retryTimer) return;
    state = "retrying";
    const delayMs = Math.min(30_000, 250 * 2 ** Math.min(failures++, 7));
    console.warn(JSON.stringify({ event: "runtime_retry", delayMs }));
    retryTimer = setTimeout(() => { retryTimer = undefined; void reload(); }, delayMs);
  }
  async function reload() {
    if (closed || busy) return;
    busy = true;
    dirty = false;
    try {
      // Always the source as it is now: an older snapshot that happened to work
      // is not this application, and reviving one would serve code nobody wrote.
      const path = await snapshot();
      if (closed) return;
      const next = await launch(path);
      if (closed || dirty) { await stopWorker(next); return; }
      if (next.process.exitCode !== null) throw new Error("Replacement exited before handover");
      const previous = active;
      state = "starting-services";
      // A request never reaches a worker whose services are not up yet — a page rendered
      // mid-activation would show every device as unconfigured, and a reload must not blank the
      // house. Marking the replacement active-but-activating first means requests during the
      // handover wait for it (see the proxy) instead of being told the site is down. Services own
      // exclusive resources (MQTT 1883, the Matter storage lock), so the old worker releases them
      // before the replacement claims them; a stuck shutdown has a hard process-level deadline.
      next.activationDeadline = Date.now() + 30_000;
      activated.set(next, new Promise<void>(resolve => finishActivation.set(next, resolve)));
      active = next;
      version = `${next.generation}:ui`;
      console.log(JSON.stringify({ event: "ui_ready", generation: next.generation, elapsedMs: Math.round(performance.now() - startedAt) }));
      if (previous) await stopWorker(previous);
      if (closed) { await stopWorker(next); return; }
      next.process.send({ type: "activate" });
    } catch (error) {
      console.error(JSON.stringify({ event: "reload_failed", detail: String(error) }));
      // A failed update is an outage. The generation already on the socket is not
      // the code on disk, so it comes down too: down and honest beats up and stale.
      const previous = active;
      if (previous) {
        active = undefined;
        version = "";
        await stopWorker(previous);
      }
      scheduleRetry();
    } finally {
      staging = undefined;
      busy = false;
      await prune();
      if (dirty && !closed) void reload();
    }
  }
  function changed() {
    dirty = true;
    clearTimeout(debounce);
    clearTimeout(retryTimer);
    retryTimer = undefined;
    debounce = setTimeout(() => void reload(), 100);
  }
  const watchdog = setInterval(() => {
    const now = Date.now();
    for (const worker of workers) {
      if (worker.retiring) continue;
      if (heartbeatOverdue(worker, now, options.heartbeatTimeoutMs ?? 10_000)) {
        console.error(JSON.stringify({ event: "worker_unresponsive", pid: worker.process.pid }));
        killWorker(worker);
      } else if (worker.activationDeadline && now > worker.activationDeadline) {
        worker.activationDeadline = 0;
        worker.failed = true;
        if (active === worker) version = "";
        scheduleRetry();
      }
    }
  }, 2_000);
  watchdog.unref();

  function stop(): Promise<void> {
    return closing ??= (async () => {
      closed = true;
      clearInterval(watchdog);
      clearTimeout(debounce);
      clearTimeout(retryTimer);
      for (const watcher of watchers) watcher.close();
      server.stop(true);
      await Promise.allSettled([...workers].map(stopWorker));
      await registration?.stop();
      await Promise.allSettled([...snapshots].map(path => rm(path, { recursive: true, force: true })));
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    })();
  }
  const onSignal = () => { void stop().then(() => process.exit(0)); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  if (options.watch) {
    const isInput = (filename: string) => {
      const path = filename.replaceAll("\\", "/");
      return (path.startsWith("src/") && !/\.(test|e2e)\.[^.]+$/.test(path))
        || (!path.includes("/") && (/^\.env($|\.)/.test(path) || /\.(ya?ml|json|jsonc)$/.test(path) || path === "bun.lock"))
        || [".hometruth/secrets.yml", ".hometruth/dog-announcer.json", ".hometruth/kindle-view.json", ".hometruth/local-camera-auth.json"].includes(path);
    };
    const watch = (directory: string, recursive: boolean, prefix: string) => {
      const watcher = watchFiles(directory, { recursive }, (_event, filename) => {
        if (filename && isInput(prefix + String(filename))) changed();
      });
      watcher.on("error", error => console.error(JSON.stringify({ event: "watch_failed", detail: String(error) })));
      watchers.push(watcher);
    };
    // Avoid recursively watching dependencies, recordings or our source snapshots.
    watch(root, false, "");
    watch(installation, false, "");
    watch(join(root, "src"), true, "src/");
    await mkdir(paths.state, { recursive: true, mode: 0o700 });
    watch(paths.state, false, ".hometruth/");
    const configuredWatchers = new Map<string, FSWatcher>();
    watchConfigInputs = env => {
      const configuredPaths = new Set([env.HOMETRUTH_DEVICES, env.HUE_PROXY_CONFIG, env.HOMETRUTH_KINDLE_CONFIG, env.HOMETRUTH_DOG_CONFIG, env.HOMETRUTH_SECRETS, env.HOMETRUTH_LOCAL_CLOUD_AUTH]
        .filter((path): path is string => Boolean(path)).map(path => resolve(installation, path)));
      for (const [path, watcher] of configuredWatchers) {
        if (!configuredPaths.has(path)) { watcher.close(); configuredWatchers.delete(path); }
      }
      for (const path of configuredPaths) {
        if (configuredWatchers.has(path) || dirname(path) === installation || dirname(path) === paths.state) continue;
        const watcher = watchFiles(dirname(path), (_event, filename) => { if (!filename || String(filename) === basename(path)) changed(); });
        watcher.on("error", error => console.error(JSON.stringify({ event: "watch_failed", detail: String(error) })));
        configuredWatchers.set(path, watcher);
        watchers.push(watcher);
      }
    };
  }
  // Both registration and initialization run after the public socket is open.
  if (process.env.DEV_HUB === "on" || process.env.DEV_HUB === "true" || process.env.DEV_HUB === "1") {
    void import("../dev-registry").then(module => module.startDevHubRegistration({ url })).then(async value => {
      if (closed) await value.stop(); else registration = value;
    }).catch(error => console.warn(JSON.stringify({ event: "dev_hub_unavailable", detail: String(error) })));
  }
  void reload();
  return { server, url, stop, reload: changed, status };
}
