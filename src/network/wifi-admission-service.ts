import { inspectWifiAdmission, runWifiAdmissionCommand, type WifiAdmissionCommandOptions, type WifiAdmissionSetup } from "./wifi-admission-command";
import type { AdmissionResult } from "./wifi-admission";

export interface WifiAdmissionRun {
  id: string;
  ssid: string;
  timeoutSeconds: number;
  recovery: boolean;
  status: "running" | "stopping" | "complete" | "failed";
  startedAt: string;
  finishedAt?: string;
  activity: { at: string; message: string }[];
  result?: AdmissionResult;
  error?: string;
}

export class WifiAdmissionBusyError extends Error {}

export interface WifiAdmissionDependencies {
  inspect?: () => Promise<WifiAdmissionSetup>;
  run?: (options: WifiAdmissionCommandOptions, report: (message: string) => void, signal: AbortSignal) => Promise<AdmissionResult>;
}

/** Owns the current run so browsers can come and go without stopping admission. */
export class WifiAdmissionService {
  private current: WifiAdmissionRun | undefined;
  private abort: AbortController | undefined;
  private readonly inspectImpl: () => Promise<WifiAdmissionSetup>;
  private readonly runImpl: NonNullable<WifiAdmissionDependencies["run"]>;
  private setup: WifiAdmissionSetup | undefined;

  constructor(dependencies: WifiAdmissionDependencies = {}) {
    this.inspectImpl = dependencies.inspect ?? (() => inspectWifiAdmission());
    this.runImpl = dependencies.run ?? ((options, report, signal) => runWifiAdmissionCommand(options, process.env, report, signal));
  }

  async inspect(): Promise<WifiAdmissionSetup> { return this.setup = await this.inspectImpl(); }
  configuration(): WifiAdmissionSetup | undefined { return this.setup; }
  snapshot(): WifiAdmissionRun | undefined { return this.current ? structuredClone(this.current) : undefined; }

  start(ssid: string, timeoutSeconds = 180, recovery = false): WifiAdmissionRun {
    if (!ssid.trim() || ssid.length > 128 || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 600) {
      throw new Error("Choose a Wi-Fi network and a duration from 10 to 600 seconds");
    }
    if (this.current?.status === "running" || this.current?.status === "stopping") throw new WifiAdmissionBusyError("A Wi-Fi admission command is already running");
    const run: WifiAdmissionRun = { id: crypto.randomUUID(), ssid, timeoutSeconds, recovery, status: "running",
      startedAt: new Date().toISOString(), activity: [] };
    const abort = new AbortController();
    this.current = run;
    this.abort = abort;
    // The run is detached from the HTTP request. Both rejection paths are handled here.
    void Promise.resolve().then(() => this.runImpl({ ssid, timeoutMs: timeoutSeconds * 1000, dryRun: false, recover: recovery }, message => {
      run.activity.push({ at: new Date().toISOString(), message });
      if (run.activity.length > 100) run.activity.shift();
    }, abort.signal)).then(result => {
      run.result = result;
      run.status = "complete";
    }, error => {
      run.error = error instanceof Error ? error.message : String(error);
      run.status = "failed";
    }).finally(() => { run.finishedAt = new Date().toISOString(); this.abort = undefined; });
    return this.snapshot()!;
  }

  cancel(id: string): WifiAdmissionRun {
    if (!this.current || this.current.id !== id) throw new Error("This command run is no longer current");
    if (this.current.status === "running") {
      // Recovery must finish restoring the restriction; it is never cancellable.
      if (this.current.recovery) throw new Error("Restoration is already in progress");
      this.current.status = "stopping";
      this.abort?.abort();
    }
    return this.snapshot()!;
  }
}
