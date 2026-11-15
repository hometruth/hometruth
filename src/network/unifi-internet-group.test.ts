import { expect, test } from "bun:test";
import { UniFiInternetGroup } from "./unifi-internet-group";
import { UniFiClient, type FirewallPolicy, type UniFiFirewallApi } from "./unifi";
import { InternetAccessSwitch } from "../devices/switches/internet-access";
import { Site } from "../site";
import { createApp } from "../server/app";

const target = { id: "study-internet", macs: ["02:00:00:00:00:11", "02:00:00:00:00:22"] };
function fixture() {
  const policies: FirewallPolicy[] = [{ id: "other", name: "video restriction", enabled: true }];
  let writes = 0;
  const api: UniFiFirewallApi = {
    async listFirewallPolicies() { return structuredClone(policies); },
    async listFirewallZones() { return [{ id: "inside", name: "Internal" }, { id: "outside", name: "External" }]; },
    async createFirewallPolicy(policy) { writes++; policies.push({ ...structuredClone(policy), id: "group" }); },
    async setFirewallPolicy(policy, enabled) {
      writes++;
      const index = policies.findIndex(item => item.id === policy.id);
      policies[index] = { ...structuredClone(policy), enabled };
    },
  };
  return { policies, api, adapter: new UniFiInternetGroup(api), writes: () => writes };
}

test("pauses all identities in one policy and restores only that policy", async () => {
  const f = fixture();
  expect(await f.adapter.describe(target)).toBe("on");
  expect(f.writes()).toBe(0);
  await f.adapter.setAccess(target, false);
  expect(await f.adapter.describe(target)).toBe("off");
  expect(f.policies[1]?.source?.trafficFilter?.macAddressFilter?.macAddresses).toEqual(target.macs);
  expect(f.policies[1]?.destination).toEqual({ zoneId: "outside" });
  expect(f.policies[1]?.ipProtocolScope).toEqual({ ipVersion: "IPV4_AND_IPV6" });
  await f.adapter.setAccess(target, true);
  expect(await f.adapter.describe(target)).toBe("on");
  expect(f.policies[0]).toEqual({ id: "other", name: "video restriction", enabled: true });
});

test("does not report a partial or changed group as fully paused", async () => {
  const f = fixture();
  await f.adapter.setAccess(target, false);
  f.policies[1]!.source!.trafficFilter!.macAddressFilter!.macAddresses = [target.macs[0]!];
  await expect(f.adapter.describe(target)).rejects.toThrow("does not cover");
  await f.adapter.setAccess(target, false);
  expect(await f.adapter.describe(target)).toBe("off");
});

test("rejects duplicate rules and leaves conflicting policy ownership untouched", async () => {
  const f = fixture();
  await f.adapter.setAccess(target, false);
  f.policies[1]!.description = "owned elsewhere";
  const writes = f.writes();
  await expect(f.adapter.setAccess(target, true)).rejects.toThrow("conflicts");
  expect(f.writes()).toBe(writes);
  f.policies[1]!.description = `HomeTruth internet access switch: ${target.id}`;
  f.policies.push({ ...f.policies[1]!, id: "duplicate" });
  await expect(f.adapter.setAccess(target, true)).rejects.toThrow("Duplicate");
});

test("rejects invalid identities and verifies router writes rather than remembering commands", async () => {
  const f = fixture();
  await expect(f.adapter.setAccess({ ...target, macs: ["ff:ff:ff:ff:ff:ff"] }, false)).rejects.toThrow("valid client MAC");
  f.api.createFirewallPolicy = async () => {};
  await expect(f.adapter.setAccess(target, false)).rejects.toThrow("did not confirm");
  expect(await f.adapter.describe(target)).toBe("on");
});

test("serializes rapid toggles and recovers its queue after a failed action", async () => {
  const f = fixture();
  const sw = new InternetAccessSwitch(target.id, target, () => f.adapter);
  await Promise.all([sw.toggle(), sw.toggle()]);
  expect(await sw.getState()).toBe("on");
  const save = f.api.setFirewallPolicy;
  f.api.setFirewallPolicy = async () => { throw new Error("Router unavailable"); };
  await expect(sw.turnOff()).rejects.toThrow("unavailable");
  f.api.setFirewallPolicy = save;
  await sw.turnOff();
  expect(await sw.getState()).toBe("off");
});

test("firewall reads include later pages so an existing pause rule cannot disappear", async () => {
  const offsets: number[] = [];
  const client = new UniFiClient({ apiKey: "synthetic", siteId: "test-site", fetch: (async (url: string) => {
    const offset = Number(new URL(url).searchParams.get("offset"));
    offsets.push(offset);
    const data = offset === 0 ? Array.from({ length: 200 }, (_, index) => ({ id: `first-${index}` })) : [{ id: "last" }];
    return Response.json({ data, totalCount: 201 });
  }) as typeof fetch });
  expect((await client.listFirewallPolicies()).at(-1)?.id).toBe("last");
  expect(offsets).toEqual([0, 200]);
});

test("a configured internet switch publishes and controls the shared router through the device API", async () => {
  const f = fixture();
  const site = Site.fromConfig({ schemaVersion: 2, devices: [
    { id: target.id, name: "Study internet", model: "internet-access-switch", config: { macs: target.macs } },
  ] }, { networkAdapter: () => ({ name: "test router", internetGroups: f.adapter }) });
  const app = createApp(undefined, site);
  const devices = await (await app.request("/api/devices")).json();
  const address = devices.devices.find((device: { id: string }) => device.id === target.id).page.split("/").at(-1);
  expect(address).toBeTruthy();
  const control = async (name: string) => {
    const response = await app.request(`/api/devices/${address}/capabilities/binarySwitch/controls/${name}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    expect(response.status).toBe(200);
    return response.json();
  };
  expect(f.writes()).toBe(0);
  await control("turnOff");
  expect(await f.adapter.describe(target)).toBe("off");
  await control("turnOn");
  expect(await f.adapter.describe(target)).toBe("on");
  expect(f.policies[0]?.enabled).toBe(true);
});
