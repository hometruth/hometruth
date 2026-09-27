/**
 * Where tokens live.
 *
 * SQLite through `bun:sqlite`, as tags and the graph already do: no new
 * dependency, real transactions, and the file is chmod 0600 beside them.
 *
 * Only the hash of a secret is ever written. A minted token exists as a whole
 * string exactly once, in the response that created it; after that the store
 * can confirm a presented token and can name it, and cannot reproduce it. That
 * is the property that makes "show it once" honest rather than theatre.
 *
 * `last_used_at` is the one soft write here. Recording it on every request
 * would put a synchronous write in front of every frame of an MJPEG stream, so
 * it is throttled to once a minute per token: enough to answer "is this still
 * in use, and from where", cheap enough to leave on.
 */
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { hashSecret, mintToken, parseToken, secretMatches } from "./token";
import { AuthError, type Permission, type TokenCreate, type TokenSubject } from "./model";

export const DEFAULT_TOKEN_STORE_PATH = ".hometruth/tokens.sqlite";
const SCHEMA_VERSION = 1;
/** How often a token's last-used stamp is allowed to hit the disk. */
const TOUCH_INTERVAL_MS = 60_000;

/** A token as the store holds it. Never carries the secret. */
export interface TokenRecord {
  readonly kid: string;
  readonly name: string;
  readonly permissions: readonly Permission[];
  readonly subject: TokenSubject;
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly revokedAt?: string;
  readonly lastUsedAt?: string;
  readonly lastUsedFrom?: string;
}

/** Why a presented token was refused. The caller decides how much of this to say out loud. */
export type VerifyFailure = "malformed" | "unknown" | "revoked" | "expired";
export type VerifyResult = { ok: true; token: TokenRecord } | { ok: false; reason: VerifyFailure };

interface TokenRow {
  kid: string;
  secret_hash: string;
  name: string;
  permissions: string;
  subject: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  last_used_from: string | null;
}

function toRecord(row: TokenRow): TokenRecord {
  return {
    kid: row.kid,
    name: row.name,
    permissions: JSON.parse(row.permissions) as Permission[],
    subject: JSON.parse(row.subject) as TokenSubject,
    createdAt: row.created_at,
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
    ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}),
    ...(row.last_used_from ? { lastUsedFrom: row.last_used_from } : {}),
  };
}

export class TokenStore {
  private readonly db: Database;
  /** In-memory throttle for `last_used_at`; losing it on restart costs one extra write. */
  private readonly touched = new Map<string, number>();

  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { strict: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tokens (
        kid TEXT PRIMARY KEY,
        secret_hash TEXT NOT NULL,
        name TEXT NOT NULL,
        permissions TEXT NOT NULL,
        subject TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        revoked_at TEXT,
        last_used_at TEXT,
        last_used_from TEXT
      );`);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  /** The only call that returns a usable token string. */
  issue(create: TokenCreate, now = new Date()): { token: string; record: TokenRecord } {
    const minted = mintToken();
    this.db.query(`INSERT INTO tokens (kid, secret_hash, name, permissions, subject, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      minted.kid, minted.secretHash, create.name.trim(),
      JSON.stringify(create.permissions), JSON.stringify(create.subject),
      now.toISOString(), create.expiresAt ?? null,
    );
    return { token: minted.token, record: this.get(minted.kid)! };
  }

  get(kid: string): TokenRecord | undefined {
    const row = this.db.query("SELECT * FROM tokens WHERE kid = ?").get(kid) as TokenRow | null;
    return row ? toRecord(row) : undefined;
  }

  list(): TokenRecord[] {
    return (this.db.query("SELECT * FROM tokens ORDER BY created_at DESC, kid").all() as TokenRow[]).map(toRecord);
  }

  /**
   * Check a presented token.
   *
   * The lookup is by `kid`, so a token that does not exist costs one indexed
   * miss rather than a scan, and the secret comparison is constant-time. The
   * hash of a *missing* row is still computed, so an unknown kid and a wrong
   * secret take the same shape of work.
   */
  verify(presented: string, now = new Date()): VerifyResult {
    const parts = parseToken(presented);
    if (!parts) return { ok: false, reason: "malformed" };
    const row = this.db.query("SELECT * FROM tokens WHERE kid = ?").get(parts.kid) as TokenRow | null;
    // Hash regardless, so the work does not depend on whether the row was found.
    const matches = secretMatches(parts.secret, row?.secret_hash ?? hashSecret("\0absent"));
    if (!row || !matches) return { ok: false, reason: "unknown" };
    if (row.revoked_at) return { ok: false, reason: "revoked" };
    if (row.expires_at && Date.parse(row.expires_at) <= now.getTime()) return { ok: false, reason: "expired" };
    return { ok: true, token: toRecord(row) };
  }

  /** Records that a token was used, at most once a minute per token. */
  touch(kid: string, from?: string, now = new Date()): void {
    const last = this.touched.get(kid) ?? 0;
    if (now.getTime() - last < TOUCH_INTERVAL_MS) return;
    this.touched.set(kid, now.getTime());
    this.db.query("UPDATE tokens SET last_used_at = ?, last_used_from = ? WHERE kid = ?")
      .run(now.toISOString(), from ?? null, kid);
  }

  /** Revocation is a tombstone, not a delete: a revoked token stays auditable. */
  revoke(kid: string, now = new Date()): TokenRecord {
    const existing = this.get(kid);
    if (!existing) throw new AuthError("No token with that id", "missing");
    if (existing.revokedAt) return existing;
    this.db.query("UPDATE tokens SET revoked_at = ? WHERE kid = ?").run(now.toISOString(), kid);
    return this.get(kid)!;
  }

  /** Whether any usable token exists; what first-run setup asks before opening the door. */
  hasUsableToken(now = new Date()): boolean {
    const row = this.db.query(`SELECT COUNT(*) AS count FROM tokens
      WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`).get(now.toISOString()) as { count: number };
    return row.count > 0;
  }

  close(): void { this.db.close(); }
}
