import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { IrRfBlasterSaveCodeRequest, IrRfBlasterUpdateCodeRequest, IrRfCodesFile, SavedSignalCode } from "./schemas";
import { describeValidationErrors, validators } from "./validation";

/**
 * Named IR/RF signals learned per device, kept in the git-ignored
 * `.hometruth/ir-rf-codes.json` so the device page can offer them as buttons
 * across restarts. Codes are opaque, adapter-owned values and carry no secrets,
 * but the file still gets owner-only permissions like the other caches.
 */

const DEFAULT_PATH = ".hometruth/ir-rf-codes.json";
const MAX_FILE_BYTES = 8_388_608;
const MAX_CODES_PER_DEVICE = 200;
const EMPTY: IrRfCodesFile = { version: 1, devices: {} };

export type SignalCodeStoreErrorCode = "invalid" | "full" | "corrupt";

export class SignalCodeStoreError extends Error {
  constructor(message: string, readonly code: SignalCodeStoreErrorCode) {
    super(message);
    this.name = "SignalCodeStoreError";
  }
}

export interface SignalCodeStore {
  snapshot(): Promise<ReadonlyMap<string, readonly SavedSignalCode[]>>;
  list(deviceId: string): Promise<readonly SavedSignalCode[]>;
  add(deviceId: string, request: IrRfBlasterSaveCodeRequest): Promise<SavedSignalCode>;
  /** Changes a saved code's defaults; resolves undefined when the device has no saved code with that id. */
  update(deviceId: string, codeId: string, request: IrRfBlasterUpdateCodeRequest): Promise<SavedSignalCode | undefined>;
  /** Resolves false when the device has no saved code with that id. */
  remove(deviceId: string, codeId: string): Promise<boolean>;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === code;
}

function validateDocument(value: unknown): IrRfCodesFile {
  if (!validators.irRfCodesFile(value)) {
    throw new SignalCodeStoreError(
      `Saved IR/RF codes are invalid: ${describeValidationErrors(validators.irRfCodesFile.errors)}`,
      "corrupt",
    );
  }
  return value;
}

abstract class DocumentSignalCodeStore implements SignalCodeStore {
  protected abstract read(): Promise<IrRfCodesFile>;
  protected abstract write(document: IrRfCodesFile): Promise<void>;

  async snapshot(): Promise<ReadonlyMap<string, readonly SavedSignalCode[]>> {
    return new Map(Object.entries((await this.read()).devices));
  }

  async list(deviceId: string): Promise<readonly SavedSignalCode[]> {
    return (await this.read()).devices[deviceId] ?? [];
  }

  async add(deviceId: string, request: IrRfBlasterSaveCodeRequest): Promise<SavedSignalCode> {
    const name = request.name.trim();
    if (!name) throw new SignalCodeStoreError("A saved code needs a name", "invalid");
    const document = await this.read();
    const existing = document.devices[deviceId] ?? [];
    if (existing.length >= MAX_CODES_PER_DEVICE) {
      throw new SignalCodeStoreError(`A device can keep at most ${MAX_CODES_PER_DEVICE} saved codes`, "full");
    }
    const saved: SavedSignalCode = {
      id: randomUUID(),
      name,
      channel: request.channel,
      code: request.code,
      ...(request.frequencyHz !== undefined ? { frequencyHz: request.frequencyHz } : {}),
      ...(request.durationMs ? { durationMs: request.durationMs } : {}),
      learnedAt: new Date().toISOString(),
    };
    await this.write({ version: 1, devices: { ...document.devices, [deviceId]: [...existing, saved] } });
    return saved;
  }

  async update(deviceId: string, codeId: string, request: IrRfBlasterUpdateCodeRequest): Promise<SavedSignalCode | undefined> {
    const document = await this.read();
    const existing = document.devices[deviceId] ?? [];
    const current = existing.find((saved) => saved.id === codeId);
    if (!current) return undefined;
    // A zero hold means "send once", the same as no default at all, so it is stored as absence.
    const { durationMs: _previous, ...rest } = current;
    const updated: SavedSignalCode = { ...rest, ...(request.durationMs ? { durationMs: request.durationMs } : {}) };
    const replaced = existing.map((saved) => (saved.id === codeId ? updated : saved));
    await this.write({ version: 1, devices: { ...document.devices, [deviceId]: replaced } });
    return updated;
  }

  async remove(deviceId: string, codeId: string): Promise<boolean> {
    const document = await this.read();
    const existing = document.devices[deviceId] ?? [];
    const remaining = existing.filter((saved) => saved.id !== codeId);
    if (remaining.length === existing.length) return false;
    await this.write({ version: 1, devices: { ...document.devices, [deviceId]: remaining } });
    return true;
  }
}

/** In-memory store for tests and for sites that have no blaster configured. */
export class MemorySignalCodeStore extends DocumentSignalCodeStore {
  #document: IrRfCodesFile = EMPTY;

  protected async read(): Promise<IrRfCodesFile> {
    return this.#document;
  }

  protected async write(document: IrRfCodesFile): Promise<void> {
    this.#document = validateDocument(document);
  }
}

/** File-backed store with atomic writes and owner-only permissions. */
export class FileSignalCodeStore extends DocumentSignalCodeStore {
  readonly path: string;

  constructor(path = DEFAULT_PATH) {
    super();
    this.path = resolve(path);
  }

  protected async read(): Promise<IrRfCodesFile> {
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(this.path);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return EMPTY;
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new SignalCodeStoreError("Refusing to load saved IR/RF codes from a non-file or symbolic link", "corrupt");
    }
    if (metadata.size > MAX_FILE_BYTES) {
      throw new SignalCodeStoreError("Refusing to load an unexpectedly large IR/RF code file", "corrupt");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new SignalCodeStoreError(`Saved IR/RF codes are not valid JSON: ${detail}`, "corrupt");
    }
    return validateDocument(parsed);
  }

  protected async write(document: IrRfCodesFile): Promise<void> {
    validateDocument(document);
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryMetadata = await lstat(directory);
    if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
      throw new SignalCodeStoreError("Refusing to store IR/RF codes in a non-directory or symbolic link", "corrupt");
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
