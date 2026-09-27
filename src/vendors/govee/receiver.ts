import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { ensureGoveeScanner } from "../../protocols/govee/build";
import { parseH5075Advertisement, type GoveeAdvertisement } from "../../protocols/govee/advertisement";

export interface GoveeSnapshot {
  reading?: GoveeAdvertisement;
  scanning: boolean;
  detail: string;
}
export interface GoveeReader { snapshot(peripheralId: string): GoveeSnapshot }

declare module "../../models/device" { interface SiteServices { govee?: GoveeReader } }

const DETAILS: Record<string, string> = {
  scanning: "Listening for Govee Bluetooth readings",
  poweredOff: "Bluetooth is off on the HomeTruth Mac",
  unauthorized: "Allow Bluetooth for HomeTruth's host app in macOS System Settings → Privacy & Security → Bluetooth",
  unsupported: "Bluetooth is unavailable to HomeTruth on this Mac",
  resetting: "Bluetooth is restarting",
  unknown: "Waiting for Bluetooth",
};

/** One receiver shared by all Govee devices; never opens a GATT connection. */
export class GoveeReceiver implements GoveeReader {
  private readonly readings = new Map<string, GoveeAdvertisement>();
  private scanning = false;
  private detail = "Starting Govee Bluetooth receiver";
  private child: Bun.Subprocess<"ignore", "pipe", "ignore"> | undefined;
  private starting: Promise<void> | undefined;
  private retryAt = 0;
  private closed = false;

  constructor(private readonly now: () => number = Date.now) {}

  snapshot(peripheralId: string): GoveeSnapshot {
    void this.start();
    const reading = this.readings.get(peripheralId.toUpperCase());
    return { scanning: this.scanning, detail: this.detail, ...(reading ? { reading: { ...reading } } : {}) };
  }

  discovered(): GoveeAdvertisement[] { return [...this.readings.values()].map(reading => ({ ...reading })); }

  start(): Promise<void> {
    if (this.closed || this.child || this.now() < this.retryAt) return Promise.resolve();
    this.starting ??= this.launch().catch(error => {
      this.scanning = false;
      this.detail = (error instanceof Error ? error.message : "Govee Bluetooth receiver failed").slice(0, 500);
      this.retryAt = this.now() + 30_000;
    }).finally(() => { this.starting = undefined; });
    return this.starting;
  }

  /** Accepts the bounded JSON lines emitted by our native helper. */
  ingest(line: string): void {
    if (line.length > 4096) return;
    let value: unknown;
    try { value = JSON.parse(line); } catch { return; }
    if (!value || typeof value !== "object") return;
    const status = value as Record<string, unknown>;
    if (status.type === "status" && typeof status.state === "string" && Object.hasOwn(DETAILS, status.state)) {
      this.scanning = status.state === "scanning";
      this.detail = DETAILS[status.state]!;
      if (!this.scanning) this.readings.clear();
      return;
    }
    const reading = parseH5075Advertisement(value, this.now());
    if (!reading || !this.scanning) return;
    this.readings.delete(reading.peripheralId);
    this.readings.set(reading.peripheralId, reading);
    if (this.readings.size > 256) this.readings.delete(this.readings.keys().next().value!);
  }

  private async launch(): Promise<void> {
    const binary = await ensureGoveeScanner();
    if (this.closed) return;
    const child = Bun.spawn([binary], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    this.child = child;
    const lines = createInterface({ input: Readable.from(child.stdout) });
    lines.on("line", line => this.ingest(line));
    lines.on("error", () => child.kill());
    void child.exited.then(code => {
      lines.close();
      if (this.child !== child) return;
      this.child = undefined;
      this.scanning = false;
      this.readings.clear();
      this.detail = `Govee Bluetooth receiver stopped (${code}); retrying on the next read`;
      this.retryAt = this.now() + 30_000;
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.scanning = false;
    this.readings.clear();
    this.detail = "Govee Bluetooth receiver is stopped";
    const child = this.child;
    this.child = undefined;
    child?.kill();
    await child?.exited;
    await this.starting;
  }
}
