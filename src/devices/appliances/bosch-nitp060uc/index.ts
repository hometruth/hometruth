import type { FromSchema } from "json-schema-to-ts";
import { Device, lanHostSchema, type DeviceModel, type DeviceInstance, type DeviceIdentity, type CapabilityMethods, type SecretsBag, type DeviceCreationContext } from "../../../models/device";
import { Cooktop, type CooktopState } from "../../../models/cooktop";
import { cooktopSchema } from "../../../models/cooktop-schema";
import { BinarySwitch, BinarySwitchError, type BinarySwitchState } from "../../../models/binary-switch";
import { binarySwitchSchema } from "../../../schemas";
import { HomeConnectClient, type HomeConnectTransport, type HomeConnectSnapshot, controlAvailable } from "../../../protocols/homeconnect/client";

export const BOSCH_NITP060UC_CONFIG_SCHEMA = {
  $id: "https://hometruth.ai/schemas/models/bosch-nitp060uc/config",
  type: "object", additionalProperties: false,
  properties: { host: lanHostSchema, timeoutMs: { type: "integer", minimum: 500, maximum: 10000 } }, required: ["host"],
} as const;
export const BOSCH_NITP060UC_SECRETS_SCHEMA = {
  $id: "https://hometruth.ai/schemas/models/bosch-nitp060uc/secrets",
  type: "object", additionalProperties: false,
  properties: {
    key: { type: "string", pattern: "^[A-Za-z0-9_-]{43}=?$" },
    iv: { type: "string", pattern: "^[A-Za-z0-9_-]{22}(==)?$" },
    serialNumber: { type: "string", minLength: 1, maxLength: 100 },
  }, required: ["key", "iv"],
} as const;
type Config = FromSchema<typeof BOSCH_NITP060UC_CONFIG_SCHEMA>;
type Secrets = FromSchema<typeof BOSCH_NITP060UC_SECRETS_SCHEMA>;

const ZONES = [
  { id: "100", position: "frontLeft", state: 0x2008, power: 0x200c },
  { id: "200", position: "rearLeft", state: 0x202c, power: 0x2030 },
  { id: "300", position: "rearRight", state: 0x203e, power: 0x2042 },
  { id: "400", position: "frontRight", state: 0x2062, power: 0x2066 },
  { id: "120", position: "leftCombined", state: 0x201a, power: 0x201e },
] as const;

export function cooktopState(snapshot: HomeConnectSnapshot): CooktopState {
  const { values, observedAt } = snapshot;
  const power = values.get(0x021b), lock = values.get(0x020c), timer = values.get(0x0235), remote = values.get(0x020b);
  const zones: NonNullable<CooktopState["zones"]> = ZONES.filter(zone => zone.id !== "120" || (values.has(zone.state) && values.get(zone.state) !== 0)).map(zone => {
    const rawState = values.get(zone.state), rawPower = values.get(zone.power);
    const state = rawState === 0 ? "unavailable" : rawState === 1 ? "off" : rawState === 2 ? "active" : rawState === 3 ? "hot" : "unknown";
    const level = typeof rawPower === "number" && Number.isInteger(rawPower) && rawPower >= 2 && rawPower <= 18 ? rawPower / 2 : rawPower === 0 ? 0 : undefined;
    const mode = rawPower === 1 ? "keepWarm" : rawPower === 20 ? "boost" : rawPower === 21 ? "shortBoost" : level !== undefined ? "normal" : undefined;
    return { id: zone.id, position: zone.position, state, ...(level !== undefined ? { level } : {}), ...(mode ? { mode } : {}) };
  });
  const complete = (power === 1 || power === 2) && typeof lock === "boolean" && typeof timer === "number" && Number.isInteger(timer) && timer >= 0 && timer <= 5940 && zones.every(zone => zone.state !== "unknown");
  return {
    availability: complete ? "online" : "degraded", observedAt,
    ...(power === 1 || power === 2 ? { power: power === 1 ? "off" : "on" } : {}),
    ...(typeof lock === "boolean" ? { childLocked: lock } : {}),
    ...(typeof timer === "number" && Number.isInteger(timer) && timer >= 0 && timer <= 5940 ? { timerSeconds: timer } : {}),
    ...(typeof remote === "boolean" ? { remoteControl: remote } : {}), zones,
  };
}

