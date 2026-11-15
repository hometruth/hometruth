/** A binary switch made from on/off Buttons and optimistic remembered state; the same Button for both is a power-button toggle. */
import type { FromSchema } from "json-schema-to-ts";
import type { BinarySwitch as BinarySwitchDocument } from "../../../schemas";
import { BinarySwitch, BinarySwitchError, type BinarySwitchState } from "../../../models/binary-switch";
import { Button } from "../../../models/button";
import type { Availability } from "../../../models/capability";
import { Device, type CapabilityMethods, type DeviceCreationContext, type DeviceIdentity, type DeviceInstance, type DeviceModel, type SecretsBag, type SiteServices } from "../../../models/device";
import { binarySwitchSchema } from "../../../schemas";
import { describeValidationErrors, validators } from "../../../validation";
import { MemoryOptimisticSwitchStateStore, type OptimisticSwitchMemory, type OptimisticSwitchState, type OptimisticSwitchStateStore } from "./state-store";
export { MemoryOptimisticSwitchStateStore, SqliteOptimisticSwitchStateStore, type OptimisticSwitchStateStore } from "./state-store";

declare module "../../../models/device" {
  interface SiteServices {
    /** Shared across reloads; production retains the last command across restarts. */
    optimisticSwitchStates?: OptimisticSwitchStateStore;
  }
}

export const OPTIMISTIC_SWITCH_CONFIG_SCHEMA = {
  $id: "https://hometruth.ai/schemas/models/optimistic-switch/config",
  title: "Optimistic button-pair switch config",
  type: "object",
  additionalProperties: false,
  properties: {
    onButton: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]*$", minLength: 1, maxLength: 100 },
    offButton: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]*$", minLength: 1, maxLength: 100 },
    /** Optional starting assumption before either button has been pressed. Without it, state begins unknown. */
    initialState: { enum: ["on", "off"] },
  },
  required: ["onButton", "offButton"],
} as const;

export type OptimisticSwitchConfig = FromSchema<typeof OPTIMISTIC_SWITCH_CONFIG_SCHEMA>;

export class OptimisticButtonSwitch extends BinarySwitch {
  private readonly unsubscribes: readonly (() => void)[];
  private readonly memory: OptimisticSwitchMemory;
  private readonly assumption: OptimisticSwitchState | undefined;

  /** Same Button for both: a power-button toggle, so a press flips remembered state instead of naming on or off. */
  private readonly isToggle: boolean;

  constructor(
    id: string,
    readonly onButton: Button,
    readonly offButton: Button,
    states: OptimisticSwitchStateStore,
    private readonly availability: () => Availability,
    initialState?: BinarySwitchState,
    private readonly now: () => Date = () => new Date(),
  ) {
    super(id);
    this.isToggle = onButton === offButton;
    this.memory = states.forSwitch(id, onButton.id, offButton.id);
    this.assumption = initialState === undefined ? undefined : { value: initialState, source: "assumed", at: this.now().toISOString() };
    this.unsubscribes = this.isToggle
      ? [onButton.subscribe(() => this.remember(this.remembered()?.value === "on" ? "off" : "on"))]
      : [
          onButton.subscribe(() => this.remember("on")),
          offButton.subscribe(() => this.remember("off")),
        ];
  }

  private remembered(): OptimisticSwitchState | undefined { return this.memory.get() ?? this.assumption; }

  private remember(value: BinarySwitchState): void {
    this.memory.set({ value, source: "commanded", at: this.now().toISOString() });
  }

  async turnOn(): Promise<void> {
    if (this.isToggle) { if (this.remembered()?.value !== "on") await this.onButton.press(); return; }
    await this.onButton.press();
  }
  async turnOff(): Promise<void> {
    if (this.isToggle) { if (this.remembered()?.value !== "off") await this.offButton.press(); return; }
    await this.offButton.press();
  }
  async toggle(): Promise<void> {
    if (this.isToggle) { await this.onButton.press(); return; }
    if (this.remembered()?.value === "on") await this.turnOff();
    else await this.turnOn();
  }
  async getState(): Promise<BinarySwitchState> {
    const state = this.remembered();
    if (!state) throw new BinarySwitchError("No button has been pressed yet, so this optimistic switch's state is unknown", "unknown_state");
    return state.value;
  }

