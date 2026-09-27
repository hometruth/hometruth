import { describe, expect, test } from "bun:test";
import { acceptNextWifiClient, restoreMacFilter, type AdmissionClient, type AdmissionWlan, type WifiAdmissionApi } from "./wifi-admission";
import { UniFiClient } from "./unifi";
import { UniFiAdmissionClient } from "./unifi-admission";

const oldMac = "02:00:00:00:00:01";
const newMac = "02:00:00:00:00:02";
const otherMac = "02:00:00:00:00:03";
const original: AdmissionWlan = { id: "wlan-1", ssid: "Test IoT", enabled: true, filterEnabled: true, policy: "allow", macs: [oldMac] };

function fixture() {
  let wlan = structuredClone(original);
  let time = 0;
  let scans = 0;
  let snapshot: AdmissionWlan | undefined;
  let clients: AdmissionClient[] = [];
  const writes: { enabled: boolean; macs?: string[] }[] = [];
  const api: WifiAdmissionApi = {
    async listWlans() { return [structuredClone(wlan)]; },
    async listAdmissionClients() { scans++; return scans === 1 ? [] : clients; },
    async setMacFilter(_id, enabled, macs) {
      writes.push({ enabled, ...(macs ? { macs: [...macs] } : {}) });
      wlan.filterEnabled = enabled;
      if (macs) wlan.macs = [...macs];
    },
  };
  const journal = { async save(value: AdmissionWlan) { snapshot = structuredClone(value); }, async clear() { snapshot = undefined; } };
  const options = { ssid: original.ssid, timeoutMs: 10_000, now: () => time, sleep: async (ms: number) => { time += ms; } };
  return { api, journal, options, writes, state: () => wlan, snapshot: () => snapshot,
    setWlan(value: AdmissionWlan) { wlan = value; }, setClients(value: AdmissionClient[]) { clients = value; } };
}

describe("one-client Wi-Fi admission", () => {
  test("accepts one new MAC on the chosen WLAN before DHCP, preserves existing entries, and closes", async () => {
    const f = fixture();
    f.setClients([
      { mac: oldMac, ssid: original.ssid },
      { mac: otherMac, ssid: "Other WiFi" },
      { mac: otherMac, ssid: original.ssid, wlanId: "different-id" },
      { mac: newMac.toUpperCase(), ssid: original.ssid, wlanId: original.id, name: "Govee" },
    ]);
    const result = await acceptNextWifiClient(f.api, f.journal, f.options);
    expect(result).toMatchObject({ status: "accepted", filterEnabled: true, client: { mac: newMac, name: "Govee" } });
    expect(f.state().macs).toEqual([oldMac, newMac]);
    expect(f.writes[0]).toEqual({ enabled: false });
    expect(f.writes.at(-1)).toEqual({ enabled: true, macs: [oldMac, newMac] });
    expect(f.snapshot()).toBeUndefined();
  });

  test("ignores a reconnecting previously allowed device and times out", async () => {
    const f = fixture();
    f.setClients([{ mac: oldMac, ssid: original.ssid }]);
    expect((await acceptNextWifiClient(f.api, f.journal, f.options)).status).toBe("timeout");
    expect(f.state()).toEqual(original);
    expect(f.writes).toEqual([{ enabled: false }, { enabled: true }]);
  });

  test("dry run never writes a journal or changes the gateway", async () => {
    const f = fixture();
    expect((await acceptNextWifiClient(f.api, f.journal, { ...f.options, dryRun: true })).status).toBe("dry-run");
    expect(f.writes).toEqual([]);
    expect(f.snapshot()).toBeUndefined();
  });

  test("closes on cancellation", async () => {
    const f = fixture();
    const abort = new AbortController();
    const result = await acceptNextWifiClient(f.api, f.journal, { ...f.options, signal: abort.signal, report: () => abort.abort() });
    expect(result.status).toBe("cancelled");
    expect(f.state()).toEqual(original);
  });

  test("ambiguous simultaneous arrivals close without adding either", async () => {
    const f = fixture();
    f.setClients([{ mac: newMac, ssid: original.ssid }, { mac: otherMac, ssid: original.ssid }]);
    await expect(acceptNextWifiClient(f.api, f.journal, f.options)).rejects.toThrow("Multiple new clients");
    expect(f.state()).toEqual(original);
    expect(f.snapshot()).toBeUndefined();
  });

  test("a polling failure closes the window", async () => {
    const f = fixture();
    let count = 0;
    f.api.listAdmissionClients = async () => { if (count++) throw new Error("gateway unavailable"); return []; };
    await expect(acceptNextWifiClient(f.api, f.journal, f.options)).rejects.toThrow("gateway unavailable");
    expect(f.state().filterEnabled).toBe(true);
  });

  test("an uncertain disabling PUT is always followed by restoration", async () => {
    const f = fixture();
    const set = f.api.setMacFilter;
    f.api.setMacFilter = async (id, enabled, macs) => { await set(id, enabled, macs); if (!enabled) throw new Error("response lost"); };
    await expect(acceptNextWifiClient(f.api, f.journal, f.options)).rejects.toThrow("response lost");
    expect(f.state()).toEqual(original);
    expect(f.snapshot()).toBeUndefined();
  });

  test("retains the journal on permanent restoration failure", async () => {
    const f = fixture();
    const set = f.api.setMacFilter;
    f.api.setMacFilter = async (id, enabled, macs) => { if (enabled) throw new Error("router offline"); await set(id, enabled, macs); };
    await expect(acceptNextWifiClient(f.api, f.journal, f.options)).rejects.toThrow("recovery snapshot retained");
    expect(f.snapshot()).toEqual(original);
  });

  test("retains concurrent allowlist additions", async () => {
    const f = fixture();
    f.setClients([{ mac: newMac, ssid: original.ssid }]);
    const result = await acceptNextWifiClient(f.api, f.journal, { ...f.options, report: message => {
      if (message.includes("restriction is off")) f.state().macs.push(otherMac);
    } });
    expect(result.allowedCount).toBe(3);
    expect(f.state().macs).toEqual([oldMac, otherMac, newMac]);
  });

  test("rejects disabled filtering and deny policies before mutation", async () => {
    for (const wlan of [{ ...original, filterEnabled: false }, { ...original, policy: "deny" }, { ...original, enabled: false }]) {
      const f = fixture();
      f.setWlan(wlan);
      await expect(acceptNextWifiClient(f.api, f.journal, f.options)).rejects.toThrow("active MAC allowlist");
      expect(f.writes).toEqual([]);
    }
  });

  test("refuses concurrent jobs before opening", async () => {
    const f = fixture();
    f.journal.save = async () => { throw new Error("window already exists"); };
    await expect(acceptNextWifiClient(f.api, f.journal, f.options)).rejects.toThrow("already exists");
    expect(f.writes).toEqual([]);
  });

  test("restoration survives one failed readback", async () => {
    const f = fixture();
    const read = f.api.listWlans;
    let reads = 0;
    f.api.listWlans = async () => { if (!reads++) throw new Error("temporary failure"); return read(); };
    expect((await restoreMacFilter(f.api, original, undefined, f.options.sleep)).filterEnabled).toBe(true);
    expect(f.writes).toEqual([{ enabled: true }, { enabled: true }]);
  });
});

