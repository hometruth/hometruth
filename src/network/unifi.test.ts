import { describe, expect, test } from "bun:test";
import { UniFiClient, UniFiInternetBlock, UniFiPacketCapture, UniFiWifiKick, captureScript, type FirewallPolicy, type UniFiFirewallApi } from "./unifi";

describe("UniFi Wi-Fi clients", () => {
  test("keeps the current link-local address and the fixed DHCP reservation", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ data: [{
      mac: "02:00:00:79:a4:08",
      ip: "169.254.18.41",
      fixed_ip: "10.77.0.153",
      last_ip: "10.77.0.153",
      hostname: "Elgato Key Light Air 5F4F",
    }] }), { status: 200 })) as unknown as typeof fetch;
    const clients = await new UniFiClient({ apiKey: "test", fetch: fetchImpl }).listClients();
    expect(clients).toEqual([{
      mac: "02:00:00:79:a4:08",
      address: "169.254.18.41",
      fixedAddress: "10.77.0.153",
      lastAddress: "10.77.0.153",
      hostname: "Elgato Key Light Air 5F4F",
    }]);
  });

  test("finds a link-local client by its configured fixed address", async () => {
    const client = { mac: "02:00:00:79:a4:08", address: "169.254.18.41", fixedAddress: "10.77.0.153" };
    const wifi = new UniFiWifiKick({ async listClients() { return [client]; }, async kickClient() {} });
    expect(await wifi.findClientByAddress("10.77.0.153")).toBe(client);
  });

  test("finds a client at the wrong address by MAC", async () => {
    const client = { mac: "02:00:00:79:a4:08", address: "169.254.18.41" };
    const wifi = new UniFiWifiKick({ async listClients() { return [client]; }, async kickClient() {} });
    expect(await wifi.findClientByMac("02:00:00:79:a4:08")).toBe(client);
  });
});

function fakeFirewall(initial: FirewallPolicy[] = []): UniFiFirewallApi & { policies: FirewallPolicy[]; calls: string[] } {
  const policies = [...initial];
  const calls: string[] = [];
  return {
    policies,
    calls,
    async listFirewallZones() {
      return [{ id: "zone-internal", name: "Internal" }, { id: "zone-external", name: "External" }, { id: "zone-gateway", name: "Gateway" }];
    },
    async listFirewallPolicies() { return policies.map((policy) => ({ ...policy })); },
    async createFirewallPolicy(policy) {
      calls.push(`create ${policy.name}`);
      policies.push({ ...policy, id: `id-${policies.length + 1}`, index: 10_000 + policies.length, metadata: { origin: "USER_DEFINED" } });
    },
    async setFirewallPolicy(policy, enabled) {
      calls.push(`set ${policy.id} ${enabled}`);
      const stored = policies.find((candidate) => candidate.id === policy.id);
      if (stored) stored.enabled = enabled;
    },
  };
}

describe("UniFiInternetBlock", () => {
  const target = { mac: "02:00:00:71:b6:de", label: "example-camera" };

  test("creates a MAC-filtered block from the Internal zone to the External zone with logging, then toggles it", async () => {
    const api = fakeFirewall();
    const block = new UniFiInternetBlock(api);
    expect(await block.describe(target)).toBe("missing");
    expect(await block.set(target, "on")).toContain("rule created");
    const policy = api.policies[0]!;
    expect(policy.name).toBe("hometruth-isolate example-camera");
    expect(policy.action).toEqual({ type: "BLOCK" });
    expect(policy.source).toEqual({ zoneId: "zone-internal", trafficFilter: { type: "MAC_ADDRESS", macAddressFilter: { macAddresses: ["02:00:00:71:b6:de"] } } });
    expect(policy.destination).toEqual({ zoneId: "zone-external" });
    expect(policy.loggingEnabled).toBe(true);
    expect(await block.describe(target)).toBe("on");
    expect(await block.set(target, "off")).toContain("released");
    expect(await block.describe(target)).toBe("off");
    expect(await block.set(target, "on")).toContain("isolated");
    expect(api.calls).toEqual(["create hometruth-isolate example-camera", "set id-1 false", "set id-1 true"]);
  });

  test("switching off a device that never had a rule creates nothing", async () => {
    const api = fakeFirewall();
    expect(await new UniFiInternetBlock(api).set(target, "off")).toContain("no rule found");
    expect(api.policies).toHaveLength(0);
  });

  test("matches only HomeTruth's own single-MAC rules, never a user's own policies", async () => {
    const api = fakeFirewall([
      { id: "user", name: "kid-block", enabled: true, source: { zoneId: "zone-internal", trafficFilter: { type: "MAC_ADDRESS", macAddressFilter: { macAddresses: ["02:00:00:71:b6:de", "aa:bb:cc:dd:ee:ff"] } } } },
      { id: "mine", name: "hometruth-isolate example-camera", enabled: false, source: { zoneId: "zone-internal", trafficFilter: { type: "MAC_ADDRESS", macAddressFilter: { macAddresses: ["02:00:00:71:b6:de"] } } } },
    ]);
    expect(await new UniFiInternetBlock(api).describe(target)).toBe("off");
  });

  test("refuses duplicate rules rather than guessing", async () => {
    const rule: FirewallPolicy = { name: "hometruth-isolate x", enabled: true, source: { trafficFilter: { type: "MAC_ADDRESS", macAddressFilter: { macAddresses: ["02:00:00:71:b6:de"] } } } };
    const api = fakeFirewall([{ ...rule, id: "a" }, { ...rule, id: "b" }]);
    await expect(new UniFiInternetBlock(api).describe(target)).rejects.toThrow(/duplicate isolation rules/u);
  });
});

