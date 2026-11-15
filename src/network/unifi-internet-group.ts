import { createHash } from "node:crypto";
import { NetworkAdapterError, type InternetGroupAdapter, type InternetGroupTarget } from "./adapter";
import type { FirewallPolicy, UniFiFirewallApi } from "./unifi";
import { validAdmissionMac } from "./wifi-admission";

function identity(target: InternetGroupTarget) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/u.test(target.id)
    || target.macs.length < 1 || target.macs.length > 100 || target.macs.some(mac => !validAdmissionMac(mac))) {
    throw new NetworkAdapterError("An internet switch needs a stable id and 1–100 valid client MAC addresses", "not_configured");
  }
  const macs = [...new Set(target.macs.map(mac => mac.toLowerCase()))].sort();
  if (macs.length !== target.macs.length) throw new NetworkAdapterError("Internet switch MAC addresses must be unique", "not_configured");
  return {
    name: `hometruth-access ${createHash("sha256").update(target.id).digest("hex").slice(0, 32)}`,
    description: `HomeTruth internet access switch: ${target.id}`,
    macs,
  };
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => Array.isArray(item) ? [...item].sort()
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}

/** One dedicated BLOCK policy; never enables/disables another feature's rules. */
export class UniFiInternetGroup implements InternetGroupAdapter {
  constructor(private readonly api: UniFiFirewallApi) {}

  private async find(target: InternetGroupTarget): Promise<FirewallPolicy | undefined> {
    const key = identity(target);
    const matches = (await this.api.listFirewallPolicies()).filter(policy => policy.name === key.name);
    if (matches.length > 1) throw new NetworkAdapterError("Duplicate internet-switch firewall policies", "gateway_error");
    const policy = matches[0];
    if (policy && policy.description !== key.description) {
      throw new NetworkAdapterError("Internet-switch policy identity conflicts with an existing rule", "gateway_error");
    }
    return policy;
  }

  private async rule(target: InternetGroupTarget, enabled: boolean): Promise<FirewallPolicy> {
    const key = identity(target);
    const zones = await this.api.listFirewallZones();
    const zone = (name: string) => {
      const matches = zones.filter(zone => zone.name?.toLowerCase() === name);
      if (matches.length !== 1 || !matches[0]?.id) throw new NetworkAdapterError("Internet switches require unique Internal and External firewall zones", "not_supported");
      return matches[0].id;
    };
    return {
      name: key.name, description: key.description, enabled, action: { type: "BLOCK" },
      source: { zoneId: zone("internal"), trafficFilter: { type: "MAC_ADDRESS", macAddressFilter: { macAddresses: key.macs } } },
      destination: { zoneId: zone("external") },
      ipProtocolScope: { ipVersion: "IPV4_AND_IPV6" }, loggingEnabled: true,
    };
  }

  async describe(target: InternetGroupTarget): Promise<"on" | "off"> {
    const policy = await this.find(target);
    if (!policy || policy.enabled === false) return "on";
    const expected = await this.rule(target, true);
    for (const field of ["enabled", "source", "destination", "action", "ipProtocolScope"]) {
      if (canonical(policy[field]) !== canonical(expected[field])) {
        throw new NetworkAdapterError("Internet-switch rule does not cover the configured clients and both IP versions", "gateway_error");
      }
    }
    return "off";
  }

  async setAccess(target: InternetGroupTarget, allowed: boolean): Promise<void> {
    const policy = await this.find(target);
    if (!policy && allowed) return;
    const desired = await this.rule(target, !allowed);
    if (policy) {
      if (!policy.id) throw new NetworkAdapterError("Internet-switch policy has no id", "gateway_error");
      await this.api.setFirewallPolicy({ ...desired, id: policy.id }, !allowed);
    } else {
      await this.api.createFirewallPolicy(desired);
    }
    if (await this.describe(target) !== (allowed ? "on" : "off")) {
      throw new NetworkAdapterError("Router did not confirm the requested internet-switch state", "gateway_error");
    }
  }
}
