import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface DogConfig {
  enabled: boolean;
  cameraId: string;
  speakerId: string;
  text: string;
  intervalMs: 5000;
  cooldownMs: 5000;
}

export const DEFAULT_DOG_CONFIG: DogConfig = {
  enabled: false, cameraId: "", speakerId: "",
  text: "OUT", intervalMs: 5000, cooldownMs: 5000,
};

export function parseDogConfig(input: unknown): DogConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected automation settings");
  const v = input as Record<string, unknown>;
  if (Object.keys(v).some(key => !Object.hasOwn(DEFAULT_DOG_CONFIG, key))) throw new Error("Unknown automation setting");
  if (typeof v.enabled !== "boolean") throw new Error("enabled must be true or false");
  const text = (key: string, max: number) => {
    const value = v[key];
    if (typeof value !== "string" || value.length > max || (!value.trim() && (v.enabled || key === "text"))) throw new Error(`Invalid ${key}`);
    return value.trim();
  };
  if (v.intervalMs !== 5000) throw new Error("intervalMs must be 5000 (one check every five seconds)");
  if (v.cooldownMs !== 5000) throw new Error("cooldownMs must be 5000 (five seconds between announcements)");
  return { enabled: v.enabled, cameraId: text("cameraId", 128), speakerId: text("speakerId", 128),
    text: text("text", 100), intervalMs: 5000, cooldownMs: 5000 };
}

export interface DogConfigStore { load(): Promise<DogConfig>; save(config: DogConfig): Promise<void> }
export class FileDogConfigStore implements DogConfigStore {
  constructor(readonly path = ".hometruth/dog-announcer.json") {}
  async load(): Promise<DogConfig> {
    try { return parseDogConfig(JSON.parse(await readFile(this.path, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(DEFAULT_DOG_CONFIG);
      throw error;
    }
  }
  async save(config: DogConfig): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(parseDogConfig(config), null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, this.path);
  }
}
