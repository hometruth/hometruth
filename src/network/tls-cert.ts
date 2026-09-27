/**
 * A self-signed TLS certificate for the hostnames HomeTruth stands in for
 * while a device is isolated. A device that verifies certificates will
 * refuse it (and the isolation log shows the handshake attempts); one that
 * does not will talk to HomeTruth in plaintext behind the TLS, which is what
 * makes an HTTPS relay or emulator possible at all. Generated with the
 * system's `openssl` and cached, owner-only, under `.hometruth/tls/`; a new
 * hostname set gets a new certificate.
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface TlsCertificate {
  readonly key: string;
  readonly cert: string;
  readonly hostnames: readonly string[];
}

export async function selfSignedCertificate(hostnames: readonly string[], directory = ".hometruth/tls"): Promise<TlsCertificate> {
  const names = [...new Set(hostnames.map((name) => name.toLowerCase()))].sort();
  if (names.length === 0) throw new Error("A certificate needs at least one hostname");
  for (const name of names) {
    if (!/^[a-z0-9.-]{1,253}$/u.test(name)) throw new Error(`Refusing to put an oddly formed hostname "${name}" in a certificate`);
  }
  const base = resolve(directory);
  await mkdir(base, { recursive: true, mode: 0o700 });
  const stem = join(base, `standin-${createHash("sha256").update(names.join(",")).digest("hex").slice(0, 12)}`);
  const keyPath = `${stem}.key.pem`;
  const certPath = `${stem}.cert.pem`;
  try {
    return { key: await readFile(keyPath, "utf8"), cert: await readFile(certPath, "utf8"), hostnames: names };
  } catch {
    // Not generated yet.
  }
  const proc = Bun.spawn([
    "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "3650",
    "-keyout", keyPath, "-out", certPath,
    "-subj", `/CN=${names[0]}`,
    "-addext", `subjectAltName=${names.map((name) => `DNS:${name}`).join(",")}`,
  ], { stdout: "ignore", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) throw new Error(`openssl could not create the stand-in certificate: ${stderr.trim().split("\n").pop() ?? "unknown error"}`);
  await chmod(keyPath, 0o600);
  return { key: await readFile(keyPath, "utf8"), cert: await readFile(certPath, "utf8"), hostnames: names };
}
