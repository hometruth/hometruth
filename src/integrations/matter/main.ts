import { CommissioningServer, Environment } from "@matter/main";
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { createSwitchBridge, writePrivateJson, type SwitchBridge } from "./bridge.ts";
import { HomeTruthSwitchClient } from "./client.ts";

if (!process.send) throw new Error("The Apple Home bridge is managed by HomeTruth. Start it with bun run dev or bun run start.");

const root = fileURLToPath(new URL("../../../", import.meta.url));
Environment.default.vars.set("log.level", "info");
const storagePath = resolve(process.env.HOMETRUTH_MATTER_STORAGE ?? join(root, ".hometruth", "matter"));
const port = Number(process.env.HOMETRUTH_MATTER_PORT ?? 5540);
const pollMs = Number(process.env.HOMETRUTH_MATTER_POLL_MS ?? 2000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("HOMETRUTH_MATTER_PORT must be 1..65535");
if (!Number.isInteger(pollMs) || pollMs < 500 || pollMs > 60_000) throw new Error("HOMETRUTH_MATTER_POLL_MS must be 500..60000");

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

async function acquireLock() {
  const path = join(storagePath, "bridge.pid");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(path, "wx", 0o600);
      await file.writeFile(String(process.pid));
      await file.close();
      return async () => {
        if ((await readFile(path, "utf8").catch(() => "")) === String(process.pid)) await unlink(path);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(await readFile(path, "utf8"));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid Matter process lock: ${path}`);
      try {
        process.kill(pid, 0);
        throw new Error(`The Matter bridge is already running as PID ${pid}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      await unlink(path);
    }
  }
  throw new Error("Could not acquire the Matter process lock");
}

await mkdir(storagePath, { recursive: true, mode: 0o700 });
const releaseLock = await acquireLock().catch(error => { report(error); process.exit(1); });
let bridge: SwitchBridge | undefined;
let stopping = false;
let closing: Promise<void> | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let cycle: Promise<void> = Promise.resolve();
let qrPayload: string | undefined;
let qrSvg = "";

function report(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ event: "matter_error", message: detail }));
  if (process.connected) process.send?.({ type: "matter-error", detail });
}

async function saveStatus(running = true) {
  if (!bridge) return;
  const commissioned = bridge.server.lifecycle.isCommissioned;
  const codes = bridge.server.state.commissioning.pairingCodes;
  const switches = bridge.snapshot();
  await writePrivateJson(join(storagePath, "status.json"), {
    running,
    pid: process.pid,
    updatedAt: new Date().toISOString(),
    url: process.env.HOMETRUTH_URL ?? "http://127.0.0.1:3000",
    port,
    commissioned,
    switches,
    ...(!commissioned ? codes : {}),
  });
  // Pairing credentials stay on disk; the parent only needs service health.
  if (process.connected) process.send?.({ type: "matter-status", running, commissioned, switches });
  if (qrPayload !== codes.qrPairingCode) {
    qrPayload = codes.qrPairingCode;
    qrSvg = await QRCode.toString(qrPayload, { type: "svg", errorCorrectionLevel: "M", margin: 4 });
    const png = await QRCode.toBuffer(qrPayload, { type: "png", width: 420, margin: 4, errorCorrectionLevel: "M" });
    await writeFile(join(storagePath, "pairing.png"), png, { mode: 0o600 });
  }
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="5"><title>Home Truth · Matter</title>
<style>body{font:17px system-ui;background:#f5f4f0;color:#222;margin:0;padding:48px 24px}main{max-width:640px;margin:auto}h1{font-size:36px;margin-bottom:8px}p{line-height:1.5}.card{background:white;border-radius:18px;padding:24px;margin:24px 0}.qr{width:280px;max-width:100%;margin:auto}.code{font:30px ui-monospace,monospace;text-align:center;letter-spacing:3px}li{margin:12px 0}.muted{color:#666;font-size:14px}.state{float:right}</style>
<main><h1>Home Truth</h1><p>Matter switch bridge · ${running ? (commissioned ? "Paired" : "Ready to pair") : "Stopped"}</p>
${!commissioned && running ? `<section class="card"><h2>Add to Apple Home</h2><p>On your iPhone or iPad, open Home → + → Add Accessory and scan this code. Choose the same home shown on your Mac.</p><div class="qr">${qrSvg}</div><p class="code">${escapeHtml(codes.manualPairingCode)}</p><p class="muted">You can enter the code through More Options instead. If Home displays an uncertified-accessory notice, this is the local Home Truth development bridge. Once added, the switches sync to Home on your Mac.</p></section>` : ""}
<section class="card"><h2>Switches (${switches.length})</h2><ul>${switches.map((device) => `<li>${escapeHtml(device.name)} <span class="state">${device.reachable ? (device.on ? "On" : "Off") : "Unavailable"}</span></li>`).join("") || "<li>No binary switches configured in Home Truth.</li>"}</ul></section><p class="muted">Last updated ${escapeHtml(new Date().toLocaleString())}. This page refreshes automatically.</p></main></html>`;
  await writeFile(join(storagePath, "pairing.html"), html, { mode: 0o600 });
}

function stop(): Promise<void> {
  if (closing) return closing;
  stopping = true;
  clearTimeout(timer);
  return closing = (async () => {
    await cycle.catch(report);
    await saveStatus(false).catch(report);
    await bridge?.close().catch(report);
    await releaseLock();
  })();
}

process.once("SIGINT", () => { void stop().then(() => process.exit(0)); });
process.once("SIGTERM", () => { void stop().then(() => process.exit(0)); });
process.once("disconnect", () => { void stop().then(() => process.exit(0)); });
process.on("SIGUSR1", () => {
  if (!bridge || stopping || bridge.server.lifecycle.isCommissioned) return;
  void Promise.resolve(bridge.server.act((agent) => agent.get(CommissioningServer).enterCommissionableMode())).then(() => saveStatus()).catch(report);
});

try {
  bridge = await createSwitchBridge({
    client: new HomeTruthSwitchClient(),
    storagePath,
    port,
    onError: report,
  });
  await bridge.server.start();
  await saveStatus();
  console.log(JSON.stringify({ event: "matter_ready", port, switches: bridge.snapshot(), pairingPage: join(storagePath, "pairing.html") }));
  let lastDiscovery = Date.now();
  const tick = async () => {
    if (stopping) return;
    cycle = (async () => {
      if (Date.now() - lastDiscovery >= 30_000) {
        lastDiscovery = Date.now();
        await bridge!.discover().catch(report);
      }
      await bridge!.poll();
      await saveStatus();
    })().catch(report);
    await cycle;
    if (!stopping) timer = setTimeout(() => { void tick(); }, pollMs);
  };
  timer = setTimeout(() => { void tick(); }, pollMs);
} catch (error) {
  report(error);
  await stop();
  process.exitCode = 1;
}
