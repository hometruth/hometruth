import { prepareApplication } from "./application";
import { uncachedPage } from "./page-response";

const generation = process.env.HOMETRUTH_GENERATION!;
const token = process.env.HOMETRUTH_WORKER_TOKEN!;
const send = (message: object) => process.send?.(message);
let stopping = false;
let activating = false;
let runtime: Awaited<ReturnType<typeof prepareApplication>> | undefined;
let app: Awaited<ReturnType<typeof prepareApplication>>["app"] | undefined;
let server: Bun.Server<undefined> | undefined;

async function stop() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(0), 2_500);
  try { await runtime?.stop(); } finally {
    clearTimeout(deadline);
    server?.stop(true);
    process.exit(0);
  }
}
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => void stop());
process.on("disconnect", () => void stop());
process.on("uncaughtException", error => { console.error(error); process.exit(1); });
process.on("unhandledRejection", error => { console.error(error); process.exit(1); });
process.on("message", message => {
  if (!message || typeof message !== "object" || !("type" in message)) return;
  if (message.type === "stop") void stop();
  if (message.type !== "activate" || activating || stopping || !runtime) return;
  activating = true;
  void runtime.activate().then(next => {
    if (stopping) return;
    app = next;
    process.env.HOMETRUTH_RELOAD_VERSION = `${generation}:ready`;
    send({ type: "running" });
  }).catch(error => {
    console.error(JSON.stringify({ event: "runtime_start_failed", detail: String(error) }));
    // A fresh process is the boundary for resources allocated during a failed
    // startup. The supervisor stops serving this failed preview and replaces it.
    send({ type: "failed" });
  });
});

// Unsolicited IPC liveness, never HTTP/device health probes.
setInterval(() => send({ type: "heartbeat" }), 1_000).unref();
try {
  runtime = await prepareApplication(Number(process.env.HOMETRUTH_PUBLIC_PORT));
  if (!stopping) {
    app = runtime.app;
    process.env.HOMETRUTH_RELOAD_VERSION = `${generation}:ui`;
    server = Bun.serve({
      hostname: "127.0.0.1", port: 0, idleTimeout: 60,
      async fetch(request) {
        if (request.headers.get("x-hometruth-worker-token") !== token) return new Response("Not found", { status: 404 });
        const original = request.headers.get("x-hometruth-original-url");
        if (!original || !app) return new Response("Starting", { status: 503 });
        const headers = new Headers(request.headers);
        headers.delete("x-hometruth-worker-token");
        headers.delete("x-hometruth-original-url");
        /**
         * The client address is a fact only when a socket-reading supervisor
         * put it there, which it proves by prefixing this worker's own secret.
         * Anything else — a caller's forged header passed through by an older
         * supervisor, or another proxy in front — is dropped, and the app then
         * treats the request as remote. Local-network trust fails closed on
         * version skew rather than open.
         */
        const claimed = headers.get("x-hometruth-client-address") ?? "";
        headers.delete("x-hometruth-client-address");
        const space = claimed.indexOf(" ");
        if (space > 0 && claimed.slice(0, space) === token && claimed.length > space + 1) {
          headers.set("x-hometruth-client-address", claimed.slice(space + 1));
        }
        const forwarded = new Request(original, { method: request.method, headers, body: request.body, signal: request.signal });
        return uncachedPage(await app.fetch(forwarded));
      },
    });
    send({ type: "ready", port: server.port });
  }
} catch (error) {
  console.error(JSON.stringify({ event: "application_load_failed", detail: String(error) }));
  process.exit(1);
}
