import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { IOT_CODES, PET3T_CONTROL_CATALOG } from "../../devices/treat-dispensers/tkenpro-2k-pet-camera-treat-dispenser/controls.ts";
import type { IotValue, IotValues } from "./types.ts";

const STATE_VERSION = 1;
const MAX_STATE_FILE_BYTES = 1_048_576;
const MAX_STATE_DEVICES = 64;
const MAX_JSON_DEPTH = 16;

/** Identity, network, and credential-bearing values must never enter the cache. */
const PRIVATE_IOT_CODES: ReadonlySet<string> = new Set([
  "1", // Account/user ID.
  "3", // Device key.
  "50", // Device identity/name on older firmware.
  "56", // MAC address.
  "58", // Local address on older firmware.
  "59", // Gateway/address on older firmware.
  "61", // Serial number.
  "100", // Wi-Fi SSID.
  "101", // Legacy Wi-Fi details.
  IOT_CODES.ONVIF_PASSWORD,
  IOT_CODES.ONVIF_URL,
  "126", // Local IP address.
  IOT_CODES.WIFI_MULTI_AP_INFO,
  IOT_CODES.DEVICE_WIFI_INFO,
]);

const PERSISTABLE_IOT_CODES: ReadonlySet<string> = new Set(
  PET3T_CONTROL_CATALOG
    .filter((definition) => definition.access !== "write" && definition.kind !== "action")
    .map((definition) => definition.code)
    .filter((code) => !PRIVATE_IOT_CODES.has(code)),
);

export interface MeariLocalCameraStateEntry {
  readonly uuid: string;
  readonly values: IotValues;
}

export interface MeariLocalCameraStateFile {
  readonly version: 1;
  readonly devices: readonly MeariLocalCameraStateEntry[];
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === code;
}

function isJsonValue(value: unknown, depth = 0): value is IotValue {
  if (depth > MAX_JSON_DEPTH) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  return typeof value === "object"
    && Object.values(value as Record<string, unknown>).every((item) => isJsonValue(item, depth + 1));
}

/** Keep only UI-visible camera properties and discard credentials/network identity. */
export function persistableMeariIotState(values: Readonly<Record<string, unknown>>): IotValues {
  return Object.freeze(Object.fromEntries(
    Object.entries(values)
      .filter((entry): entry is [string, IotValue] => (
        PERSISTABLE_IOT_CODES.has(entry[0]) && isJsonValue(entry[1])
      ))
      .sort(([left], [right]) => Number(left) - Number(right)),
  ));
}

function validateDocument(value: unknown): MeariLocalCameraStateFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Local camera state file is not an object");
  }
  const document = value as Record<string, unknown>;
  if (document.version !== STATE_VERSION || !Array.isArray(document.devices)) {
    throw new Error("Unsupported local camera state file");
  }
  if (document.devices.length > MAX_STATE_DEVICES) {
    throw new Error("Local camera state file contains too many devices");
  }
  const seen = new Set<string>();
  const devices = document.devices.map((value): MeariLocalCameraStateEntry => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Local camera state entry is not an object");
    }
    const entry = value as Record<string, unknown>;
    if (typeof entry.uuid !== "string" || !entry.uuid || entry.uuid.length > 200) {
      throw new Error("Local camera state entry omitted a valid UUID");
    }
    if (seen.has(entry.uuid)) throw new Error("Local camera state file contains a duplicate UUID");
    seen.add(entry.uuid);
    if (!entry.values || typeof entry.values !== "object" || Array.isArray(entry.values)) {
      throw new Error("Local camera state entry omitted its property map");
    }
    return {
      uuid: entry.uuid,
      values: persistableMeariIotState(entry.values as Record<string, unknown>),
    };
  });
  return { version: STATE_VERSION, devices };
}

/** Permission-restricted, sanitized cache of the last camera property sync. */
export class MeariLocalCloudStateStore {
  readonly path: string;

  constructor(path = ".hometruth/local-camera-state.json") {
    this.path = resolve(path);
  }

  async load(): Promise<ReadonlyMap<string, IotValues>> {
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(this.path);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return new Map();
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error("Refusing to load local camera state from a non-file or symbolic link");
    }
    if (metadata.size > MAX_STATE_FILE_BYTES) {
      throw new Error("Refusing to load an unexpectedly large local camera state file");
    }
    const document = validateDocument(JSON.parse(await readFile(this.path, "utf8")) as unknown);
    return new Map(document.devices.map((entry) => [entry.uuid, entry.values]));
  }

  async save(states: ReadonlyMap<string, Readonly<Record<string, unknown>>>): Promise<void> {
    const devices = [...states.entries()]
      .map(([uuid, values]) => ({ uuid, values: persistableMeariIotState(values) }))
      .filter((entry) => entry.values && Object.keys(entry.values).length > 0)
      .sort((left, right) => left.uuid.localeCompare(right.uuid));
    const document = validateDocument({ version: STATE_VERSION, devices });
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryMetadata = await lstat(directory);
    if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
      throw new Error("Refusing to store local camera state in a non-directory or symbolic link");
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
}
