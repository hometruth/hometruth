import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { appendFileSync, existsSync, renameSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isIPv4 } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { initialState, type EmulatorState } from "./controller";

export const CLOUD_HOST = "a1nqxu0hki9zw3.iot.us-west-2.amazonaws.com";
export interface ZephyrConfig {
  format: 1;
  cloudHost: typeof CLOUD_HOST;
  deviceMac: string;
  deviceIp: string;
  listenIp: string;
  mqttPort: 8883;
  adminPort: number;
  adminToken: string;
  enrollFirstCertificate: boolean;
}
export const emulatorDirectory = (): string => resolve(process.env.ZEPHYR_EMULATOR_DIR ?? ".hometruth/zephyr-connect/emulator");

export async function savePrivate(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + "\n");
    await file.sync();
    await file.close();
    await rename(temporary, path);
  } finally {
    await file.close().catch(() => undefined);
    await rm(temporary, { force: true });
  }
}
export async function readConfig(directory: string): Promise<ZephyrConfig> {
  const config = JSON.parse(await readFile(join(directory, "config.json"), "utf8")) as ZephyrConfig;
  if (config.format !== 1 || config.cloudHost !== CLOUD_HOST || !isIPv4(config.deviceIp) || !isIPv4(config.listenIp)
    || config.deviceIp === config.listenIp || !/^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/.test(config.deviceMac)
    || config.mqttPort !== 8883 || !Number.isInteger(config.adminPort) || config.adminPort < 1024 || config.adminPort > 65535 || config.adminPort === config.mqttPort
    || !/^[a-f0-9]{64}$/.test(config.adminToken) || typeof config.enrollFirstCertificate !== "boolean") throw new Error("Invalid Zephyr emulator configuration");
  return config;
}
export async function readState(directory: string): Promise<EmulatorState> {
  try {
    const state = JSON.parse(await readFile(join(directory, "state.json"), "utf8")) as EmulatorState;
    if (state.format !== 1 || !state.shadow || !Number.isSafeInteger(state.shadow.version) || typeof state.deviceReported !== "object") throw new Error("Invalid persisted Zephyr state; preserve the file for inspection");
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return initialState();
    throw error;
  }
}

/** Private bounded packet journal; never records MQTT CONNECT credentials. */
export function privateAudit(directory: string): (event: string, data: Record<string, unknown>) => void {
  const path = join(directory, "traffic.jsonl");
  return (event, data) => {
    if (existsSync(path) && statSync(path).size >= 10 * 1024 * 1024) {
      for (let index = 3; index >= 1; index--) {
        const previous = `${path}.${index}`;
        if (existsSync(previous)) renameSync(previous, `${path}.${index + 1}`);
      }
      renameSync(path, `${path}.1`);
    }
    appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), event, ...data }) + "\n", { mode: 0o600 });
  };
}

async function openssl(directory: string, args: string[]): Promise<void> {
  const child = Bun.spawn(["openssl", ...args], { cwd: directory, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`OpenSSL failed: ${stderr.slice(-500)}`);
}

/** Offline preparation only. Does not listen, route traffic, or install a CA. */
export async function initialize(directory: string, deviceMac: string, deviceIp: string, listenIp: string): Promise<void> {
  if (!isIPv4(deviceIp) || !isIPv4(listenIp) || deviceIp === listenIp || !/^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/.test(deviceMac)) throw new Error("Supply device MAC, device IPv4, and this Mac's LAN IPv4");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  // Refuse to regenerate identities or reset enrollment over an existing setup.
  for (const name of ["config.json", "server.key", "server.crt", "state.json"]) {
    if (existsSync(join(directory, name))) throw new Error(`Existing ${name}; initialization will not overwrite it`);
  }
  const config: ZephyrConfig = { format: 1, cloudHost: CLOUD_HOST, deviceMac, deviceIp, listenIp, mqttPort: 8883, adminPort: 8890, adminToken: randomBytes(32).toString("hex"), enrollFirstCertificate: true };
  const extensions = join(directory, "server.cnf");
  await Bun.write(extensions, `[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=${CLOUD_HOST}\n[ext]\nsubjectAltName=DNS:${CLOUD_HOST},IP:${listenIp}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n`);
  await chmod(extensions, 0o600);
  const mask = process.umask(0o077);
  try {
    await openssl(directory, ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "server.key"]);
    await openssl(directory, ["req", "-new", "-x509", "-sha256", "-days", "365", "-key", "server.key", "-out", "server.crt", "-config", "server.cnf"]);
  } finally { process.umask(mask); }
  await savePrivate(join(directory, "config.json"), config);
  await savePrivate(join(directory, "state.json"), initialState());
}
