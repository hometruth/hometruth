import { FixedLabelServer } from "@matter/main/behaviors/fixed-label";
import { afterEach, describe, expect, test } from "bun:test";
import { ControllerBehavior, Environment, Seconds, ServerNode } from "@matter/main";
import { OnOffClient, OnOffServer } from "@matter/main/behaviors/on-off";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSwitchBridge, switchEndpointId, type SwitchBridge, type SwitchClient } from "./bridge.ts";
import type { SwitchInfo, SwitchSnapshot } from "./client.ts";

Environment.default.vars.set("log.level", "error");

class FakeSwitchClient implements SwitchClient {
  inventory: SwitchInfo[] = [{ id: "relay", name: "Relay" }];
  states = new Map<string, SwitchSnapshot>([["relay", { reachable: true, on: false }]]);
  writes: Array<{ id: string; on: boolean }> = [];
  discoverError: Error | undefined;
  writeError: Error | undefined;
  readOverride: ((id: string) => Promise<SwitchSnapshot>) | undefined;
  writeOverride: ((id: string, on: boolean) => Promise<SwitchSnapshot>) | undefined;

  async discover() {
    if (this.discoverError) throw this.discoverError;
    return this.inventory.map((info) => ({ ...info }));
  }

  async read(id: string) {
    if (this.readOverride) return await this.readOverride(id);
    return { ...(this.states.get(id) ?? { reachable: false }) };
  }

  async write(id: string, on: boolean) {
    this.writes.push({ id, on });
    if (this.writeError) throw this.writeError;
    if (this.writeOverride) return await this.writeOverride(id, on);
    const observed = { reachable: true, on };
    this.states.set(id, observed);
    return observed;
  }
}

const active = new Set<SwitchBridge>();
const directories = new Set<string>();

async function temporaryStorage() {
  const directory = await mkdtemp(join(tmpdir(), "hometruth-matter-test-"));
  directories.add(directory);
  return directory;
}

async function bridgeFor(client: SwitchClient, storagePath?: string) {
  const bridge = await createSwitchBridge({
    client,
    storagePath: storagePath ?? await temporaryStorage(),
    id: "test-switch-bridge",
    port: 0,
  });
  active.add(bridge);
  return bridge;
}

async function closeBridge(bridge: SwitchBridge) {
  await bridge.close();
  active.delete(bridge);
}

function endpointFor(bridge: SwitchBridge, id = "relay") {
  const aggregator = bridge.server.parts.get("switches");
  if (!aggregator) throw new Error("The Matter aggregator is missing");
  const endpoint = aggregator.parts.get(switchEndpointId(id));
  if (!endpoint) throw new Error(`Matter endpoint is missing for ${id}`);
  return endpoint;
}

async function command(bridge: SwitchBridge, action: "on" | "off" | "toggle", id = "relay") {
  await endpointFor(bridge, id).act(async (agent) => {
    await agent.get(OnOffServer)[action]();
  });
}

afterEach(async () => {
  for (const bridge of active) await closeBridge(bridge);
  for (const directory of directories) {
    await rm(directory, { recursive: true, force: true });
    directories.delete(directory);
  }
});

