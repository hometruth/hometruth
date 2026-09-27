import type { DnsPolicy, UniFiDnsApi } from "../../network/unifi";
import { CLOUD_HOST, type ZephyrConfig } from "./files";

export interface RouteReceipt {
  domain: string;
  ip: string;
  policyId: string | null;
  previousEnabled: boolean;
  created: boolean;
  phase: "prepared" | "active";
}
interface RoutingOptions {
  api: UniFiDnsApi;
  config: ZephyrConfig;
  load(): Promise<RouteReceipt | null>;
  save(receipt: RouteReceipt | null): Promise<void>;
  /** Checks the already-running listener and the live MAC-to-IP mapping. */
  preflight(): Promise<void>;
  verifyResolution(): Promise<void>;
}
function id(policy: DnsPolicy): string {
  const value = policy.id ?? policy._id;
  if (typeof value !== "string" || !value) throw new Error("DNS policy has no ID");
  return value;
}
export class ZephyrRouting {
  constructor(private readonly options: RoutingOptions) {}
  private async policy(): Promise<DnsPolicy | undefined> {
    const policies = (await this.options.api.listDnsPolicies()).filter(p => p.domain?.toLowerCase().replace(/\.$/, "") === CLOUD_HOST);
    if (policies.length > 1) throw new Error("Multiple policies for the Zephyr hostname; refusing to alter them");
    const policy = policies[0];
    if (policy && (!["A", "A_RECORD"].includes(policy.type?.toUpperCase() ?? "") || policy.ipv4Address !== this.options.config.listenIp)) throw new Error("An existing DNS policy conflicts with this emulator");
    return policy;
  }
  private validate(receipt: RouteReceipt): void {
    if (receipt.domain !== CLOUD_HOST || receipt.ip !== this.options.config.listenIp) throw new Error("Routing receipt belongs to another configuration; preserve it for recovery");
    if (typeof receipt.previousEnabled !== "boolean" || typeof receipt.created !== "boolean" || !["prepared", "active"].includes(receipt.phase)
      || (receipt.policyId !== null && (typeof receipt.policyId !== "string" || !receipt.policyId))) throw new Error("Invalid routing receipt; preserve it for recovery");
  }
  async status() { return { receipt: await this.options.load(), policy: await this.policy() ?? null }; }
  async on(): Promise<void> {
    await this.options.preflight();
    let policy = await this.policy();
    let receipt = await this.options.load();
    if (receipt) {
      this.validate(receipt);
      if (receipt.policyId && (!policy || id(policy) !== receipt.policyId)) throw new Error("DNS policy changed outside this emulator");
    } else {
      if (policy?.enabled !== false && policy) throw new Error("This DNS override was already enabled elsewhere; refusing to take ownership");
      receipt = { domain: CLOUD_HOST, ip: this.options.config.listenIp, policyId: policy ? id(policy) : null, previousEnabled: policy ? policy.enabled !== false : false, created: !policy, phase: "prepared" };
      // Write recovery information before changing the gateway.
      await this.options.save(receipt);
    }
    if (!policy) await this.options.api.createPolicy(CLOUD_HOST, this.options.config.listenIp);
    else if (policy.enabled === false) await this.options.api.setPolicy(policy, true);
    policy = await this.policy();
    if (!policy || policy.enabled === false) throw new Error("Could not verify the DNS override; recovery receipt retained");
    await this.options.save({ ...receipt, policyId: id(policy), phase: "active" });
    await this.options.verifyResolution();
  }
  async off(): Promise<void> {
    const receipt = await this.options.load();
    if (!receipt) return;
    this.validate(receipt);
    let policy = await this.policy();
    if (receipt.policyId && policy && id(policy) !== receipt.policyId) throw new Error("DNS policy identity changed; refusing to alter it");
    if (policy) {
      await this.options.api.setPolicy(policy, receipt.previousEnabled);
      policy = await this.policy();
      if (policy && (policy.enabled !== false) !== receipt.previousEnabled) throw new Error("Could not verify DNS restoration");
    }
    // Newly created records remain disabled, so normal public DNS resumes.
    await this.options.save(null);
  }
}
