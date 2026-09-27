import { expect, test } from "bun:test";
import { TokenStore } from "./store";
import type { TokenCreate } from "./model";
import { parseToken } from "./token";

const create: TokenCreate = { name: "Test", permissions: ["read"], subject: { all: true } };

test("an issued token verifies, and nothing else does", () => {
  const store = new TokenStore();
  const { token, record } = store.issue({ ...create });
  expect(store.verify(token)).toEqual({ ok: true, token: store.get(record.kid)! });
  expect(store.verify("rubbish")).toEqual({ ok: false, reason: "malformed" });
  expect(store.verify(`ht_${"0".repeat(32)}_${"A".repeat(43)}`)).toEqual({ ok: false, reason: "unknown" });
});

test("a real key id with the wrong secret is unknown, not admitted", () => {
  const store = new TokenStore();
  const { token } = store.issue({ ...create });
  const kid = parseToken(token)!.kid;
  expect(store.verify(`ht_${kid}_${"A".repeat(43)}`)).toEqual({ ok: false, reason: "unknown" });
});

test("the secret is never stored, listed, or returned", () => {
  const store = new TokenStore();
  const { token, record } = store.issue({ ...create });
  const secret = parseToken(token)!.secret;
  expect(JSON.stringify(record)).not.toContain(secret);
  expect(JSON.stringify(store.list())).not.toContain(secret);
  expect(JSON.stringify(store.get(record.kid))).not.toContain(secret);
});

test("revocation is a tombstone: the token dies, the record stays", () => {
  const store = new TokenStore();
  const { token, record } = store.issue({ ...create });
  store.revoke(record.kid);
  expect(store.verify(token)).toEqual({ ok: false, reason: "revoked" });
  expect(store.list().map(entry => entry.kid)).toEqual([record.kid]);
  expect(store.get(record.kid)?.revokedAt).toBeString();
  // Revoking twice is not an error, and does not move the tombstone.
  const first = store.get(record.kid)!.revokedAt;
  expect(store.revoke(record.kid).revokedAt).toBe(first!);
});

test("expiry is checked against the clock it is given", () => {
  const store = new TokenStore();
  const { token } = store.issue({ ...create, expiresAt: "2030-01-01T00:00:00.000Z" });
  expect(store.verify(token, new Date("2029-12-31T23:59:59Z")).ok).toBe(true);
  expect(store.verify(token, new Date("2030-01-01T00:00:01Z"))).toEqual({ ok: false, reason: "expired" });
});

test("last use is recorded, then throttled so a stream is not a write loop", () => {
  const store = new TokenStore();
  const { record } = store.issue({ ...create });
  const start = new Date("2026-01-01T12:00:00.000Z");
  store.touch(record.kid, "10.0.0.5", start);
  expect(store.get(record.kid)?.lastUsedAt).toBe(start.toISOString());
  expect(store.get(record.kid)?.lastUsedFrom).toBe("10.0.0.5");

  store.touch(record.kid, "10.0.0.9", new Date(start.getTime() + 30_000));
  expect(store.get(record.kid)?.lastUsedFrom).toBe("10.0.0.5");

  const later = new Date(start.getTime() + 61_000);
  store.touch(record.kid, "10.0.0.9", later);
  expect(store.get(record.kid)?.lastUsedAt).toBe(later.toISOString());
});

test("a usable token is one that is neither revoked nor expired", () => {
  const store = new TokenStore();
  expect(store.hasUsableToken()).toBe(false);
  const { record } = store.issue({ ...create });
  expect(store.hasUsableToken()).toBe(true);
  store.revoke(record.kid);
  expect(store.hasUsableToken()).toBe(false);
  store.issue({ ...create, expiresAt: "2020-01-01T00:00:00.000Z" });
  expect(store.hasUsableToken()).toBe(false);
});

test("a subject survives the round trip through the database intact", () => {
  const store = new TokenStore();
  const subject = { criteria: { room: "Kitchen", tagIds: ["3f1c9c56-7f0f-4a0e-9f4f-1d2e3a4b5c6d"] } };
  const { record } = store.issue({ name: "kitchen", permissions: ["write"], subject });
  expect(store.get(record.kid)?.subject).toEqual(subject);
  expect(store.get(record.kid)?.permissions).toEqual(["write"]);
});
