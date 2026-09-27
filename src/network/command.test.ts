import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCommandAdapter, commandOptionsFromEnv, runNetworkCommand, type NetworkScriptRequest } from "./command";
import { createNetworkAdapter, networkAdapterName } from "./index";
import { FileDeviceConfigWriter } from "../config/device-writer";
import { acceptNextWifiClient } from "./wifi-admission";

const mac = "02:00:00:00:00:01";
function fixture(failVerify = false) {
  let fixedAddress = "192.0.2.10";
  const requests: NetworkScriptRequest[] = [];
  const adapter = createCommandAdapter({ command: ["router"], capabilities: ["addresses", "wifi", "dns", "internet", "admission"], target: "test-router/site",
    async run(_command, request) {
      requests.push(request);
      let result: unknown = null;
      switch (request.operation) {
        case "clients.list": result = [{ mac, address: "192.0.2.10", fixedAddress }]; break;
        case "addresses.reserve": result = { undo: { fixedAddress } }; if (!failVerify) fixedAddress = request.input.address as string; break;
        case "addresses.restore": fixedAddress = (request.input.undo as { fixedAddress: string }).fixedAddress; break;
        case "dns.status": case "internet.status": result = "off"; break;
        case "dns.set": case "internet.set": result = "changed"; break;
        case "admission.wlans": result = [{ id: "iot", ssid: "Test", enabled: true, filterEnabled: true, policy: "allow", macs: [mac] }]; break;
        case "admission.clients": result = []; break;
      }
      return { exitCode: 0, stdout: JSON.stringify(result), stderr: "" };
    },
  });
  return { adapter, requests, current: () => fixedAddress };
}

test("a custom router reserves and restores IPs independently of DNS and device models", async () => {
  const f = fixture();
  const undo = await f.adapter.addresses!.reserve(mac.toUpperCase(), "192.0.2.20");
  expect(f.current()).toBe("192.0.2.20");
  await undo();
  expect(f.current()).toBe("192.0.2.10");
  expect(f.requests.map(r => r.operation)).toEqual(["addresses.reserve", "clients.list", "addresses.restore"]);
  const onlyAddresses = createCommandAdapter({ command: ["router"], capabilities: ["addresses"] });
  expect(onlyAddresses.addresses).toBeDefined();
  expect(onlyAddresses.dns).toBeUndefined();
  expect(onlyAddresses.wifi).toBeUndefined();
});

test("failed reservation readback restores the provider's opaque previous state", async () => {
  const f = fixture(true);
  await expect(f.adapter.addresses!.reserve(mac, "192.0.2.20")).rejects.toThrow("did not retain");
  expect(f.current()).toBe("192.0.2.10");
  expect(f.requests.at(-1)).toEqual({ operation: "addresses.restore", input: { mac, undo: { fixedAddress: "192.0.2.10" } } });
});

