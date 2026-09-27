import { expect, test } from "bun:test";
import { hashSecret, KID_LENGTH, mintToken, parseToken, secretMatches, TOKEN_PREFIX } from "./token";

test("a minted token carries a hex key id and a base64url secret", () => {
  const minted = mintToken();
  const parsed = parseToken(minted.token);
  expect(parsed).toBeDefined();
  expect(parsed!.kid).toBe(minted.kid);
  expect(minted.token.startsWith(`${TOKEN_PREFIX}_`)).toBe(true);
  expect(minted.kid).toMatch(/^[0-9a-f]{32}$/u);
  expect(minted.kid.length).toBe(KID_LENGTH);
  expect(secretMatches(parsed!.secret, minted.secretHash)).toBe(true);
});

/**
 * The secret is base64url, whose alphabet includes the `_` used as the
 * separator. Splitting is unambiguous only because the key id cannot contain
 * one — this is the test that keeps that true.
 */
test("a secret containing the separator still parses back exactly", () => {
  const withUnderscores = Array.from({ length: 200 }, () => mintToken())
    .map(minted => parseToken(minted.token)!)
    .filter(parsed => parsed.secret.includes("_"));
  expect(withUnderscores.length).toBeGreaterThan(0);
  for (const parsed of withUnderscores) expect(parsed.kid).not.toContain("_");
});

test("anything that is not a token parses to nothing", () => {
  for (const value of ["", "ht_", "nonsense", "ht_xyz_abc", `ht_${"g".repeat(32)}_${"A".repeat(43)}`,
    `ht_${"a".repeat(31)}_${"A".repeat(43)}`, `ht_${"a".repeat(32)}_${"A".repeat(42)}`]) {
    expect(parseToken(value)).toBeUndefined();
  }
});

test("surrounding whitespace from a copy and paste is forgiven", () => {
  const minted = mintToken();
  expect(parseToken(`  ${minted.token}\n`)?.kid).toBe(minted.kid);
});

test("two tokens never collide, and a hash never reveals its secret", () => {
  const minted = Array.from({ length: 500 }, () => mintToken());
  expect(new Set(minted.map(token => token.kid)).size).toBe(500);
  expect(new Set(minted.map(token => token.token)).size).toBe(500);
  for (const token of minted.slice(0, 5)) {
    expect(token.secretHash).not.toContain(parseToken(token.token)!.secret);
    expect(token.token).not.toContain(token.secretHash);
  }
});

test("a secret one character out does not match", () => {
  const minted = mintToken();
  const secret = parseToken(minted.token)!.secret;
  expect(secretMatches(secret, minted.secretHash)).toBe(true);
  expect(secretMatches(secret.slice(0, -1) + (secret.endsWith("A") ? "B" : "A"), minted.secretHash)).toBe(false);
  expect(secretMatches(secret, hashSecret("something else"))).toBe(false);
});
