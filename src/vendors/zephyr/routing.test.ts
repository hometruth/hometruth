import { expect, test } from "bun:test";
import { ZephyrRouting, type RouteReceipt } from "./routing";
import { CLOUD_HOST, type ZephyrConfig } from "./files";
import type { DnsPolicy } from "../../network/unifi";

function fixture(initial: DnsPolicy[] = []) {
  let policies = structuredClone(initial);
  let receipt: RouteReceipt | null = null;
  const config: ZephyrConfig = { format: 1, cloudHost: CLOUD_HOST, deviceIp: "192.0.2.2", listenIp: "192.0.2.1", deviceMac: "aa:bb:cc:dd:ee:ff", mqttPort: 8883, adminPort: 8890, adminToken: "a".repeat(64), enrollFirstCertificate: true };
  let writes = 0;
  const api = {
    listDnsPolicies: async () => structuredClone(policies),
    createPolicy: async (domain: string, ipv4Address: string) => { expect(receipt?.phase).toBe("prepared"); writes++; policies.push({ id: "new", type: "A_RECORD", enabled: true, domain, ipv4Address }); },
    setPolicy: async (policy: DnsPolicy, enabled: boolean) => { writes++; policies = policies.map(p => p.id === policy.id ? { ...p, enabled } : p); },
  };
  const options = { api, config, load: async () => receipt, save: async (value: RouteReceipt | null) => { receipt = value; }, preflight: async () => {}, verifyResolution: async () => {} };
  return { routing: new ZephyrRouting(options), options, get receipt() { return receipt; }, get policies() { return policies; }, get writes() { return writes; } };
}
test("routes only after listener/MAC preflight and records recovery before mutation", async () => {
  const f = fixture();
  f.options.preflight = async () => { throw new Error("listener not running"); };
  await expect(f.routing.on()).rejects.toThrow("listener not running");
  expect(f.writes).toBe(0);
  expect(f.receipt).toBeNull();
  f.options.preflight = async () => {};
  await f.routing.on();
  expect(f.receipt?.phase).toBe("active");
  expect(f.policies[0]?.enabled).toBe(true);
  await f.routing.on();
  expect(f.writes).toBe(1);
  await f.routing.off();
  expect(f.policies[0]?.enabled).toBe(false);
  expect(f.receipt).toBeNull();
});
test("preserves unrelated DNS and restores an existing disabled record", async () => {
  const unrelated = { id: "other", type: "A_RECORD", domain: "example.test", ipv4Address: "192.0.2.9", enabled: true };
  const f = fixture([unrelated, { id: "hood", type: "A_RECORD", domain: CLOUD_HOST, ipv4Address: "192.0.2.1", enabled: false, ttlSeconds: 12 }]);
  await f.routing.on();
  await f.routing.off();
  expect(f.policies[0]).toEqual(unrelated);
  expect(f.policies[1]).toMatchObject({ id: "hood", enabled: false, ttlSeconds: 12 });
});
test("refuses conflicting, duplicate, or externally owned active DNS", async () => {
  for (const policies of [
    [{ id: "x", type: "A_RECORD", domain: CLOUD_HOST, ipv4Address: "192.0.2.20", enabled: true }],
    [{ id: "x", type: "A_RECORD", domain: CLOUD_HOST, ipv4Address: "192.0.2.1", enabled: true }],
    [1, 2].map(i => ({ id: String(i), type: "A_RECORD", domain: CLOUD_HOST, ipv4Address: "192.0.2.1", enabled: false })),
  ]) {
    const f = fixture(policies);
    await expect(f.routing.on()).rejects.toThrow();
    expect(f.writes).toBe(0);
  }
});
test("recovers if gateway applied the mutation but its response was lost", async () => {
  const f = fixture();
  const create = f.options.api.createPolicy;
  f.options.api.createPolicy = async (...args) => { await create(...args); throw new Error("response lost"); };
  await expect(f.routing.on()).rejects.toThrow("response lost");
  expect(f.receipt?.phase).toBe("prepared");
  await f.routing.off();
  expect(f.policies[0]?.enabled).toBe(false);
  expect(f.receipt).toBeNull();
});
test("retains the receipt if restoration fails or ownership changed", async () => {
  const f = fixture();
  await f.routing.on();
  f.options.api.setPolicy = async () => { throw new Error("gateway offline"); };
  await expect(f.routing.off()).rejects.toThrow("gateway offline");
  expect(f.receipt?.phase).toBe("active");
  f.options.api.listDnsPolicies = async () => [{ id: "replaced", type: "A_RECORD", domain: CLOUD_HOST, ipv4Address: "192.0.2.1", enabled: true }];
  await expect(f.routing.off()).rejects.toThrow("identity changed");
  expect(f.receipt).not.toBeNull();
});
test("checks effective gateway DNS and retains a rollback receipt on mismatch", async () => {
  const f = fixture();
  f.options.verifyResolution = async () => { throw new Error("DNS mismatch"); };
  await expect(f.routing.on()).rejects.toThrow("DNS mismatch");
  expect(f.receipt?.phase).toBe("active");
  await f.routing.off();
  expect(f.policies[0]?.enabled).toBe(false);
});
