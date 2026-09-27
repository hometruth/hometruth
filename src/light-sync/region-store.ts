/**
 * A permission-restricted (`0600`) store of each camera's TV region (see
 * `region.ts`), keyed by device id. Mirrors the shape and safety properties
 * of `vendors/tkenpro/inventory-store.ts`: atomic writes, owner-only
 * permissions, and a refusal to load from a symlink or an oversized file.
 */
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseSourceRegion, type SourceRegion } from "./region";

const REGION_FILE_VERSION = 1;
const MAX_REGION_FILE_BYTES = 262_144;
const MAX_CAMERAS = 64;
const MAX_ID_LENGTH = 128;

export interface CameraRegionFile {
  readonly version: 1;
  readonly regions: Readonly<Record<string, SourceRegion>>;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === code;
}

function cleanCameraId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_ID_LENGTH) return undefined;
  return trimmed;
}

function validateDocument(value: unknown): CameraRegionFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Region file is not an object");
  }
  const document = value as Record<string, unknown>;
  if (document.version !== REGION_FILE_VERSION || !document.regions || typeof document.regions !== "object") {
    throw new Error("Unsupported region file");
  }
  const entries = Object.entries(document.regions as Record<string, unknown>);
  if (entries.length > MAX_CAMERAS) {
    throw new Error("Region file references too many cameras");
  }
  const regions: Record<string, SourceRegion> = {};
  for (const [rawId, rawRegion] of entries) {
    const id = cleanCameraId(rawId);
    if (!id) continue;
    // A region that fails to parse is dropped rather than failing the whole
    // load: a corrupt entry for one camera should never block every other
    // camera's sync from working.
    try {
      regions[id] = parseSourceRegion(rawRegion);
    } catch {
      continue;
    }
  }
  return { version: REGION_FILE_VERSION, regions };
}

export interface CameraRegionStore {
  load(): Promise<Readonly<Record<string, SourceRegion>>>;
  get(cameraId: string): Promise<SourceRegion | undefined>;
  set(cameraId: string, region: SourceRegion): Promise<void>;
  delete(cameraId: string): Promise<void>;
}

/** File-backed region store with atomic writes and owner-only permissions. */
export class FileCameraRegionStore implements CameraRegionStore {
  readonly path: string;

  constructor(path = ".hometruth/light-sync.json") {
    this.path = resolve(path);
  }

  async load(): Promise<Readonly<Record<string, SourceRegion>>> {
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(this.path);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return {};
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error("Refusing to load light-sync regions from a non-file or symbolic link");
    }
    if (metadata.size > MAX_REGION_FILE_BYTES) {
      throw new Error("Refusing to load an unexpectedly large light-sync region file");
    }
    const document = validateDocument(JSON.parse(await readFile(this.path, "utf8")) as unknown);
    return document.regions;
  }

  async get(cameraId: string): Promise<SourceRegion | undefined> {
    const regions = await this.load();
    return regions[cameraId];
  }

  private async save(regions: Readonly<Record<string, SourceRegion>>): Promise<void> {
    const document = validateDocument({ version: REGION_FILE_VERSION, regions });

    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryMetadata = await lstat(directory);
    if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
      throw new Error("Refusing to store light-sync regions in a non-directory or symbolic link");
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

  async set(cameraId: string, region: SourceRegion): Promise<void> {
    const id = cleanCameraId(cameraId);
    if (!id) throw new Error("Invalid camera id");
    const parsed = parseSourceRegion(region);
    let existing: Readonly<Record<string, SourceRegion>> = {};
    try {
      existing = await this.load();
    } catch {
      existing = {};
    }
    await this.save({ ...existing, [id]: parsed });
  }

  async delete(cameraId: string): Promise<void> {
    let existing: Readonly<Record<string, SourceRegion>> = {};
    try {
      existing = await this.load();
    } catch {
      return;
    }
    if (!(cameraId in existing)) return;
    const { [cameraId]: _removed, ...rest } = existing;
    await this.save(rest);
  }
}
