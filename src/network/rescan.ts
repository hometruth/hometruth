/**
 * Find every configured device on the managed network by its MAC address and
 * report where it is now, whatever subnet DHCP put it on.
 *
 * A device that keeps its MAC in devices.yml is looked up by that MAC in
 * the gateway's client table, which spans every VLAN. A device without a saved
 * MAC cannot be followed when it moves; when it still answers at its
 * configured address and exactly one client is listed there, the rescan
 * learns that client's MAC so the next move can be followed.
 */
import { isIPv4 } from "node:net";
import type { NetworkAddressClient } from "./adapter";
import type { DeviceNetworkTarget } from "./recovery";

export type RescanOutcome =
  /** The device is where devices.yml says it is. */
  | "unchanged"
  /** The device answers at a different address now; devices.yml should follow it. */
  | "moved"
  /** The device had no saved MAC; it answered at its address and the client there is now its identity. */
  | "identified"
  /** The gateway does not list the device (by MAC) right now, or lists it without a usable address. */
  | "missing"
  /** No saved MAC, and either nothing is at the configured address or the device does not answer there. */
  | "unidentified"
  /** No saved MAC, and more than one client is listed at the configured address. */
  | "ambiguous"
  /** The move or identity could not be written; `detail` says why. */
  | "failed";

export interface RescanResult {
  readonly deviceId: string;
  readonly name: string;
  readonly outcome: RescanOutcome;
  /** The address devices.yml held before the rescan. */
  readonly address: string;
  /** Where the gateway sees the device now, when it differs. */
  readonly currentAddress?: string;
  readonly mac?: string;
  /** Network or SSID name from the gateway, when it reports one. */
  readonly network?: string;
  /** Plain-language reason, for the CLI and logs; the web UI composes its own copy from the fields. */
  readonly detail: string;
}

function usable(address: string | undefined): address is string {
  return typeof address === "string" && isIPv4(address) && !address.startsWith("169.254.");
}

function networkOf(client: NetworkAddressClient): string | undefined {
  return client.network ?? client.ssid;
}

/** Decide a device's outcome from the client table alone. `undefined` means the device must be probed at its configured address first. */
export function locateByMac(target: DeviceNetworkTarget, clients: readonly NetworkAddressClient[]): RescanResult | undefined {
  const base = { deviceId: target.id, name: target.name, address: target.address };
  if (!target.mac) return undefined;
  const mac = target.mac.toLowerCase();
  const client = clients.find((row) => row.mac === mac);
  if (!client || client.connected === false) return { ...base, mac, outcome: "missing", detail: `${target.name} (MAC ${mac}) is not on the network right now; ${target.address} is unchanged` };
  const network = networkOf(client);
  if (!usable(client.address)) {
    return { ...base, mac, ...(network ? { network } : {}), outcome: "missing", detail: `${target.name} (MAC ${mac}) is on the network without a usable address (${client.address}); ${target.address} is unchanged` };
  }
  if (client.address === target.address) return { ...base, mac, ...(network ? { network } : {}), outcome: "unchanged", detail: `${target.name} is at ${target.address}` };
  return {
    ...base,
    mac,
    currentAddress: client.address,
    ...(network ? { network } : {}),
    outcome: "moved",
    detail: `${target.name} moved from ${target.address} to ${client.address}${network ? ` (${network})` : ""}`,
  };
}

/** Rescan every target. `answers(id)` resolves true when the device responds at its configured address; it is only consulted for devices without a saved MAC. */
export async function rescanDevices(
  targets: readonly DeviceNetworkTarget[],
  clients: readonly NetworkAddressClient[],
  answers: (deviceId: string) => Promise<boolean>,
): Promise<RescanResult[]> {
  const results: RescanResult[] = [];
  for (const target of targets) {
    const byMac = locateByMac(target, clients);
    if (byMac) { results.push(byMac); continue; }
    const base = { deviceId: target.id, name: target.name, address: target.address };
    const candidates = clients.filter((row) => row.connected !== false && row.address === target.address);
    if (candidates.length === 0) {
      results.push({ ...base, outcome: "unidentified", detail: `${target.name} has no saved MAC and nothing is listed at ${target.address}; when it is back, save its MAC on its Settings tab` });
      continue;
    }
    if (candidates.length > 1) {
      results.push({ ...base, outcome: "ambiguous", detail: `${target.name} has no saved MAC and ${candidates.length} clients are listed at ${target.address}; choose it on its Settings tab` });
      continue;
    }
    const client = candidates[0]!;
    const network = networkOf(client);
    if (!(await answers(target.id))) {
      results.push({ ...base, ...(network ? { network } : {}), outcome: "unidentified", detail: `A client (${client.mac}) is listed at ${target.address} but ${target.name} does not answer there, so no MAC was saved` });
      continue;
    }
    results.push({ ...base, mac: client.mac, ...(network ? { network } : {}), outcome: "identified", detail: `${target.name} answered at ${target.address}; saved MAC ${client.mac} so future moves can be followed` });
  }
  return results;
}

/** One line for logs and the CLI. */
export function summarizeRescan(results: readonly RescanResult[]): string {
  const count = (outcome: RescanOutcome) => results.filter((result) => result.outcome === outcome).length;
  const parts = [
    `${count("moved")} moved`,
    `${count("identified")} identified`,
    `${count("missing")} missing`,
    ...(count("unidentified") + count("ambiguous") > 0 ? [`${count("unidentified") + count("ambiguous")} without a usable MAC`] : []),
    ...(count("failed") > 0 ? [`${count("failed")} failed`] : []),
  ];
  return `Rescanned ${results.length} device${results.length === 1 ? "" : "s"}: ${parts.join(", ")}`;
}
