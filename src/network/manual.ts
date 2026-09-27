/**
 * Manual network adapter: the DNS record is managed outside HomeTruth (router
 * UI, Pi-hole, /etc/hosts on a DNS server…). HomeTruth still reports which
 * side the cameras are on by resolving the hostname through the LAN gateway,
 * but it cannot switch the record or kick cameras off Wi-Fi.
 */
import type { NetworkAdapter } from "./adapter";

export function createManualAdapter(): NetworkAdapter {
  return { name: "manual" };
}
