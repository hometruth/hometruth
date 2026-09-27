/**
 * The half of `ht` that is not about an install: the files and the hardware on
 * this machine. Reading a secret from the terminal, and finding and rebooting
 * a camera with no server in the way. Everything here is loaded lazily, so a
 * command that only talks to an install never pulls a vendor client in.
 */
import { DEFAULT_REBOOT_TIMEOUT_MS, rebootCamera, type CameraCloudAccount, type CameraIdentity } from "../models/recovery";

export { DEFAULT_REBOOT_TIMEOUT_MS };

/** A secret from the terminal: piped stdin when not a TTY, else a prompt with echo off. */
export async function readSecret(promptText: string): Promise<string> {
  if (!process.stdin.isTTY) return await Bun.stdin.text();
  process.stdout.write(promptText);
  process.stdin.setRawMode(true);
  let value = "";
  try {
    for await (const chunk of process.stdin) {
      for (const character of chunk.toString()) {
        if (character === "") throw new Error("Cancelled");
        if (character === "\r" || character === "\n") { process.stdout.write("\n"); return value; }
        if (character === "") value = value.slice(0, -1);
        else value += character;
      }
    }
  } finally {
    process.stdin.setRawMode(false);
  }
  return value;
}

/** The `--direct` reboot: the camera and the vendor cloud, no server. */
export async function directReboot(target: string, options: { locateOnly: boolean; timeoutMs: number }): Promise<string> {
  const [{ loadDevicesConfig }, { createCameraRecovery }, { LayeredCameraSetupStore }, { FileCameraInventoryStore }, { identityFromDeviceId }] = await Promise.all([
    import("../config/devices"),
    import("../vendors/tkenpro/camera-adapters"),
    import("../vendors/tkenpro/setup-store"),
    import("../vendors/tkenpro/inventory-store"),
    import("../vendors/tkenpro/camera-service"),
  ]);
  const IPV4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/u;
  let host = target;
  if (!IPV4.test(target)) {
    const config = await loadDevicesConfig(process.env.HOMETRUTH_DEVICES);
    const entry = (config.devices ?? []).find((candidate) => candidate.id === target);
    const configured = (entry?.config as { host?: unknown } | undefined)?.host;
    if (typeof configured !== "string") throw new Error(`No device ${target} in devices.yml; give its IP address instead`);
    host = configured;
  }
  const saved = await new LayeredCameraSetupStore().load().catch(() => undefined);
  const setup = saved?.setup;
  const credentials = {
    ...(setup?.onvifUsername ? { username: setup.onvifUsername } : {}),
    ...(setup?.onvifPassword ? { password: setup.onvifPassword } : {}),
  };
  const account: CameraCloudAccount | undefined = setup?.email && setup.password
    ? {
      email: setup.email,
      password: setup.password,
      ...(setup.profile ? { profile: setup.profile } : {}),
      ...(setup.countryCode ? { countryCode: setup.countryCode } : {}),
      ...(setup.phoneCode ? { phoneCode: setup.phoneCode } : {}),
    }
    : undefined;
  const inventory = await new FileCameraInventoryStore().load().catch(() => []);
  const record = inventory.find((camera) => camera.host === host && camera.serialNumber);
  const identity: CameraIdentity = record?.serialNumber
    ? { serialNumber: record.serialNumber }
    : identityFromDeviceId(inventory.find((camera) => camera.host === host)?.id ?? "");
  const recovery = createCameraRecovery();
  if (options.locateOnly) {
    try {
      const info = await recovery.probe(host, credentials);
      return `${host} answers ONVIF: ${[info.model, info.serialNumber ? `serial ${info.serialNumber}` : "", info.firmwareVersion ? `firmware ${info.firmwareVersion}` : ""].filter(Boolean).join(", ")}`;
    } catch (error) {
      if (!account || !recovery.locate) throw new Error(`${host} does not answer ONVIF and no saved app account can ask the vendor cloud where it is`);
      const location = await recovery.locate(identity, account);
      if (!location) throw new Error(`${host} does not answer ONVIF (${error instanceof Error ? error.message : String(error)}) and the vendor cloud does not list this camera`);
      return `${host} does not answer ONVIF; the vendor cloud says the camera is at ${location.host}${location.gateway ? ` (gateway ${location.gateway})` : ""}`;
    }
  }
  const outcome = await rebootCamera(recovery, { configuredHost: host, identity, credentials, ...(account ? { account } : {}) }, { timeoutMs: options.timeoutMs });
  return outcome.message;
}
