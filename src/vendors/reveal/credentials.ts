import type { RevealCredentials } from "../../protocols/reveal/client";

/** Prefer an explicit device account; never mix credentials from different sources. */
export function revealCredentials(
  secrets: Readonly<Record<string, unknown>> = {},
  env: Record<string, string | undefined> = process.env,
): RevealCredentials {
  if (secrets.email !== undefined || secrets.password !== undefined) {
    return {
      email: typeof secrets.email === "string" ? secrets.email : "",
      password: typeof secrets.password === "string" ? secrets.password : "",
    };
  }
  // TATACAM is an existing operator spelling, retained as a supported alias.
  const prefix = env.REVEAL_TACTACAM_USER !== undefined || env.REVEAL_TACTACAM_PASSWORD !== undefined
    ? "REVEAL_TACTACAM" : "REVEAL_TATACAM";
  return { email: env[`${prefix}_USER`] ?? "", password: env[`${prefix}_PASSWORD`] ?? "" };
}