describe("captureScript", () => {
  test("disables offload, streams tcpdump for one MAC, re-asserts offload while running, and restores on exit", () => {
    const script = captureScript("wifi0ap0.3", "02:00:00:71:b6:de", 60);
    expect(script).toContain("tcpdump -i wifi0ap0.3 -s0 -U -w - ether host 02:00:00:71:b6:de");
    expect(script).toContain("trap restore EXIT HUP INT TERM");
    expect(script).toContain("sleep 60; kill $TP");
    expect(script).toContain("while kill -0 $TP");
  });

  test("refuses interface or MAC values that could inject shell", () => {
    expect(() => captureScript("wifi0; rm -rf /", "02:00:00:71:b6:de")).toThrow(/oddly named interface/u);
    expect(() => captureScript("wifi0ap0.3", "02:00:00:71:b6:de; reboot")).toThrow(/oddly formed MAC/u);
  });
});

describe("UniFiPacketCapture", () => {
  const aps = [{ mac: "02:00:00:87:75:1e", address: "10.77.0.131", name: "U7 Pro XG", interfaces: [{ name: "wifi0ap0", ssid: "example-iot", radio: "ng" }, { name: "wifi1ap1", ssid: "example-iot", radio: "na" }] }];
  const client = { mac: "02:00:00:71:b6:de", address: "10.78.0.147", apMac: "02:00:00:87:75:1e", radio: "ng", ssid: "example-iot", vlan: 3 };

  test("locates the client's AP and the VLAN-tagged SSID interface on its radio", async () => {
    const capture = new UniFiPacketCapture({ async listAccessPoints() { return aps; } }, { user: "u", keyPath: "/k" });
    expect(await capture.locate(client)).toEqual({ ap: aps[0]!, iface: "wifi0ap0.3" });
    expect((await capture.locate({ ...client, vlan: 1 })).iface).toBe("wifi0ap0");
    const { apMac: _apMac, ...wired } = client;
    void _apMac;
    await expect(capture.locate(wired)).rejects.toThrow(/not associated/u);
  });

  test("runs ssh to the AP with the capture script, streams stdout to the sink, and reports the end", async () => {
    const commands: string[][] = [];
    let ended: Error | undefined | "not yet" = "not yet";
    const chunks: Uint8Array[] = [];
    const capture = new UniFiPacketCapture({ async listAccessPoints() { return aps; } }, {
      user: "capture", keyPath: "/tmp/key",
      spawn(command) {
        commands.push(command);
        return {
          stdout: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); } }),
          stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
          exited: Promise.resolve(0),
          kill() { /* nothing to kill */ },
        };
      },
    });
    const session = await capture.start(client, (chunk) => chunks.push(chunk), (error) => { ended = error; });
    expect(session.where).toBe("U7 Pro XG (10.77.0.131) wifi0ap0.3");
    expect(commands[0]!.slice(0, 3)).toEqual(["ssh", "-i", "/tmp/key"]);
    expect(commands[0]).toContain("capture@10.77.0.131");
    expect(commands[0]!.at(-1)).toContain("tcpdump -i wifi0ap0.3");
    await Bun.sleep(20);
    expect(chunks).toEqual([new Uint8Array([1, 2, 3])]);
    expect(ended).toBeUndefined();
  });
});
