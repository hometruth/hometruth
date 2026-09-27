/** Defense in depth for configuration that may be committed to a private repo. */
export function assertCredentialFree(value: unknown, path = "config"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertCredentialFree(item, `${path}[${index}]`));
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      // Environment variable *names* are references, never credential values.
      const reference = /^(applicationKey|clientKey|password|username|token)Env$/.test(key);
      if (reference) {
        if (typeof item !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(item)) throw new Error(`${path}.${key} must name an environment variable`);
      } else if (/password|passwd|passphrase|secret|token|authorization|api.?key|application.?key|client.?key|private.?key|host.?key|pairing.?code|setup.?code|credential|^psk$/i.test(key)) {
        throw new Error(`${path}.${key}: credentials belong in secret storage, never versioned config`);
      }
      assertCredentialFree(item, `${path}.${key}`);
    }
  } else if (typeof value === "string") {
    // Also reject credentials hidden in URLs (including signed query strings).
    for (const match of value.matchAll(/[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi)) {
      let url: URL;
      try { url = new URL(match[0]); } catch { continue; }
      if (url.username || url.password || [...url.searchParams.keys()].some(key => /key|secret|token|auth|signature|credential|password|^sig$|^code$/i.test(key))) {
        throw new Error(`${path}: credential-bearing URLs belong in secret storage`);
      }
    }
    if (/-----BEGIN .*PRIVATE KEY-----/.test(value)) throw new Error(`${path}: private keys belong in secret storage`);
  }
}
