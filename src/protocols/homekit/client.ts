import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isSafeCameraUri } from "../../camera-media";
import type { PairingData } from "hap-controller/lib/protocol/pairing-protocol";
import { parseAccessories, type HapSnapshot } from "./snapshot";

export type { PairingData };
export interface HomeKitAddress { host: string; port: number; homekitId: string }

export function validateAddress(address: HomeKitAddress): void {
  if (!/^[A-Za-z0-9.-]+$/.test(address.host) || !isSafeCameraUri(`http://${address.host}/`)
    || !Number.isInteger(address.port) || address.port < 1 || address.port > 65535
    || !/^(?:[A-Fa-f0-9]{2}:){5}[A-Fa-f0-9]{2}$/.test(address.homekitId)) throw new Error("Invalid local HomeKit address");
}

export function isPairingData(value: unknown): value is PairingData {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return ["AccessoryPairingID", "iOSDevicePairingID"].every((key) => typeof p[key] === "string" && /^[0-9a-f]+$/i.test(p[key] as string) && (p[key] as string).length % 2 === 0)
    && ["AccessoryLTPK", "iOSDeviceLTPK"].every((key) => typeof p[key] === "string" && /^[0-9a-f]{64}$/i.test(p[key] as string))
    && typeof p.iOSDeviceLTSK === "string" && /^[0-9a-f]{128}$/i.test(p.iOSDeviceLTSK);
}

export function homeKitOperation(address: HomeKitAddress, operation: { operation: "read"; pairing: PairingData } | { operation: "pair"; pin: string }): Promise<unknown> {
  validateAddress(address);
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [fileURLToPath(new URL("./worker.ts", import.meta.url))], {
      timeout: operation.operation === "pair" ? 30_000 : 2500,
      killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024,
      // HAP debug logging contains cryptographic material. Never inherit it.
      env: { ...process.env, DEBUG: "" },
    }, (error, stdout) => {
      if (error) return reject(new Error("HomeKit connection failed; check the address and pairing"));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error("Invalid HomeKit response")); }
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify({ ...address, ...operation }));
  });
}

export async function readHomeKit(address: HomeKitAddress, pairing: PairingData): Promise<HapSnapshot> {
  return parseAccessories(await homeKitOperation(address, { operation: "read", pairing }));
}
