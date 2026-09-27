import { DeviceTypeId, Endpoint, Environment, ServerNode, VendorId } from "@matter/main";
import { BridgedDeviceBasicInformationServer } from "@matter/main/behaviors/bridged-device-basic-information";
import { FixedLabelServer } from "@matter/main/behaviors/fixed-label";
import { DescriptorServer } from "@matter/main/behaviors/descriptor";
import { MountedOnOffControlDevice, MountedOnOffControlRequirements } from "@matter/main/devices/mounted-on-off-control";
import { AggregatorEndpoint } from "@matter/main/endpoints/aggregator";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SwitchInfo, SwitchSnapshot } from "./client.ts";

export interface SwitchClient {
  discover(): Promise<SwitchInfo[]>;
  read(id: string): Promise<SwitchSnapshot>;
  write(id: string, on: boolean): Promise<SwitchSnapshot>;
}

export interface SwitchBridgeOptions {
  client: SwitchClient;
  storagePath: string;
  port?: number;
  id?: string;
  environment?: Environment;
  onError?: (message: string) => void;
}

/** Names may change; the configured device ID is the identity on every restart. */
export function switchEndpointId(id: string): string {
  return `switch-${createHash("sha256").update(id).digest("hex").slice(0, 24)}`;
}

function matterLabel(name: string, maxBytes = 32): string {
  // Matter labels have a 32-byte UTF-8 limit.
  let label = "";
  for (const character of name) {
    if (Buffer.byteLength(label + character) > maxBytes) break;
    label += character;
  }
  return label || "Home Truth switch";
}

/** Matter's Fixed Label values are limited to 16 UTF-8 bytes; inventory retains the full room name. */
function roomLabels(room?: string) {
  return room ? [{ label: "room", value: matterLabel(room, 16) }] : [];
}

export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, path);
}

async function cachedInventory(path: string): Promise<SwitchInfo[]> {
  let data: unknown;
  try {
    data = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`Cannot read Matter switch inventory at ${path}`, { cause: error });
  }
  if (!Array.isArray(data) || !data.every((item: unknown) => {
    const entry = item as Partial<SwitchInfo> | null;
    return entry && typeof entry.id === "string" && entry.id.length && typeof entry.name === "string"
      && (entry.room === undefined || (typeof entry.room === "string" && entry.room.trim().length > 0 && entry.room.length <= 100));
  })) throw new Error(`Invalid Matter switch inventory at ${path}`);
  const devices = data as SwitchInfo[];
  if (new Set(devices.map((device) => device.id)).size !== devices.length) throw new Error("Duplicate cached Matter switch IDs");
  return devices;
}

function switchBinding(info: SwitchInfo, client: SwitchClient) {
  let version = 0;
  let writes = 0;

  class HomeTruthOnOffServer extends MountedOnOffControlRequirements.OnOffServer {
    async write(on: boolean): Promise<SwitchSnapshot> {
      await this.context.transaction.addResources(this, this.agent.get(BridgedDeviceBasicInformationServer));
      await this.context.transaction.begin();
      version++;
      writes++;
      try {
        const snapshot = await client.write(info.id, on);
        if (!snapshot.reachable || snapshot.on === undefined) throw new Error(`${info.name} did not return an observed state`);
        return snapshot;
      } finally {
        writes--;
        version++;
      }
    }

    override async on(): Promise<void> {
      const observed = await this.write(true);
      await super.on();
      this.state.onOff = observed.on!;
      this.agent.get(BridgedDeviceBasicInformationServer).state.reachable = true;
    }

    override async off(): Promise<void> {
      const observed = await this.write(false);
      await super.off();
      this.state.onOff = observed.on!;
      this.agent.get(BridgedDeviceBasicInformationServer).state.reachable = true;
    }
  }

  const endpoint = new Endpoint(MountedOnOffControlDevice.with(BridgedDeviceBasicInformationServer, HomeTruthOnOffServer, DescriptorServer, FixedLabelServer), {
    id: switchEndpointId(info.id),
    bridgedDeviceBasicInformation: {
      nodeLabel: matterLabel(info.name),
      productName: "Home Truth switch",
      productLabel: matterLabel(info.name),
      serialNumber: createHash("sha256").update(info.id).digest("hex").slice(0, 24),
      uniqueId: switchEndpointId(info.id),
      reachable: false,
    },
    onOff: { onOff: false },
    fixedLabel: { labelList: roomLabels(info.room) },
    // Mounted On/Off Control was added in Matter 1.4. The specification
    // recommends listing its Plug-in Unit subset as well so older or
    // incomplete clients can still render and operate this endpoint.
    descriptor: {
      deviceTypeList: [
        { deviceType: DeviceTypeId(0x010f), revision: 2 },
        { deviceType: DeviceTypeId(0x010a), revision: 4 },
      ],
    },
  });

  return {
    info,
    endpoint,
    async refresh() {
      if (writes) return;
      const readVersion = version;
      let snapshot: SwitchSnapshot;
      try { snapshot = await client.read(info.id); }
      catch { snapshot = { reachable: false }; }
      await endpoint.act(async (agent) => {
        const onOff = agent.get(HomeTruthOnOffServer);
        const basic = agent.get(BridgedDeviceBasicInformationServer);
        await agent.context.transaction.addResources(onOff, basic);
        await agent.context.transaction.begin();
        // A read started before a Home command must never overwrite its result.
        if (writes || version !== readVersion) return;
        if (snapshot.reachable && snapshot.on !== undefined) onOff.state.onOff = snapshot.on;
        basic.state.reachable = snapshot.reachable;
      });
    },
  };
}

