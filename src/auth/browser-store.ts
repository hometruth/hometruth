import type { Database } from "bun:sqlite";
import { randomBytes, createHash } from "node:crypto";
import type { WebAuthnCredential } from "@simplewebauthn/server";

export const SESSION_IDLE_MS = 30 * 24 * 60 * 60_000;
export const SESSION_MAX_MS = 90 * 24 * 60 * 60_000;
export const FRESH_AUTH_MS = 5 * 60_000;
export const CHALLENGE_MS = 5 * 60_000;
const secret = () => randomBytes(32).toString("base64url");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export interface BrowserSession {
  id: string;
  kid: string;
  name: string;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number;
  authenticatedAt: number;
  passkeyId: string | null;
}
export interface PasskeyRecord extends WebAuthnCredential {
  kid: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}
export interface BrowserChallenge {
  challenge: string;
  kind: "register" | "authenticate";
  origin: string;
  kid: string | null;
  sessionId: string | null;
}

/** Browser secrets are hashed at rest. All state shares the installation's token database. */
export class BrowserStore {
  constructor(private readonly db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS browser_sessions (
        id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL UNIQUE,
        kid TEXT NOT NULL REFERENCES tokens(kid), name TEXT NOT NULL,
        createdAt INTEGER NOT NULL, lastUsedAt INTEGER NOT NULL,
        expiresAt INTEGER NOT NULL, authenticatedAt INTEGER NOT NULL, passkeyId TEXT
      );
      CREATE INDEX IF NOT EXISTS browser_sessions_kid ON browser_sessions(kid);
      CREATE TABLE IF NOT EXISTS passkeys (
        id TEXT PRIMARY KEY, kid TEXT NOT NULL REFERENCES tokens(kid), name TEXT NOT NULL,
        publicKey BLOB NOT NULL, counter INTEGER NOT NULL, transports TEXT NOT NULL,
        createdAt INTEGER NOT NULL, lastUsedAt INTEGER
      );
      CREATE INDEX IF NOT EXISTS passkeys_kid ON passkeys(kid);
      CREATE TABLE IF NOT EXISTS browser_challenges (
        binding_hash TEXT PRIMARY KEY, challenge TEXT NOT NULL, kind TEXT NOT NULL,
        origin TEXT NOT NULL, kid TEXT, sessionId TEXT, expiresAt INTEGER NOT NULL
      );
    `);
  }

  issue(kid: string, name: string, passkeyId: string | null = null, now = Date.now()) {
    const value = secret();
    const session: BrowserSession = {
      id: randomBytes(16).toString("hex"), kid, name: name.slice(0, 200),
      createdAt: now, lastUsedAt: now, expiresAt: now + SESSION_MAX_MS, authenticatedAt: now, passkeyId,
    };
    this.db.query(`DELETE FROM browser_sessions WHERE expiresAt <= ? OR lastUsedAt <= ?`).run(now, now - SESSION_IDLE_MS);
    this.db.query(`INSERT INTO browser_sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      session.id, hash(value), kid, session.name, now, now, session.expiresAt, now, passkeyId,
    );
    return { value, session };
  }

  verify(value: string, now = Date.now()): BrowserSession | undefined {
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return undefined;
    const row = this.db.query(`SELECT id, kid, name, createdAt, lastUsedAt, expiresAt, authenticatedAt, passkeyId
      FROM browser_sessions WHERE secret_hash = ?`).get(hash(value)) as BrowserSession | null;
    if (!row || row.expiresAt <= now || row.lastUsedAt + SESSION_IDLE_MS <= now) return undefined;
    return row;
  }

  touch(session: BrowserSession, now = Date.now()) {
    if (now - session.lastUsedAt >= 60_000) {
      this.db.query("UPDATE browser_sessions SET lastUsedAt = ? WHERE id = ?").run(now, session.id);
    }
  }

  list(kid: string, now = Date.now()): BrowserSession[] {
    return this.db.query(`SELECT id, kid, name, createdAt, lastUsedAt, expiresAt, authenticatedAt, passkeyId
      FROM browser_sessions WHERE kid = ? AND expiresAt > ? AND lastUsedAt > ? ORDER BY createdAt DESC`)
      .all(kid, now, now - SESSION_IDLE_MS) as BrowserSession[];
  }

  revoke(id: string, kid: string) {
    return this.db.query("DELETE FROM browser_sessions WHERE id = ? AND kid = ?").run(id, kid).changes > 0;
  }

  challenge(input: BrowserChallenge, now = Date.now()): string {
    this.db.query("DELETE FROM browser_challenges WHERE expiresAt <= ?").run(now);
    // Bound storage even when anonymous clients continuously request challenges.
    const { count } = this.db.query("SELECT count(*) AS count FROM browser_challenges").get() as { count: number };
    if (count >= 1000) throw new Error("Too many pending sign-ins");
    const binding = secret();
    this.db.query("INSERT INTO browser_challenges VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      hash(binding), input.challenge, input.kind, input.origin, input.kid, input.sessionId, now + CHALLENGE_MS,
    );
    return binding;
  }

  /** Atomic consumption, including failed verification: a challenge can never be replayed. */
  consume(binding: string, now = Date.now()): BrowserChallenge | undefined {
    return this.db.query(`DELETE FROM browser_challenges WHERE binding_hash = ? AND expiresAt > ?
      RETURNING challenge, kind, origin, kid, sessionId`).get(hash(binding), now) as BrowserChallenge | undefined;
  }

  passkey(id: string): PasskeyRecord | undefined {
    const row = this.db.query("SELECT * FROM passkeys WHERE id = ?").get(id) as
      (Omit<PasskeyRecord, "transports"> & { transports: string }) | null;
    return row ? { ...row, publicKey: new Uint8Array(row.publicKey), transports: JSON.parse(row.transports) } : undefined;
  }

  passkeys(kid: string): PasskeyRecord[] {
    return (this.db.query("SELECT id FROM passkeys WHERE kid = ? ORDER BY createdAt").all(kid) as { id: string }[])
      .map(({ id }) => this.passkey(id)!);
  }

  addPasskey(kid: string, name: string, credential: WebAuthnCredential, now = Date.now()) {
    this.db.query("INSERT INTO passkeys VALUES (?, ?, ?, ?, ?, ?, ?, NULL)").run(
      credential.id, kid, name, credential.publicKey, credential.counter, JSON.stringify(credential.transports ?? []), now,
    );
  }

  advancePasskey(id: string, previousCounter: number, counter: number, now = Date.now()): boolean {
    return this.db.query("UPDATE passkeys SET counter = ?, lastUsedAt = ? WHERE id = ? AND counter = ?")
      .run(counter, now, id, previousCounter).changes === 1;
  }

  removePasskey(id: string, kid: string): boolean {
    return this.db.transaction(() => {
      const removed = this.db.query("DELETE FROM passkeys WHERE id = ? AND kid = ?").run(id, kid).changes > 0;
      if (removed) this.db.query("DELETE FROM browser_sessions WHERE passkeyId = ? AND kid = ?").run(id, kid);
      return removed;
    })();
  }
}
