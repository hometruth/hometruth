// The standalone local cloud emulator, formerly scripts/run-local-cloud-emulator.ts.
// The standalone local cloud emulator, formerly scripts/run-local-cloud-emulator.ts.
import { MeariLocalCloudRuntime } from "../../protocols/tkenpro/local-cloud-runtime.ts";

function integerEnvironment(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be a valid port`);
  }
  return value;
}

/**
 * Run the local cloud emulator on its own (`ht hub`): the listeners the
 * cameras register with once the DNS override points the vendor hostname here.
 * Resolves when the process is told to stop.
 */
export async function runLocalCloudEmulator(): Promise<void> {
  const runtime = await MeariLocalCloudRuntime.create({
    authPath: process.env.HOMETRUTH_LOCAL_CLOUD_AUTH ?? ".hometruth/local-camera-auth.json",
    ...(process.env.HOMETRUTH_LOCAL_CLOUD_ADDRESS
      ? { advertisedHost: process.env.HOMETRUTH_LOCAL_CLOUD_ADDRESS }
      : {}),
    platformPort: integerEnvironment("HOMETRUTH_LOCAL_CLOUD_PORT", 18_665),
    dnsPort: integerEnvironment("HOMETRUTH_LOCAL_CLOUD_DNS_PORT", 18_661),
    rootPort: integerEnvironment("HOMETRUTH_LOCAL_CLOUD_ROOT_PORT", 9_253),
    nestedRootPort: integerEnvironment("HOMETRUTH_LOCAL_CLOUD_NESTED_ROOT_PORT", 9_255),
    onEvent: (event) => {
      if (event.type === "settings") {
        console.log(JSON.stringify({
          event: "settings",
          source: event.source,
          changedCodes: Object.keys(event.values).sort((left, right) => Number(left) - Number(right)),
        }));
      } else if (event.type === "registered" || event.type === "disconnected") {
        console.log(JSON.stringify({ event: event.type }));
      } else if (event.type === "protocol-error") {
        console.log(JSON.stringify({ event: "protocol-error", message: event.message }));
      }
    },
    onRootQuery: (port) => console.log(JSON.stringify({ event: "root-query", port })),
  });

  await runtime.start();
  console.log(JSON.stringify({
    phase: "ready",
    authorizedDevices: runtime.authorization.devices.length,
    platform: true,
    discoveryEndpoints: runtime.roots.length,
  }));
  if (process.env.HOMETRUTH_EMULATOR_VALIDATE_ONLY === "1") {
    await runtime.stop();
    console.log(JSON.stringify({ phase: "validated" }));
    return;
  }

  await new Promise<void>((resolve) => {
    const finish = (): void => resolve();
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
  await runtime.stop();
  console.log(JSON.stringify({ phase: "stopped" }));
}