export async function createSwitchBridge(options: SwitchBridgeOptions) {
  await mkdir(options.storagePath, { recursive: true, mode: 0o700 });
  const environment = options.environment ?? Environment.default;
  environment.vars.set("storage.path", options.storagePath);
  const inventoryPath = join(options.storagePath, "switches.json");
  const cached = await cachedInventory(inventoryPath);
  let initial: SwitchInfo[];
  try { initial = await options.client.discover(); }
  catch (error) {
    if (!cached.length) throw error;
    initial = cached;
    options.onError?.("Home Truth is unavailable; restoring known switches as unreachable");
  }

  const server = await ServerNode.create({
    id: options.id ?? "hometruth-switches",
    environment,
    network: { port: options.port ?? 5540 },
    productDescription: { name: "Home Truth", deviceType: AggregatorEndpoint.deviceType },
    basicInformation: {
      vendorName: "Home Truth",
      vendorId: VendorId(0xfff1),
      productId: 0x8000,
      productName: "Home Truth Switches",
      productLabel: "Switch bridge",
      nodeLabel: "Home Truth",
      serialNumber: options.id ?? "hometruth-switches",
      hardwareVersion: 1,
      hardwareVersionString: "1",
      softwareVersion: 1,
      softwareVersionString: "1.0.0",
    },
  });
  const aggregator = await server.add(new Endpoint(AggregatorEndpoint, { id: "switches" }));
  const bindings = new Map<string, ReturnType<typeof switchBinding>>();
  let closed = false;
  // Serialize inventory and polls, while Matter itself serializes endpoint transactions.
  let pending: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  };

  async function reconcile(inventory: SwitchInfo[]) {
    for (const info of inventory) {
      const existing = bindings.get(info.id);
      if (existing) {
        if (existing.info.name !== info.name) {
          await existing.endpoint.set({ bridgedDeviceBasicInformation: { nodeLabel: matterLabel(info.name), productLabel: matterLabel(info.name) } });
          existing.info.name = info.name;
        }
        if (existing.info.room !== info.room) {
          await existing.endpoint.set({ fixedLabel: { labelList: roomLabels(info.room) } });
          if (info.room === undefined) delete existing.info.room;
          else existing.info.room = info.room;
        }
        continue;
      }
      const binding = switchBinding({ ...info }, options.client);
      await aggregator.add(binding.endpoint);
      bindings.set(info.id, binding);
    }
    const present = new Set(inventory.map((info) => info.id));
    for (const [id, binding] of bindings) {
      if (present.has(id)) continue;
      await binding.endpoint.close();
      bindings.delete(id);
    }
    await writePrivateJson(inventoryPath, inventory);
  }

  try {
    await reconcile(initial);
    await Promise.all([...bindings.values()].map((binding) => binding.refresh()));
  } catch (error) {
    await server.close();
    throw error;
  }

  return {
    server,
    async poll() {
      return await enqueue(async () => {
        if (!closed) await Promise.all([...bindings.values()].map((binding) => binding.refresh()));
      });
    },
    async discover() {
      return await enqueue(async () => {
        if (!closed) await reconcile(await options.client.discover());
      });
    },
    snapshot() {
      return [...bindings.values()].map(({ info, endpoint }) => ({
        ...info,
        endpoint: endpoint.number,
        reachable: endpoint.state.bridgedDeviceBasicInformation.reachable,
        on: endpoint.state.onOff.onOff,
      }));
    },
    async close() {
      closed = true;
      await pending;
      await server.close();
    },
  };
}

export type SwitchBridge = Awaited<ReturnType<typeof createSwitchBridge>>;
