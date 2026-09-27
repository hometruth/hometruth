import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DEFAULT_KINDLE_CONFIG, KindleConfigError, parseKindleConfig, type KindleConfig } from "./config";

export interface KindleSettings { config: KindleConfig; revision: string }
export interface KindleConfigStore {
  load(): Promise<KindleSettings>;
  save(config: KindleConfig, revision: string): Promise<KindleSettings>;
}
function settings(config: KindleConfig): KindleSettings {
  const copy = parseKindleConfig(config);
  return { config: copy, revision: createHash("sha256").update(JSON.stringify(copy)).digest("hex") };
}
function checkRevision(current: KindleSettings, revision: string) {
  if (current.revision !== revision) throw new KindleConfigError("Kindle settings changed; reload before saving", "conflict");
}
export class MemoryKindleConfigStore implements KindleConfigStore {
  private value: KindleSettings;
  constructor(config = DEFAULT_KINDLE_CONFIG) { this.value = settings(config); }
  async load() { return structuredClone(this.value); }
  snapshot(): KindleSettings { return structuredClone(this.value); }
  async save(config: KindleConfig, revision: string) {
    checkRevision(this.value, revision);
    this.value = settings(config);
    return this.load();
  }
}
/** Atomic, serialized writes; corrupt settings are reported, never silently discarded. */
export class FileKindleConfigStore implements KindleConfigStore {
  readonly path: string;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(path = ".hometruth/kindle-view.json") { this.path = resolve(path); }
  async load(): Promise<KindleSettings> {
    try {
      const stat = await lstat(this.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 131072) throw new Error("Invalid Kindle settings file");
      return settings(parseKindleConfig(JSON.parse(await readFile(this.path, "utf8"))));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return settings(DEFAULT_KINDLE_CONFIG);
      throw error;
    }
  }
  save(config: KindleConfig, revision: string): Promise<KindleSettings> {
    const next = settings(config);
    const write = this.pending.then(async () => {
      checkRevision(await this.load(), revision);
      const directory = dirname(this.path);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid Kindle settings directory");
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, "wx", 0o600);
        try { await handle.writeFile(JSON.stringify(next.config, null, 2) + "\n"); await handle.sync(); }
        finally { await handle.close(); }
        await rename(temporary, this.path);
      } finally { await unlink(temporary).catch(() => undefined); }
      return structuredClone(next);
    });
    this.pending = write.catch(() => undefined);
    return write;
  }
}
