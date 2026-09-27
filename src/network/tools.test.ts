import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNetworkTools } from "./tools";
import type { NetworkAdapter } from "./adapter";

const mac = "02:00:00:00:00:01";
test("the script lists capabilities and reserves any client without a HomeTruth model or server", async () => {
  const calls: string[] = [];
  const adapter: NetworkAdapter = { name: "other-router", addresses: {
    async list() { return [{ mac, address: "192.0.2.10" }]; },
    async reserve(identity, address) { calls.push(`${identity} ${address}`); return async () => {}; },
  } };
  expect(await runNetworkTools(["capabilities"], { adapter })).toEqual({ provider: "other-router", capabilities: ["addresses"] });
  expect(await runNetworkTools(["find", mac], { adapter })).toEqual({ mac, address: "192.0.2.10" });
  expect(await runNetworkTools(["reserve", mac, "192.0.2.20"], { adapter })).toMatchObject({ mac, address: "192.0.2.20" });
  expect(calls).toEqual([`${mac} 192.0.2.20`]);
  await expect(runNetworkTools(["reserve", mac, "garbage"], { adapter })).rejects.toThrow("IPv4");
  await expect(runNetworkTools(["reconnect", mac], { adapter })).rejects.toThrow("does not support");
});

test("script save uses the Settings transaction and reports failures", async () => {
  const requests: unknown[] = [];
  const fetchImpl = (async (url, init) => {
    requests.push({ url: String(url), method: init?.method, body: JSON.parse(String(init?.body)) });
    return Response.json({ mac, address: "192.0.2.20", message: "Saved" });
  }) as typeof fetch;
  expect(await runNetworkTools(["save", "kitchen cooktop", mac, "192.0.2.20"], { env: { HOMETRUTH_URL: "http://127.0.0.1:3009" }, fetch: fetchImpl })).toMatchObject({ message: "Saved" });
  expect(requests).toEqual([{ url: "http://127.0.0.1:3009/api/devices/kitchen%20cooktop/network/settings", method: "POST", body: { mac, address: "192.0.2.20" } }]);
  await expect(runNetworkTools(["save", "thing", mac, "192.0.2.20"], { fetch: (async () => Response.json({ error: { message: "reservation conflict" } }, {status: 409})) as unknown as typeof fetch })).rejects.toThrow("reservation conflict");
});

test("script capture preserves all bytes, closes the session, and creates a private output file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "network-tools-"));
  let stops = 0;
  const adapter: NetworkAdapter = { name: "fixture", addresses: { async list() { return [{ mac, address: "192.0.2.10" }]; }, async reserve() { throw new Error("must not reserve"); } },
    capture: { async start(_client, sink, end) { sink(new Uint8Array([1, 2])); sink(new Uint8Array([3, 4])); end(); return { where: "router", async stop() { stops++; } }; } } };
  try {
    const path = join(directory, "capture.pcap");
    await runNetworkTools(["capture", mac, "1", path], { adapter });
    expect(await readFile(path)).toEqual(Buffer.from([1, 2, 3, 4]));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(stops).toBe(1);
    await expect(runNetworkTools(["capture", mac, "1", path], { adapter })).rejects.toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
