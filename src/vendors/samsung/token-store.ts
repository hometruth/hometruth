/**
 * The pairing token a Tizen set issues the first time HomeTruth connects and
 * the prompt on screen is accepted. It is issued at runtime rather than being
 * something a person can type in, so it is stored here — beside the Aqara
 * HomeKit pairings, for the same reason — and never in `devices.yml` or
 * the secrets file.
 *
 * Losing the file costs one more on-screen prompt, nothing else.
 */
import { mkdir, readFile, lstat, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

const MAX_TOKEN_FILE_BYTES = 4096;

/** Tizen tokens are short decimal strings; anything else did not come from a set. */
function isToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[\w-]+$/.test(value);
}

export class SamsungTokenStore {
  constructor(readonly directory = ".hometruth/samsung/tokens") {}

  path(id: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(id)) throw new Error("Invalid television id");
    return join(this.directory, `${id.replaceAll(":", "_")}.json`);
  }

  async load(id: string): Promise<string | undefined> {
    const path = this.path(id);
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_TOKEN_FILE_BYTES) throw new Error("Invalid token file");
      const data: unknown = JSON.parse(await readFile(path, "utf8"));
      const token = (data as { token?: unknown } | null)?.token;
      return isToken(token) ? token : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("The saved television pairing token could not be read");
    }
  }

  async save(id: string, token: string): Promise<void> {
    if (!isToken(token)) throw new Error("Invalid television pairing token");
    const path = this.path(id);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ token, savedAt: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  }

  /** Forget a pairing, so the next connection asks the set for a new one. */
  async clear(id: string): Promise<void> {
    try {
      await unlink(this.path(id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