describe("HomeTruth Matter switch bridge", () => {
  test("publishes room metadata and updates it without changing the paired endpoint", async () => {
    const client = new FakeSwitchClient();
    client.inventory[0]!.room = "Living Room";
    const storage = await temporaryStorage();
    const bridge = await bridgeFor(client, storage);
    const endpoint = endpointFor(bridge);
    const labels = async () => await endpoint.act((agent) => Array.from(agent.get(FixedLabelServer).state.labelList, ({ label, value }) => ({ label, value })));
    expect(await labels()).toEqual([{ label: "room", value: "Living Room" }]);
    client.inventory[0]!.room = "Office";
    await bridge.discover();
    expect(endpointFor(bridge)).toBe(endpoint);
    expect(await labels()).toEqual([{ label: "room", value: "Office" }]);
    client.inventory[0]!.room = "大きなリビングルーム";
    await bridge.discover();
    expect(Buffer.byteLength((await labels())[0]!.value)).toBeLessThanOrEqual(16);
    await closeBridge(bridge);
    client.discoverError = new Error("offline");
    const restored = await bridgeFor(client, storage);
    expect(restored.snapshot()[0]?.room).toBe("大きなリビングルーム");
    client.discoverError = undefined;
    delete client.inventory[0]!.room;
    await restored.discover();
    expect(await endpointFor(restored).act((agent) => Array.from(agent.get(FixedLabelServer).state.labelList, ({ label, value }) => ({ label, value })))).toEqual([]);
  });

  test("exposes every switch and routes Matter on, off, and toggle to its matching device", async () => {
    const client = new FakeSwitchClient();
    client.inventory.push({ id: "second", name: "Second relay" });
    client.states.set("second", { reachable: true, on: true });
    const bridge = await bridgeFor(client);
    expect(bridge.snapshot().map(({ id, on, reachable }) => ({ id, on, reachable }))).toEqual([
      { id: "relay", on: false, reachable: true },
      { id: "second", on: true, reachable: true },
    ]);
    expect(client.writes).toEqual([]);

    const deviceTypes = endpointFor(bridge).state.descriptor.deviceTypeList.map(({ deviceType }) => Number(deviceType));
    expect(deviceTypes).toContain(0x010f);
    expect(deviceTypes).toContain(0x010a);

    await command(bridge, "on");
    await command(bridge, "off", "second");
    await command(bridge, "toggle");
    expect(client.writes).toEqual([
      { id: "relay", on: true },
      { id: "second", on: false },
      { id: "relay", on: false },
    ]);
    expect(bridge.snapshot().map(({ on }) => on)).toEqual([false, false]);
  });

  test("rejects failed writes without reporting success or retrying the hardware action", async () => {
    const client = new FakeSwitchClient();
    const bridge = await bridgeFor(client);
    client.writeError = new Error("The fixture relay is unreachable");
    await expect(command(bridge, "on")).rejects.toThrow("unreachable");
    expect(bridge.snapshot()[0]?.on).toBe(false);
    expect(client.writes).toEqual([{ id: "relay", on: true }]);

    client.writeError = undefined;
    client.writeOverride = async () => ({ reachable: false });
    await expect(command(bridge, "on")).rejects.toThrow("observed state");
    expect(bridge.snapshot()[0]?.on).toBe(false);
    expect(client.writes).toHaveLength(2);

    // A momentary relay may already have reset when HomeTruth reads it back.
    client.writeOverride = async () => ({ reachable: true, on: false });
    await command(bridge, "on");
    expect(bridge.snapshot()[0]?.on).toBe(false);
    expect(client.writes).toHaveLength(3);
  });

  test("reports external state and availability changes without issuing hardware writes", async () => {
    const client = new FakeSwitchClient();
    const bridge = await bridgeFor(client);
    client.states.set("relay", { reachable: true, on: true });
    await bridge.poll();
    expect(bridge.snapshot()[0]).toMatchObject({ on: true, reachable: true });
    client.states.set("relay", { reachable: false });
    await bridge.poll();
    expect(bridge.snapshot()[0]).toMatchObject({ on: true, reachable: false });
    client.states.set("relay", { reachable: true, on: false });
    await bridge.poll();
    expect(bridge.snapshot()[0]).toMatchObject({ on: false, reachable: true });
    expect(client.writes).toEqual([]);
  });

  test("discards a slow polling result that predates a completed Matter command", async () => {
    const client = new FakeSwitchClient();
    const bridge = await bridgeFor(client);
    const readStarted = Promise.withResolvers<void>();
    const oldRead = Promise.withResolvers<SwitchSnapshot>();
    client.readOverride = async () => {
      readStarted.resolve();
      return await oldRead.promise;
    };
    const poll = bridge.poll();
    await readStarted.promise;
    await command(bridge, "on");
    oldRead.resolve({ reachable: true, on: false });
    await poll;
    expect(bridge.snapshot()[0]).toMatchObject({ on: true, reachable: true });
    expect(client.writes).toEqual([{ id: "relay", on: true }]);
  });

  test("restores endpoint identities and pairing credentials across inventory reordering and renaming", async () => {
    const client = new FakeSwitchClient();
    client.inventory.push({ id: "second", name: "Second relay" });
    const storage = await temporaryStorage();
    const first = await bridgeFor(client, storage);
    const numbers = new Map(first.snapshot().map(({ id, endpoint }) => [id, endpoint]));
    const pairing = { ...first.server.state.commissioning.pairingCodes };
    await closeBridge(first);

    client.inventory = [
      { id: "second", name: "Renamed second relay" },
      { id: "relay", name: "Renamed relay" },
    ];
    const restarted = await bridgeFor(client, storage);
    for (const snapshot of restarted.snapshot()) expect(numbers.get(snapshot.id)).toBe(snapshot.endpoint);
    expect(restarted.server.state.commissioning.pairingCodes).toEqual(pairing);
    expect(restarted.snapshot().map(({ name }) => name)).toEqual(["Renamed second relay", "Renamed relay"]);
    expect(client.writes).toEqual([]);
  });

  test("restores cached switches as unreachable when HomeTruth is temporarily unavailable", async () => {
    const client = new FakeSwitchClient();
    const storage = await temporaryStorage();
    const first = await bridgeFor(client, storage);
    const endpoint = first.snapshot()[0]?.endpoint;
    await closeBridge(first);

    client.discoverError = new Error("HomeTruth is offline");
    client.readOverride = async () => { throw new Error("HomeTruth is offline"); };
    const restarted = await bridgeFor(client, storage);
    expect(restarted.snapshot()).toHaveLength(1);
    expect(restarted.snapshot()[0]).toMatchObject({ id: "relay", endpoint, reachable: false });
    expect(client.writes).toEqual([]);
  });

  test("reconciles added, renamed, and removed switches without changing surviving endpoint numbers", async () => {
    const client = new FakeSwitchClient();
    const bridge = await bridgeFor(client);
    const relayNumber = bridge.snapshot()[0]?.endpoint;
    client.inventory = [{ id: "relay", name: "Updated relay" }, { id: "second", name: "New relay" }];
    client.states.set("second", { reachable: true, on: true });
    await bridge.discover();
    await bridge.poll();
    expect(bridge.snapshot()).toHaveLength(2);
    expect(bridge.snapshot()[0]).toMatchObject({ id: "relay", name: "Updated relay", endpoint: relayNumber });
    const secondNumber = bridge.snapshot()[1]?.endpoint;
    client.inventory = [{ id: "second", name: "New relay" }];
    await bridge.discover();
    expect(bridge.snapshot()).toHaveLength(1);
    expect(bridge.snapshot()[0]).toMatchObject({ id: "second", endpoint: secondNumber });
    expect(client.writes).toEqual([]);
  });

  // This opt-in test opens temporary Matter listeners and uses multicast for CASE discovery.
  // The controller receives only this fixture's address and cannot act on production switches.
  test.skipIf(process.env.HOMETRUTH_MATTER_NETWORK_TEST !== "1")(
    "commissions a separate Matter controller and exchanges commands and subscriptions over UDP",
    async () => {
      const client = new FakeSwitchClient();
      const bridge = await bridgeFor(client);
      await bridge.server.start();
      const controller = await ServerNode.create(ServerNode.RootEndpoint.with(ControllerBehavior), {
        id: "test-controller",
        network: { port: 0 },
        commissioning: { enabled: false },
        controller: { adminFabricLabel: "HomeTruth bridge test" },
      });
      try {
        await controller.start();
        const peer = await controller.peers.forDescriptor({
          addresses: [{ type: "udp", ip: "127.0.0.1", port: bridge.server.state.network.operationalPort }],
        });
        await peer.commission({
          passcode: bridge.server.state.commissioning.passcode,
          timeout: Seconds(10),
          autoSubscribe: true,
          caseConnectionTiming: { delayBeforeNextAddress: Seconds(1), maxDelayBetweenInitialContactRetries: Seconds(2) },
        });
        expect(peer.lifecycle.isCommissioned).toBe(true);
        expect(bridge.server.lifecycle.isCommissioned).toBe(true);
        const remote = peer.endpoints.for(endpointFor(bridge).number);
        expect(remote.stateOf(OnOffClient).onOff).toBe(false);
        await remote.act(async (agent) => { await agent.get(OnOffClient).on(); });
        expect(client.writes).toEqual([{ id: "relay", on: true }]);
        expect(bridge.snapshot()[0]?.on).toBe(true);

        async function waitForReportedState(value: boolean) {
          const deadline = Date.now() + 2_000;
          while (remote.stateOf(OnOffClient).onOff !== value && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          expect(remote.stateOf(OnOffClient).onOff).toBe(value);
        }
        await waitForReportedState(true);
        client.states.set("relay", { reachable: true, on: false });
        await bridge.poll();
        await waitForReportedState(false);
        expect(client.writes).toHaveLength(1);

        client.writeError = new Error("The fixture relay rejected the command");
        await expect(remote.act(async (agent) => { await agent.get(OnOffClient).on(); })).rejects.toThrow();
        expect(bridge.snapshot()[0]?.on).toBe(false);
        expect(client.writes).toHaveLength(2);
      } finally {
        await controller.close();
      }
    },
    30_000,
  );
});
