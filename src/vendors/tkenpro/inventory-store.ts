import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/**
 * A permission-restricted (`0600`) catalog of the compatible pet cameras found
 * on the local network during discovery. It is a convenience cache so the web
 * interface can list every discovered camera after a restart without forcing a
 * fresh network scan first; a rescan always overwrites it.
 *
 * It deliberately stores NO secrets. Only non-sensitive discovery metadata that
 * already travels over the LAN in plaintext is persisted (host, model, firmware,
 * device name, discovery sources, service URLs, open ports). Credentials live
 * only in `.env.local`; per-device IoT values live only in the state cache.
 */

const INVENTORY_VERSION = 1;
const MAX_INVENTORY_FILE_BYTES = 1_048_576;
const MAX_INVENTORY_CAMERAS = 256;
const MAX_STRING = 256;
const MAX_LIST = 64;

export interface InventoryCamera {
  /** Stable discovery id (uuid:… or host:…). */
  readonly id: string;
  readonly host: string;
  readonly sources: readonly string[];
  readonly model?: string;
  readonly firmware?: string;
  readonly deviceName?: string;
  readonly serialNumber?: string;
  readonly endpointReference?: string;
  readonly onvifAdvertised?: boolean;
  readonly onvifEndpoints: readonly string[];
  readonly openPorts: readonly number[];
  /** ISO-8601 UTC timestamp of the discovery run that recorded this camera. */
  readonly lastSeen: string;
}

export interface CameraInventoryFile {
  readonly version: 1;
  readonly cameras: readonly InventoryCamera[];
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === code;
}

function cleanString(value: unknown, max = MAX_STRING): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return undefined;
  return trimmed;
}

function cleanStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const clean = cleanString(item);
    if (clean) out.push(clean);
    if (out.length >= MAX_LIST) break;
  }
  return [...new Set(out)];
}

function cleanPortList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const item of value) {
    if (Number.isInteger(item) && (item as number) >= 0 && (item as number) <= 65_535) {
      out.push(item as number);
    }
    if (out.length >= MAX_LIST) break;
  }
  return [...new Set(out)].sort((left, right) => left - right);
}

/** Coerce arbitrary input into a valid inventory camera, or drop it (returns undefined). */
export function sanitizeInventoryCamera(value: unknown): InventoryCamera | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const id = cleanString(record.id);
  const host = cleanString(record.host);
  if (!id || !host) return undefined;
  const lastSeen = cleanString(record.lastSeen) ?? new Date().toISOString();
  return {
    id,
    host,
    sources: cleanStringList(record.sources),
    ...(cleanString(record.model) ? { model: cleanString(record.model)! } : {}),
    ...(cleanString(record.firmware) ? { firmware: cleanString(record.firmware)! } : {}),
    ...(cleanString(record.deviceName) ? { deviceName: cleanString(record.deviceName)! } : {}),
    ...(cleanString(record.serialNumber) ? { serialNumber: cleanString(record.serialNumber)! } : {}),
    ...(cleanString(record.endpointReference) ? { endpointReference: cleanString(record.endpointReference)! } : {}),
    ...(record.onvifAdvertised === true ? { onvifAdvertised: true } : {}),
    onvifEndpoints: cleanStringList(record.onvifEndpoints),
    openPorts: cleanPortList(record.openPorts),
    lastSeen,
  };
}

function validateDocument(value: unknown): CameraInventoryFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Camera inventory file is not an object");
  }
  const document = value as Record<string, unknown>;
  if (document.version !== INVENTORY_VERSION || !Array.isArray(document.cameras)) {
    throw new Error("Unsupported camera inventory file");
  }
  if (document.cameras.length > MAX_INVENTORY_CAMERAS) {
    throw new Error("Camera inventory file contains too many cameras");
  }
  const seen = new Set<string>();
  const cameras: InventoryCamera[] = [];
  for (const entry of document.cameras) {
    const camera = sanitizeInventoryCamera(entry);
    if (!camera || seen.has(camera.id)) continue;
    seen.add(camera.id);
    cameras.push(camera);
  }
  return { version: INVENTORY_VERSION, cameras };
}

export interface CameraInventoryStore {
  load(): Promise<readonly InventoryCamera[]>;
  save(cameras: readonly InventoryCamera[]): Promise<void>;
  /** Merge newly discovered cameras into the stored set (update by id, keep the
   * rest) so a camera that did not answer this scan is not forgotten. Returns
   * the resulting full inventory. */
  merge(cameras: readonly InventoryCamera[]): Promise<readonly InventoryCamera[]>;
  clear(): Promise<void>;
}

/** Combine an existing inventory with freshly discovered cameras, updating each
 * entry by id (new data wins) and preserving cameras not seen this round. */
export function mergeInventoryCameras(
  existing: readonly InventoryCamera[],
  discovered: readonly InventoryCamera[],
): InventoryCamera[] {
  const byId = new Map<string, InventoryCamera>();
  for (const camera of existing) {
    const clean = sanitizeInventoryCamera(camera);
    if (clean) byId.set(clean.id, clean);
  }
  for (const camera of discovered) {
    const clean = sanitizeInventoryCamera(camera);
    if (clean) byId.set(clean.id, clean);
  }
  return [...byId.values()].sort((left, right) => left.host.localeCompare(right.host));
}

/** File-backed inventory store with atomic writes and owner-only permissions. */
export class FileCameraInventoryStore implements CameraInventoryStore {
  readonly path: string;

  constructor(path = ".hometruth/discovered-cameras.json") {
    this.path = resolve(path);
  }

  async load(): Promise<readonly InventoryCamera[]> {
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(this.path);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return [];
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error("Refusing to load camera inventory from a non-file or symbolic link");
    }
    if (metadata.size > MAX_INVENTORY_FILE_BYTES) {
      throw new Error("Refusing to load an unexpectedly large camera inventory file");
    }
    const document = validateDocument(JSON.parse(await readFile(this.path, "utf8")) as unknown);
    return document.cameras;
  }

  async save(cameras: readonly InventoryCamera[]): Promise<void> {
    const seen = new Set<string>();
    const sanitized: InventoryCamera[] = [];
    for (const camera of cameras) {
      const clean = sanitizeInventoryCamera(camera);
      if (!clean || seen.has(clean.id)) continue;
      seen.add(clean.id);
      sanitized.push(clean);
    }
    sanitized.sort((left, right) => left.host.localeCompare(right.host));
    const document = validateDocument({ version: INVENTORY_VERSION, cameras: sanitized });

    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryMetadata = await lstat(directory);
    if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
      throw new Error("Refusing to store camera inventory in a non-directory or symbolic link");
    }
    await chmod(directory, 0o700);

    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.path);
      await chmod(this.path, 0o600);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  async merge(cameras: readonly InventoryCamera[]): Promise<readonly InventoryCamera[]> {
    let existing: readonly InventoryCamera[] = [];
    try {
      existing = await this.load();
    } catch {
      existing = [];
    }
    const merged = mergeInventoryCameras(existing, cameras);
    await this.save(merged);
    return merged;
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.path);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
  }
}
