import { secretsFor, type SecretsFile } from "../config/secrets";

/** Keep network credentials/configuration independent of any device vendor. */
export function networkEnvironment(file: SecretsFile, env: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const unifi = secretsFor(file, "network", "unifi");
  const result = { ...env };
  for (const [key, variable] of Object.entries({ apiKey: "UNIFI_API_KEY", baseUrl: "UNIFI_BASE_URL", siteId: "UNIFI_SITE_ID",
    siteName: "UNIFI_SITE_NAME", sshUser: "UNIFI_SSH_USER", sshKeyPath: "UNIFI_SSH_KEY" })) {
    const value = unifi[key];
    if (typeof value === "string" && value.trim()) result[variable] = value.trim();
  }
  if (typeof unifi.skipTlsVerify === "boolean") result.UNIFI_SKIP_TLS_VERIFY = unifi.skipTlsVerify ? "1" : "0";
  return result;
}
