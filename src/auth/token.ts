/**
 * The token itself: how one is minted, written down, and checked.
 *
 * Shape is `ht_<kid>_<secret>`, the prefix-and-identifier form GitHub and
 * Stripe settled on. Each part earns its place:
 *
 * - `ht_` makes a leaked token recognisable on sight and greppable by secret
 *   scanners, so a token pasted into an issue can be found and revoked.
 * - `kid` is 128 bits of public key id, in hex. It is what the store looks a
 *   token up by, which keeps verification a single indexed read rather than a
 *   scan over every row hashing as it goes, and means a wrong token costs the
 *   same as a right one — there is no row count to learn from the clock. Hex
 *   rather than base64url precisely because `_` is the separator: with the id
 *   drawn from `[0-9a-f]` the split is unambiguous whatever the lengths are,
 *   instead of being correct only as long as nobody changes them.
 * - `secret` is 256 bits from the CSPRNG and is never written down anywhere.
 *   The store keeps `sha256(secret)`.
 *
 * SHA-256, not Argon2id, and that is deliberate rather than a shortcut. A
 * memory-hard KDF exists to make guessing a *low-entropy human* password
 * expensive. This secret is 256 uniform random bits: there is no dictionary,
 * and no amount of hardware closes a 2^256 gap. Argon2 here would only add
 * ~50 ms to every authenticated request — including each frame of an MJPEG
 * camera stream. (Bun.password is still the right tool if a human-chosen
 * password is ever added beside this; see the note in `guard.ts`.)
 */
import { randomBytes, timingSafeEqual } from "node:crypto";

/** Recognisable on sight, and the anchor a secret scanner matches on. */
export const TOKEN_PREFIX = "ht";
const KID_BYTES = 16;
const SECRET_BYTES = 32;
export const KID_LENGTH = KID_BYTES * 2;
/** base64url of N bytes, unpadded. */
const SECRET_LENGTH = Math.ceil((SECRET_BYTES * 8) / 6);

const TOKEN_PATTERN = new RegExp(`^${TOKEN_PREFIX}_([0-9a-f]{${KID_LENGTH}})_([A-Za-z0-9_-]{${SECRET_LENGTH}})$`, "u");

/** A newly minted token: the one and only time the full string exists. */
export interface MintedToken {
  /** The public half. Safe to log, display, and use to revoke. */
  readonly kid: string;
  /** `sha256(secret)`, base64url. What the store keeps. */
  readonly secretHash: string;
  /** The whole token, shown to the person once and never recoverable. */
  readonly token: string;
}

export function mintToken(): MintedToken {
  const kid = randomBytes(KID_BYTES).toString("hex");
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  return { kid, secretHash: hashSecret(secret), token: `${TOKEN_PREFIX}_${kid}_${secret}` };
}

export function hashSecret(secret: string): string {
  return new Bun.CryptoHasher("sha256").update(secret, "utf8").digest("base64url");
}

/** The two halves of a presented token, or undefined when it is not one at all. */
export function parseToken(presented: string): { kid: string; secret: string } | undefined {
  const match = TOKEN_PATTERN.exec(presented.trim());
  return match ? { kid: match[1]!, secret: match[2]! } : undefined;
}

/**
 * Whether a presented secret matches a stored hash, in time that does not
 * depend on how much of it was right. Both sides are fixed-length base64url of
 * a SHA-256 digest, so a length mismatch only ever means a corrupt row.
 */
export function secretMatches(presentedSecret: string, storedHash: string): boolean {
  const presented = Buffer.from(hashSecret(presentedSecret));
  const stored = Buffer.from(storedHash);
  return presented.length === stored.length && timingSafeEqual(presented, stored);
}