  /** Snapshot combining the remembered value with the buttons' own reachability, not this switch's own memory. */
  override async describe(): Promise<BinarySwitchDocument> {
    const actions = { turnOn: {}, turnOff: {}, toggle: {}, getState: {} } as const;
    const availability = this.availability();
    const remembered = this.remembered();
    const candidate: unknown = remembered === undefined
      ? { id: this.id, state: { availability }, actions }
      : { id: this.id, state: { availability, value: remembered.value, stateSource: remembered.source,
        ...(remembered.source === "commanded" ? { commandedAt: remembered.at } : { assumedAt: remembered.at }) }, actions };
    if (!validators.binarySwitch(candidate)) {
      throw new Error(`Invalid binary switch document: ${describeValidationErrors(validators.binarySwitch.errors)}`);
    }
    return candidate;
  }

  close(): void { for (const unsubscribe of this.unsubscribes) unsubscribe(); }
}

function buttonFrom(context: DeviceCreationContext, id: string, label: string): { device: Device; button: Button } {
  const device = context.device(id, { relation: "uses", label, capability: "button" });
  const button = device.capability("button");
  if (!(button instanceof Button)) throw new BinarySwitchError(`${device.name} (${id}) is not a Button`, "protocol");
  return { device, button };
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface OptimisticSwitchDevice extends CapabilityMethods<{ binarySwitch: OptimisticButtonSwitch }> {}

export class OptimisticSwitchDevice extends Device<OptimisticSwitchConfig> {
  readonly model = OPTIMISTIC_SWITCH;
  readonly capabilities;
  readonly switch: OptimisticButtonSwitch;
  override readonly availabilitySources: readonly Device[];

  constructor(instance: DeviceInstance, config: OptimisticSwitchConfig, services: SiteServices, context: DeviceCreationContext) {
    super(instance.id, instance.name, config);
    const states = services.optimisticSwitchStates ?? new MemoryOptimisticSwitchStateStore();
    const on = buttonFrom(context, config.onButton, "on");
    const off = buttonFrom(context, config.offButton, "off");
    this.availabilitySources = [...new Set([on.device, off.device])];
    this.switch = new OptimisticButtonSwitch(
      instance.id,
      on.button,
      off.button,
      states,
      () => this.availability(),
      config.initialState,
    );
    this.capabilities = this.expose({ binarySwitch: this.switch });
  }

  override async probe(): Promise<DeviceIdentity> {
    return { model: OPTIMISTIC_SWITCH.product };
  }
  override displayHost(): string {
    return this.config.onButton === this.config.offButton ? `button ${this.config.onButton}` : `buttons ${this.config.onButton} + ${this.config.offButton}`;
  }
  override async close(): Promise<void> { this.switch.close(); }
}

export const OPTIMISTIC_SWITCH: DeviceModel<OptimisticSwitchConfig> = {
  id: "optimistic-switch",
  title: "Optimistic button-pair switch",
  manufacturer: "HomeTruth",
  product: "Optimistic switch",
  capabilities: ["binarySwitch"],
  connectionTypes: ["composed"],
  configSchema: OPTIMISTIC_SWITCH_CONFIG_SCHEMA,
  objectSchemaId: binarySwitchSchema.$id,
  create(instance: DeviceInstance, config: OptimisticSwitchConfig, services: SiteServices, _secrets: SecretsBag, context?: DeviceCreationContext): OptimisticSwitchDevice {
    if (!context) throw new BinarySwitchError("An optimistic switch must be provisioned as part of a site", "protocol");
    return new OptimisticSwitchDevice(instance, config, services, context);
  },
};
