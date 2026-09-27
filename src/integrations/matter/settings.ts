/** Read-only view of the managed Matter bridge for the HomeTruth web UI. */
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface MatterBridgeSettings {
  readonly running: boolean;
  readonly commissioned: boolean;
  readonly updatedAt?: string;
  readonly switchIds: readonly string[];
  readonly qrCodeDataUrl?: string;
  readonly manualPairingCode?: string;
}

export interface MatterSettingsSource {
  read(): Promise<MatterBridgeSettings | undefined>;
}

export function defaultMatterStoragePath(): string {
  return resolve(process.env.HOMETRUTH_MATTER_STORAGE ?? ".hometruth/matter");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads private bridge files without exposing a separate setup-code endpoint. */
export class FileMatterSettingsSource implements MatterSettingsSource {
  constructor(readonly storagePath = defaultMatterStoragePath()) {}

  async read(): Promise<MatterBridgeSettings | undefined> {
    let status: unknown;
    try {
      status = JSON.parse(await readFile(join(this.storagePath, "status.json"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("The Matter bridge status could not be read", { cause: error });
    }
    if (!record(status) || typeof status.running !== "boolean" || typeof status.commissioned !== "boolean"
      || !Array.isArray(status.switches)) {
      throw new Error("The Matter bridge status is invalid");
    }
    const switchIds = status.switches.flatMap((value) =>
      record(value) && typeof value.id === "string" ? [value.id] : []);
    let qrCodeDataUrl: string | undefined;
    try {
      const image = await readFile(join(this.storagePath, "pairing.png"));
      qrCodeDataUrl = `data:image/png;base64,${Buffer.from(image).toString("base64")}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("The Matter pairing QR code could not be read", { cause: error });
      }
    }
    // A killed process cannot rewrite status.json. Never display its last saved
    // `running: true` as a healthy bridge, or signal a PID that no longer owns it.
    let running = false;
    if (status.running && Number.isSafeInteger(status.pid) && Number(status.pid) > 0) {
      try {
        const owner = Number(await readFile(join(this.storagePath, "bridge.pid"), "utf8"));
        if (owner === status.pid) { process.kill(owner, 0); running = true; }
      } catch { /* The bridge has stopped or no longer owns this store. */ }
    }
    return {
      running,
      commissioned: status.commissioned,
      switchIds,
      ...(typeof status.updatedAt === "string" ? { updatedAt: status.updatedAt } : {}),
      ...(typeof status.manualPairingCode === "string" ? { manualPairingCode: status.manualPairingCode } : {}),
      ...(qrCodeDataUrl ? { qrCodeDataUrl } : {}),
    };
  }
}
