import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { BridgeIdentity } from "./discovery";

export interface ProxyStorage { identity: BridgeIdentity; keys: Record<string, string>; labels?: Record<string, string> }
export async function privateJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temp, path);
  await chmod(path, 0o600);
}
export async function loadStorage(directory: string): Promise<ProxyStorage> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "bridge.json");
  try {
    const stored = JSON.parse(await readFile(path, "utf8")) as ProxyStorage;
    if (!/^[0-9a-f]{16}$/iu.test(stored.identity?.bridgeId) || !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/iu.test(stored.identity.mac) || !/^[0-9a-f-]{36}$/iu.test(stored.identity.uuid) || !stored.keys || typeof stored.keys !== "object") throw new Error("Invalid saved Hue proxy identity");
    for (const [identity, key] of Object.entries(stored.keys)) if (!identity || /[\r\n\0]/u.test(identity) || !/^[a-f\d]{32}$/iu.test(key)) throw new Error("Invalid saved Hue proxy key");
    // Names are cosmetic (a client's own devicetype), so a bad one is dropped, never fatal to a working pairing.
    if (stored.labels && typeof stored.labels === "object") for (const [id, label] of Object.entries(stored.labels)) if (!Object.hasOwn(stored.keys, id) || typeof label !== "string" || /[\r\n\0]/u.test(label)) delete stored.labels[id];
    return stored;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const mac = `02${randomBytes(5).toString("hex")}`;
  const stored = { identity: { bridgeId: `${mac.slice(0, 6)}fffe${mac.slice(6)}`.toUpperCase(), mac: mac.match(/../gu)!.join(":"), uuid: `2f402f80-da50-11e1-9b23-${mac}` }, keys: {} };
  await privateJson(path, stored);
  return stored;
}
export async function ensureCertificate(directory: string, bridgeId: string, address: string): Promise<{ cert: string; key: string }> {
  const cert = join(directory, "certificate.pem"), key = join(directory, "private-key.pem");
  const marker = join(directory, "certificate-address.txt");
  if (!await Bun.file(cert).exists() || !await Bun.file(key).exists() || await Bun.file(marker).text().catch(() => "") !== address) {
    const process = Bun.spawn(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "3650", "-subj", `/C=NL/O=HomeTruth/CN=${bridgeId.toLowerCase()}`, "-set_serial", `0x${bridgeId}`, "-addext", `subjectAltName=IP:${address},DNS:${bridgeId.toLowerCase()}`, "-keyout", key, "-out", cert], { stdout: "ignore", stderr: "ignore" });
    if (await process.exited !== 0) throw new Error("Could not generate the Hue proxy certificate; install OpenSSL 3");
    await chmod(key, 0o600);
    await writeFile(marker, address, { mode: 0o600 });
  }
  return { cert, key };
}
