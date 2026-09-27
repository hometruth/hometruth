import { DEFAULT_CAMERA_DNS_DOMAIN, NetworkAdapterError, type DnsTarget, type NetworkAdapter } from "./adapter";
import { commandOptionsFromEnv, createCommandAdapter } from "./command";
import { createManualAdapter } from "./manual";
import { createUniFiAdapter, uniFiOptionsFromEnv } from "./unifi";

export * from "./adapter";
export { createCommandAdapter, commandOptionsFromEnv, runNetworkCommand, type CommandAdapterOptions, type CommandResult, type CommandRunner } from "./command";
export { createManualAdapter } from "./manual";
export { createUniFiAdapter, uniFiOptionsFromEnv, UniFiClient, UniFiDnsOverride, UniFiWifiKick, UniFiInternetBlock, UniFiPacketCapture, captureScript, type DnsPolicy, type FirewallPolicy, type FirewallZone, type AccessPoint, type UniFiDnsApi, type UniFiFirewallApi, type UniFiAccessPointApi, type UniFiOptions, type UniFiWifiApi } from "./unifi";
export { DeviceNetworkRecovery, type DeviceNetworkRecoveryOptions, type DeviceNetworkTarget, type DeviceReconnectResult } from "./recovery";
export { PcapStreamDecoder, type PacketFact } from "./pcap-stream";
export { localAddressFor } from "./local-address";

export type NetworkAdapterName = "unifi" | "command" | "manual";

export const NETWORK_ADAPTER_NAMES: readonly NetworkAdapterName[] = ["unifi", "command", "manual"];

/**
 * Which adapter the environment asks for. `HOMETRUTH_NETWORK_ADAPTER` wins;
 * otherwise the command adapter when a script is configured, UniFi when an
 * API key is present, and manual otherwise.
 */
export function networkAdapterName(env: Record<string, string | undefined> = process.env): NetworkAdapterName {
  const requested = env.HOMETRUTH_NETWORK_ADAPTER?.trim().toLowerCase();
  if (requested) {
    if ((NETWORK_ADAPTER_NAMES as readonly string[]).includes(requested)) return requested as NetworkAdapterName;
    throw new NetworkAdapterError(`Unknown HOMETRUTH_NETWORK_ADAPTER "${requested}"; use one of ${NETWORK_ADAPTER_NAMES.join(", ")}`, "not_configured");
  }
  if (env.HOMETRUTH_NETWORK_COMMAND?.trim()) return "command";
  if (env.UNIFI_API_KEY?.trim()) return "unifi";
  return "manual";
}

export function createNetworkAdapter(env: Record<string, string | undefined> = process.env): NetworkAdapter {
  switch (networkAdapterName(env)) {
    case "unifi": return createUniFiAdapter(uniFiOptionsFromEnv(env));
    case "command": return createCommandAdapter(commandOptionsFromEnv(env));
    case "manual": return createManualAdapter();
  }
}

export interface DnsTargetOptions {
  /** LAN address of this server as seen by the cameras (the local emulator's advertised host). */
  readonly overrideIp?: string;
  readonly env?: Record<string, string | undefined>;
}

/**
 * The record HomeTruth manages. The domain comes from HOMETRUTH_CAMERA_DNS_DOMAIN
 * (default usce.mearicloud.com); the address from HOMETRUTH_LOCAL_CLOUD_ADDRESS,
 * else the address the local emulator advertises, which is detected from the
 * interface that shares the cameras' subnet.
 */
export function cameraDnsTarget(options: DnsTargetOptions = {}): DnsTarget {
  const env = options.env ?? process.env;
  return { domain: env.HOMETRUTH_CAMERA_DNS_DOMAIN?.trim() || DEFAULT_CAMERA_DNS_DOMAIN, overrideIp: hometruthLanAddress(options) };
}

/** The address DNS overrides point at: HOMETRUTH_LOCAL_CLOUD_ADDRESS, else the caller's detected address. */
export function hometruthLanAddress(options: DnsTargetOptions = {}): string {
  const env = options.env ?? process.env;
  const overrideIp = env.HOMETRUTH_LOCAL_CLOUD_ADDRESS?.trim() || options.overrideIp?.trim();
  if (!overrideIp) {
    throw new NetworkAdapterError(
      "The HomeTruth LAN address is unknown: bootstrap the local emulator or set HOMETRUTH_LOCAL_CLOUD_ADDRESS",
      "not_configured",
    );
  }
  return overrideIp;
}