describe("UniFi admission transport", () => {
  test("writes only filtering fields and never exposes Wi-Fi passwords", async () => {
    const writes: unknown[] = [];
    const api = new UniFiAdmissionClient(new UniFiClient({ apiKey: "secret", fetch: (async (_url, init) => {
      if (init?.method === "PUT") { writes.push(JSON.parse(String(init.body))); return Response.json({ meta: { rc: "ok" }, data: [] }); }
      return Response.json({ data: [{ _id: "wlan-1", name: "Test IoT", enabled: true, mac_filter_enabled: true,
        mac_filter_policy: "allow", mac_filter_list: [oldMac], x_passphrase: "must-not-leak" }] });
    }) as typeof fetch }));
    expect(await api.listWlans()).toEqual([original]);
    await api.setMacFilter(original.id, false);
    await api.setMacFilter(original.id, true, [oldMac, newMac]);
    expect(writes).toEqual([{ mac_filter_enabled: false }, { mac_filter_enabled: true, mac_filter_list: [oldMac, newMac] }]);
  });

  test("sees Wi-Fi arrivals without an IP and ignores wired clients", async () => {
    const api = new UniFiAdmissionClient(new UniFiClient({ apiKey: "secret", fetch: (async () => Response.json({ data: [
      { mac: newMac, essid: original.ssid, is_wired: false, wlanconf_id: original.id },
      { mac: otherMac, essid: original.ssid, is_wired: true },
    ] })) as unknown as typeof fetch }));
    expect(await api.listAdmissionClients()).toEqual([{ mac: newMac, ssid: original.ssid, wlanId: original.id }]);
  });

  test("rejects error envelopes even on HTTP 200", async () => {
    const api = new UniFiAdmissionClient(new UniFiClient({ apiKey: "secret", fetch: (async () => Response.json({ meta: { rc: "error" }, data: [] })) as unknown as typeof fetch }));
    await expect(api.setMacFilter(original.id, false)).rejects.toThrow("rejected");
  });
});
