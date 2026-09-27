import { mkdir, readFile, lstat, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { readHomeKit, isPairingData, validateAddress, homeKitOperation, type HomeKitAddress, type PairingData } from "../../protocols/homekit/client";
import type { HapSnapshot } from "../../protocols/homekit/snapshot";
import type { MatterSnapshot } from "../../protocols/matter/snapshot";

export type ConnectionState = { availability: "unknown" | "degraded"; detail: string } | { availability: "online"; snapshot: HapSnapshot } | { availability: "online"; matter: MatterSnapshot };
export interface AqaraSource {
  read(): Promise<ConnectionState>;
  /** Present only on a Matter-backed source: a live push of state changes, instead of waiting for the next poll. */
  subscribe?(onChange: (state: ConnectionState) => void): () => void;
  /** Present only on a Matter-backed source: ends its one persistent subscription. */
  stop?(): void;
}

/** Pairings are private and reread without restarting the server. Config/API never contains keys. */
export class AqaraPairingStore {
  constructor(readonly directory = ".hometruth/aqara/pairings") {}
  path(id: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(id)) throw new Error("Invalid Aqara connection id");
    return join(this.directory, `${id}.json`);
  }
  async load(id: string): Promise<PairingData | undefined> {
    const path = this.path(id);
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new Error("Invalid pairing file");
      const data: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!isPairingData(data)) throw new Error("Invalid pairing data");
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("The saved Aqara pairing could not be read");
    }
  }
  async save(id: string, data: unknown): Promise<void> {
    if (!isPairingData(data)) throw new Error("Invalid pairing data");
    const path = this.path(id);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(data), { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  }
}

export class AqaraConnection implements AqaraSource {
  private pending: Promise<ConnectionState> | undefined;
  private cached: { at: number; state: ConnectionState } | undefined;
  private pairing = false;
  constructor(readonly id: string, readonly address: HomeKitAddress,
    private readonly store = new AqaraPairingStore(),
    private readonly readDevice = readHomeKit,
    private readonly now = Date.now) { validateAddress(address); store.path(id); }

  async pair(pin: string): Promise<void> {
    if (!/^\d{3}-\d{2}-\d{3}$/.test(pin)) throw new Error("Enter a HomeKit code in XXX-XX-XXX format");
    if (this.pairing) throw new Error("Pairing is already in progress");
    this.pairing = true;
    try {
      await this.pending;
      if (await this.store.load(this.id)) throw new Error("This device already has saved HomeTruth pairing credentials");
      const result = await homeKitOperation(this.address, { operation: "pair", pin }) as { pairing?: unknown };
      // Save immediately after pairing, even if the first state read will fail.
      await this.store.save(this.id, result.pairing);
      this.cached = undefined;
    } finally { this.pairing = false; }
  }

  read(): Promise<ConnectionState> {
    if (this.pairing) return Promise.resolve({ availability: "unknown", detail: "Pairing in progress" });
    if (this.pending) return this.pending;
    if (this.cached && this.now() - this.cached.at < 5000) return Promise.resolve(this.cached.state);
    this.pending = this.refresh().then((state) => { this.cached = { at: this.now(), state }; return state; })
      .finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async refresh(): Promise<ConnectionState> {
    try {
      const pairing = await this.store.load(this.id);
      if (!pairing) return { availability: "unknown", detail: "Pairing required" };
      const pairedId = Buffer.from(pairing.AccessoryPairingID, "hex").toString();
      if (pairedId.toUpperCase() !== this.address.homekitId.toUpperCase()) return { availability: "degraded", detail: "Pairing belongs to another accessory" };
      return { availability: "online", snapshot: await this.readDevice(this.address, pairing) };
    } catch {
      // Authentication failures must not trigger the site's Wi-Fi reconnect recovery.
      return { availability: "degraded", detail: "HomeKit connection unavailable; check pairing and network" };
    }
  }
}
