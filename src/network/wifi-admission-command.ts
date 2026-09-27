import { spawn } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { FileSecretStore } from "../config/secrets";
import { networkEnvironment } from "./config";
import { createNetworkAdapter, NetworkAdapterError } from "./index";
import { acceptNextWifiClient, restoreMacFilter, validAdmissionMac, type AdmissionJournal, type AdmissionResult, type AdmissionWlan } from "./wifi-admission";

export interface WifiAdmissionCommandOptions {
  ssid: string;
  timeoutMs: number;
  dryRun: boolean;
  recover: boolean;
}

interface Snapshot {
  version: 1;
  pid: number;
  target: string;
  startedAt: string;
  wlan: AdmissionWlan;
}

export interface WifiAdmissionSetup {
  networks: { ssid: string; allowedCount: number; available: boolean }[];
  recovery?: { ssid: string; active: boolean };
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** One exclusive journal per checkout prevents overlapping admission and recovery. */
export class FileAdmissionJournal implements AdmissionJournal {
  readonly path: string;
  constructor(readonly directory: string, private readonly target: { target: string }) {
    this.path = resolve(directory, "active.json");
  }
  async save(wlan: AdmissionWlan): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const snapshot: Snapshot = { version: 1, pid: process.pid, ...this.target, startedAt: new Date().toISOString(), wlan };
    try {
      await writeFile(this.path, JSON.stringify(snapshot, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`An admission window or recovery snapshot already exists at ${this.path}; finish it or use network accept-next <ssid> --recover`);
      throw error;
    }
  }
  async clear(): Promise<void> { await unlink(this.path); }
  async pending(): Promise<Snapshot | undefined> {
    let text: string;
    try { text = await readFile(this.path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    const value = JSON.parse(text) as Snapshot;
    if (value.version !== 1 || value.target !== this.target.target || typeof value.wlan?.ssid !== "string"
      || typeof value.wlan.id !== "string" || !value.wlan.filterEnabled || value.wlan.policy !== "allow"
      || !Array.isArray(value.wlan.macs) || value.wlan.macs.some(mac => typeof mac !== "string" || !validAdmissionMac(mac))
      || !Number.isSafeInteger(value.pid) || value.pid <= 0) throw new Error("Recovery snapshot does not match this network target and SSID");
    return value;
  }
  async read(ssid: string): Promise<Snapshot> {
    const value = await this.pending();
    if (!value || value.wlan.ssid !== ssid) throw new Error("Recovery snapshot does not match this network target and SSID");
    if (alive(value.pid)) throw new Error(`Admission process ${value.pid} is still running; cancel it before recovering`);
    return value;
  }
}

async function runtime(env: Record<string, string | undefined>) {
  const secrets = await new FileSecretStore(env.HOMETRUTH_SECRETS).load();
  const adapter = createNetworkAdapter(networkEnvironment(secrets, env));
  if (!adapter.admission) throw new NetworkAdapterError("This network adapter does not support Wi-Fi admission", "not_supported");
  const { api, target } = adapter.admission;
  const journal = new FileAdmissionJournal(resolve(".hometruth/wifi-admission"), { target });
  return { api, journal };
}

/** Read-only page setup; never returns MAC lists, API keys, or Wi-Fi passwords. */
export async function inspectWifiAdmission(env: Record<string, string | undefined> = process.env): Promise<WifiAdmissionSetup> {
  const { api, journal } = await runtime(env);
  const [wlans, snapshot] = await Promise.all([api.listWlans(), journal.pending()]);
  return { networks: wlans.filter(wlan => wlan.enabled).map(wlan => ({ ssid: wlan.ssid, allowedCount: wlan.macs.length,
    available: wlan.filterEnabled && wlan.policy === "allow" })),
    ...(snapshot ? { recovery: { ssid: snapshot.wlan.ssid, active: alive(snapshot.pid) } } : {}),
  };
}

async function execute(options: WifiAdmissionCommandOptions, env: Record<string, string | undefined>, signal: AbortSignal,
  report: (message: string) => void): Promise<AdmissionResult> {
  const { api, journal } = await runtime(env);
  if (options.recover) {
    // A separate recovery mutex prevents simultaneous stale-snapshot recovery.
    const lock = `${journal.path}.recover`;
    await mkdir(journal.directory, { recursive: true, mode: 0o700 });
    await writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 });
    try {
      const saved = await journal.read(options.ssid);
      const restored = await restoreMacFilter(api, saved.wlan);
      await journal.clear();
      return { status: "restored", ssid: restored.ssid, allowedCount: restored.macs.length, filterEnabled: true };
    } finally { await unlink(lock); }
  }
  return await acceptNextWifiClient(api, journal, { ...options, signal, report });
}

type WorkerMessage = { progress: string } | { result: AdmissionResult } | { error: string };

/** The worker owns cleanup independently of the CLI and of HomeTruth server hot reloads. */
export async function runWifiAdmissionCommand(options: WifiAdmissionCommandOptions,
  env: Record<string, string | undefined> = process.env, report: (message: string) => void = console.error, signal?: AbortSignal): Promise<AdmissionResult> {
  signal?.throwIfAborted();
  const child = spawn(process.execPath, [resolve(import.meta.dir, "wifi-admission-command.ts"), "--worker"], {
    detached: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env },
  });
  const cancel = () => { child.kill("SIGTERM"); };
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  signal?.addEventListener("abort", cancel, { once: true });
  let result: AdmissionResult | undefined;
  let error: string | undefined;
  let buffer = "";
  let stderr = "";
  child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
  child.stdout.on("data", chunk => {
    buffer += chunk.toString();
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const message = JSON.parse(line) as WorkerMessage;
        if ("progress" in message) report(message.progress);
        else if ("result" in message) result = message.result;
        else error = message.error;
      } catch { error = "Invalid admission worker response"; }
    }
  });
  try {
    const exited = new Promise<number | null>((resolveExit, reject) => {
      child.on("error", reject);
      child.on("close", resolveExit);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ options, parentPid: process.pid }));
    const code = await exited;
    if (code !== 0 || !result) throw new Error(error ?? `Admission worker stopped (${code}). ${stderr} Check .hometruth/wifi-admission/active.json; use --recover if a snapshot remains.`);
    return result;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    signal?.removeEventListener("abort", cancel);
  }
}

if (import.meta.main && process.argv[2] === "--worker") {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  // Losing the terminal must not interrupt restoration or crash on a broken output pipe.
  process.stdout.on("error", cancel);
  const send = (value: WorkerMessage) => { if (!process.stdout.destroyed) process.stdout.write(JSON.stringify(value) + "\n"); };
  let watch: ReturnType<typeof setInterval> | undefined;
  try {
    const { options, parentPid } = JSON.parse(await Bun.stdin.text()) as { options: WifiAdmissionCommandOptions; parentPid: number };
    if (!Number.isSafeInteger(parentPid) || parentPid <= 0) throw new Error("Invalid admission parent process");
    watch = setInterval(() => { if (!alive(parentPid)) cancel(); }, 500);
    if (!alive(parentPid)) cancel();
    const result = await execute(options, process.env, abort.signal, progress => send({ progress }));
    send({ result });
  } catch (error) {
    send({ error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  } finally {
    if (watch) clearInterval(watch);
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
