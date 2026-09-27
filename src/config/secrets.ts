/**
 * Secrets: the one place credentials live, separate from `devices.yml`
 * because config is served by the API and secrets never are.
 *
 * The file mirrors the site's shape: `devices.<id>` holds what a model's
 * `secretsSchema` declares for that instance, `vendors.<name>` what a vendor's
 * shared services need (an app account), `network.<adapter>` what the network
 * adapter needs (a router API key), and `api.<client>` the token a local client
 * presents to this site's own server (`api.cli.token` is the one the CLI uses). Provisioning validates each device entry
 * against its model's schema; values are never logged, listed, or returned.
 *
 * `FileSecretStore` is the only backend today: a git-ignored YAML file with
 * mode 0600. The `SecretStore` interface is the seam for a keychain or an
 * encrypted file later; nothing above it would change.
 */
import { chmod, lstat, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { SecretsFile } from "../schemas";
import { describeValidationErrors, validators } from "../validation";

export type { SecretsFile } from "../schemas";

export const DEFAULT_SECRETS_PATH = ".hometruth/secrets.yml";
const MAX_SECRETS_FILE_BYTES = 1_048_576;

export type SecretScope = "devices" | "vendors" | "network" | "api";
export const SECRET_SCOPES: readonly SecretScope[] = ["devices", "vendors", "network", "api"];

export class SecretStoreError extends Error {
  constructor(message: string, readonly code: "invalid" | "io" | "path") {
    super(message);
    this.name = "SecretStoreError";
  }
}

export interface SecretStore {
  /** The whole file; an absent file is an empty one. */
  load(): Promise<SecretsFile>;
  save(file: SecretsFile): Promise<void>;
  exists(): Promise<boolean>;
}

export const EMPTY_SECRETS: SecretsFile = Object.freeze({ schemaVersion: 1 });

type Bag = Record<string, unknown>;

function bag(value: unknown): Bag | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Bag : undefined;
}

/** One scope entry, e.g. `devices["example-camera"]`; `{}` when absent. */
export function secretsFor(file: SecretsFile, scope: SecretScope, id: string): Readonly<Bag> {
  return bag(bag(file[scope])?.[id]) ?? {};
}

/** Every stored secret as a dotted path, values omitted: what exists, never what it is. */
export function secretPaths(file: SecretsFile): string[] {
  const paths: string[] = [];
  const walk = (value: unknown, prefix: string) => {
    const object = bag(value);
    if (!object) {
      paths.push(prefix);
      return;
    }
    for (const key of Object.keys(object).sort()) walk(object[key], `${prefix}.${key}`);
  };
  for (const scope of SECRET_SCOPES) {
    const entries = bag(file[scope]);
    if (entries) for (const id of Object.keys(entries).sort()) walk(entries[id], `${scope}.${id}`);
  }
  return paths;
}

/** A dotted path, e.g. `devices.example-camera.onvif.password`: scope, id, then keys. */
export function parseSecretPath(path: string): { scope: SecretScope; id: string; keys: string[] } {
  const [scope, id, ...keys] = path.split(".");
  if (!scope || !(SECRET_SCOPES as readonly string[]).includes(scope) || !id || keys.length === 0) {
    throw new SecretStoreError(`Secret paths look like devices.<id>.<key>[.<key>], vendors.<name>.<key>, or network.<adapter>.<key>; got "${path}"`, "path");
  }
  return { scope: scope as SecretScope, id, keys };
}

/** A copy of `object` with the value at `keys` set, or removed (and empty parents pruned) when undefined. */
function assign(object: Bag | undefined, keys: readonly string[], value: string | number | boolean | undefined): Bag | undefined {
  const [head, ...rest] = keys;
  const next: Bag = { ...(object ?? {}) };
  if (head === undefined) return next;
  if (rest.length === 0) {
    if (value === undefined) delete next[head];
    else next[head] = value;
  } else {
    const child = assign(bag(next[head]), rest, value);
    if (child === undefined) delete next[head];
    else next[head] = child;
  }
  return Object.keys(next).length === 0 ? undefined : next;
}

/** A copy of the file with one value set, or removed (with empty parents pruned) when `value` is undefined. */
export function withSecret(file: SecretsFile, path: string, value: string | number | boolean | undefined): SecretsFile {
  const { scope, id, keys } = parseSecretPath(path);
  const next: Bag = { ...file };
  const scoped = assign(bag(file[scope]), [id, ...keys], value);
  if (scoped === undefined) delete next[scope];
  else next[scope] = scoped;
  return validate(next, "secrets");
}

export function validate(candidate: unknown, source: string): SecretsFile {
  if (!validators.secretsFile(candidate)) {
    throw new SecretStoreError(`${source} is invalid: ${describeValidationErrors(validators.secretsFile.errors)}`, "invalid");
  }
  return candidate;
}

/** Deterministic block-style YAML for nested objects of scalars; strings are always quoted. */
export function toYaml(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  const object = bag(value);
  if (!object) return `${JSON.stringify(value)}\n`;
  if (Object.keys(object).length === 0) return "{}\n";
  return Object.keys(object).map((key) => {
    const child = object[key];
    const safeKey = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/u.test(key) ? key : JSON.stringify(key);
    return bag(child) && Object.keys(child as Bag).length > 0
      ? `${pad}${safeKey}:\n${toYaml(child, indent + 1)}`
      : `${pad}${safeKey}: ${toYaml(child, 0)}`;
  }).join("");
}

export function parseSecretsText(text: string, source: string): SecretsFile {
  let candidate: unknown;
  try {
    candidate = Bun.YAML.parse(text);
  } catch (error) {
    throw new SecretStoreError(`${source} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`, "invalid");
  }
  return validate(candidate ?? { schemaVersion: 1 }, source);
}

export class FileSecretStore implements SecretStore {
  readonly path: string;

  constructor(path = DEFAULT_SECRETS_PATH) {
    this.path = resolve(path);
  }

  async exists(): Promise<boolean> {
    return await Bun.file(this.path).exists();
  }

  async load(): Promise<SecretsFile> {
    let stats;
    try {
      stats = await lstat(this.path);
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return EMPTY_SECRETS;
      throw new SecretStoreError(`Could not read ${this.path}: ${error instanceof Error ? error.message : String(error)}`, "io");
    }
    if (stats.isSymbolicLink()) throw new SecretStoreError(`${this.path} must not be a symbolic link`, "io");
    if (stats.size > MAX_SECRETS_FILE_BYTES) throw new SecretStoreError(`${this.path} is too large to be a secrets file`, "io");
    return parseSecretsText(await Bun.file(this.path).text(), this.path);
  }

  async save(file: SecretsFile): Promise<void> {
    validate(file, this.path);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `# HomeTruth secrets. Git-ignored, mode 0600. Keys only are ever listed.\n${toYaml(file)}`, { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
  }
}

/** In-memory store for tests and for a server started without a secrets file. */
export class MemorySecretStore implements SecretStore {
  #file: SecretsFile;

  constructor(file: SecretsFile = EMPTY_SECRETS) {
    this.#file = file;
  }

  async exists(): Promise<boolean> {
    return this.#file !== EMPTY_SECRETS;
  }

  async load(): Promise<SecretsFile> {
    return this.#file;
  }

  async save(file: SecretsFile): Promise<void> {
    this.#file = validate(file, "secrets");
  }
}