export class BoschCooktop extends Cooktop {
  constructor(id: string, readonly client: HomeConnectTransport) { super(id); }
  async getState(): Promise<CooktopState> {
    try { return cooktopState(await this.client.read()); }
    catch (error) { return { availability: "offline", detail: (error instanceof Error ? error.message : "Cooktop unavailable").slice(0, 500) }; }
  }
  protected async allowedControls() {
    try {
      const snapshot = await this.client.read();
      return { lock: controlAvailable(snapshot, 0x020c), timer: controlAvailable(snapshot, 0x0235) };
    } catch { return { lock: false, timer: false }; }
  }
  async setChildLock(locked: boolean): Promise<void> { await this.client.set(0x020c, locked); }
  async setTimer(seconds: number): Promise<void> { await this.client.set(0x0235, seconds); }
}
export interface BoschNITP060UC extends CapabilityMethods<{ cooktop: BoschCooktop }> {}
export class BoschNITP060UC extends Device<Config> {
  readonly model = BOSCH_NITP060UC;
  readonly capabilities;
  readonly cooktop: BoschCooktop;
  private readonly client: HomeConnectTransport;
  constructor(instance: DeviceInstance, config: Config, private readonly secrets: Secrets, client?: HomeConnectTransport) {
    super(instance.id, instance.name, config);
    this.client = client ?? new HomeConnectClient({ ...config, key: secrets.key, iv: secrets.iv, id: instance.id });
    this.cooktop = new BoschCooktop(instance.id, this.client);
    this.capabilities = this.expose({ cooktop: this.cooktop });
  }
  override async probe(): Promise<DeviceIdentity> { await this.client.read(); return this.identity(); }
  protected override identity(): DeviceIdentity { return { model: "NITP060UC", ...(this.secrets.serialNumber ? { serialNumber: this.secrets.serialNumber } : {}) }; }
  override async close(): Promise<void> { this.client.close(); }
}
export const BOSCH_NITP060UC: DeviceModel<Config> = {
  id: "bosch-nitp060uc", title: "Bosch Benchmark induction cooktop", manufacturer: "Bosch", product: "NITP060UC",
  capabilities: ["cooktop"], connectionTypes: ["direct-local"], configSchema: BOSCH_NITP060UC_CONFIG_SCHEMA, secretsSchema: BOSCH_NITP060UC_SECRETS_SCHEMA, objectSchemaId: cooktopSchema.$id,
  create: (instance, config, _services, secrets: SecretsBag) => new BoschNITP060UC(instance, config, secrets as Secrets),
};

class ChildLockSwitch extends BinarySwitch {
  constructor(id: string, private readonly cooktop: Cooktop) { super(id); }
  async getState(): Promise<BinarySwitchState> {
    const state = await this.cooktop.getState();
    // An unrelated missing burner/timer reading does not invalidate a confirmed lock reading.
    if ((state.availability !== "online" && state.availability !== "degraded") || typeof state.childLocked !== "boolean") throw new BinarySwitchError("Cooktop child lock is unavailable", "unreachable");
    return state.childLocked ? "on" : "off";
  }
  async turnOn(): Promise<void> { await this.cooktop.setChildLock(true); }
  async turnOff(): Promise<void> { await this.cooktop.setChildLock(false); }
  async toggle(): Promise<void> { await this.cooktop.setChildLock(await this.getState() !== "on"); }
}
const childConfigSchema = {
  $id: "https://hometruth.ai/schemas/models/cooktop-child-lock/config", type: "object", additionalProperties: false,
  properties: { cooktop: { type: "string", minLength: 1, maxLength: 100 } }, required: ["cooktop"],
} as const;
type ChildConfig = FromSchema<typeof childConfigSchema>;
export class CooktopChildLock extends Device<ChildConfig> {
  readonly model = COOKTOP_CHILD_LOCK;
  readonly capabilities;
  override readonly parent;
  constructor(instance: DeviceInstance, config: ChildConfig, context: DeviceCreationContext) {
    super(instance.id, instance.name, config);
    // No reference intent: this device declares its relationship to the cooktop
    // through `parent`, which is physical containment and reaches the object
    // document. Recording a second, logical edge here would duplicate it and
    // point the wrong way.
    const capability = context.device(config.cooktop).capability("cooktop");
    if (!(capability instanceof Cooktop)) throw new Error("Child lock must reference a cooktop");
    this.parent = { id: config.cooktop, index: 0 };
    this.capabilities = this.expose({ binarySwitch: new ChildLockSwitch(instance.id, capability) });
  }
  override async probe(): Promise<DeviceIdentity> { await this.capabilities.binarySwitch.getState(); return { model: "Cooktop child lock" }; }
}
export const COOKTOP_CHILD_LOCK: DeviceModel<ChildConfig> = {
  id: "cooktop-child-lock", title: "Cooktop child lock", manufacturer: "HomeTruth", product: "Cooktop child lock",
  capabilities: ["binarySwitch"], connectionTypes: ["composed"], configSchema: childConfigSchema, objectSchemaId: binarySwitchSchema.$id,
  create(instance, config, _services, _secrets, context) {
    if (!context) throw new Error("Cooktop child lock must be provisioned as part of a site");
    return new CooktopChildLock(instance, config, context);
  },
};