test("a failed local file replacement restores a custom router reservation", async () => {
  const f = fixture();
  const directory = await mkdtemp(join(tmpdir(), "network-command-"));
  const path = join(directory, "devices.yml");
  try {
    await Bun.write(path, "schemaVersion: 2\ndevices: [{id: thing, model: broadlink-rm4-pro, config: {host: 192.0.2.10}}]\n");
    const writer = new FileDeviceConfigWriter(path);
    await expect(writer.setNetwork("thing", "192.0.2.20", mac, async () => {
      const undo = await f.adapter.addresses!.reserve(mac, "192.0.2.20");
      await rm(directory, { recursive: true });
      return undo;
    })).rejects.toThrow();
    expect(f.current()).toBe("192.0.2.10");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("client lookup, reconnect, DNS, firewall and admission use normalized script operations", async () => {
  const f = fixture();
  const client = await f.adapter.wifi!.findClientByMac!(mac);
  expect(client?.address).toBe("192.0.2.10");
  await f.adapter.wifi!.kickClient(client!);
  expect(f.requests.at(-1)).toEqual({ operation: "wifi.kick", input: { client } });
  const dns = { domain: "device.example", overrideIp: "192.0.2.50" };
  expect(await f.adapter.dns!.describe(dns)).toBe("off");
  expect(await f.adapter.dns!.set(dns, "on")).toBe("changed");
  expect(f.requests.at(-1)?.input).toEqual({ ...dns, action: "on" });
  expect(await f.adapter.internet!.describe({ mac, label: "thing" })).toBe("off");
  await f.adapter.internet!.set({ mac, label: "thing" }, "on");
  expect(f.requests.at(-1)?.input).toEqual({ mac, label: "thing", action: "on" });
  expect((await acceptNextWifiClient(f.adapter.admission!.api, { async save() { throw new Error("dry run must not write"); }, async clear() {} },
    { ssid: "Test", timeoutMs: 10_000, dryRun: true })).status).toBe("dry-run");
  await f.adapter.admission!.api.setMacFilter("iot", true, [mac]);
  expect(f.requests.at(-1)).toEqual({ operation: "admission.set-filter", input: { id: "iot", enabled: true, macs: [mac] } });
});

test("bad configuration, malformed output and process errors fail explicitly", async () => {
  expect(() => commandOptionsFromEnv({ HOMETRUTH_NETWORK_COMMAND: "ssh router" })).toThrow("JSON array");
  expect(() => createCommandAdapter({ command: ["router"], capabilities: ["admission"] })).toThrow("TARGET");
  expect(() => createNetworkAdapter({ HOMETRUTH_NETWORK_COMMAND: '["router"]' })).toThrow("capabilities");
  expect(networkAdapterName({ UNIFI_API_KEY: "key", HOMETRUTH_NETWORK_COMMAND: '["router"]' })).toBe("command");
  for (const output of ["not JSON", "{}", '[{"mac":"bad","address":"192.0.2.1"}]']) {
    const adapter = createCommandAdapter({ command: ["router"], capabilities: ["addresses"], run: async () => ({ exitCode: 0, stdout: output, stderr: "" }) });
    await expect(adapter.addresses!.list()).rejects.toThrow("invalid");
  }
  const adapter = createCommandAdapter({ command: ["router"], capabilities: ["addresses"], run: async () => ({ exitCode: 2, stdout: "", stderr: "DHCP disabled" }) });
  await expect(adapter.addresses!.reserve(mac, "bad")).rejects.toThrow("valid MAC and IPv4");
  await expect(adapter.addresses!.list()).rejects.toThrow("DHCP disabled");
});

test("transport passes JSON through stdin and never evaluates input as shell code", async () => {
  const input = { label: '$(exit 99) `exit 99` "quoted"\nline two' };
  const result = await runNetworkCommand([process.execPath, "-e", "process.stdout.write(await Bun.stdin.text())"], { operation: "test", input }, 5000, process.env);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ operation: "test", input });
  await expect(runNetworkCommand([process.execPath, "-e", "await Bun.sleep(1000)"], { operation: "test", input: {} }, 10, process.env)).rejects.toThrow("timed out");
});

test("capture provider streams binary stdout and notifies when the script exits", async () => {
  const adapter = createCommandAdapter({ command: [process.execPath, "-e", 'const r=JSON.parse(await Bun.stdin.text()); if(r.operation!=="capture.start") process.exit(2); process.stdout.write(new Uint8Array([0xd4,0xc3,0xb2,0xa1]));'], capabilities: ["capture"] });
  const chunks: Uint8Array[] = [];
  let ended!: (error?: Error) => void;
  const done = new Promise<Error | undefined>(resolve => { ended = resolve; });
  const session = await adapter.capture!.start({ mac, address: "192.0.2.10" }, chunk => chunks.push(chunk), ended);
  expect(await done).toBeUndefined();
  expect(Buffer.concat(chunks)).toEqual(Buffer.from([0xd4, 0xc3, 0xb2, 0xa1]));
  await session.stop();
});
