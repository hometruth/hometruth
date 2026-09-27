/** A binary switch made from on/off Buttons and optimistic remembered state; the same Button for both is a power-button toggle. */
import type { FromSchema } from "json-schema-to-ts";
import type { BinarySwitch as BinarySwitchDocument } from "../../../schemas";
import { BinarySwitch, BinarySwitchError, type BinarySwitchState } from "../../../models/binary-switch";
import { Button } from "../../../models/button";
import { combinedAvailability } from "../../../models/capability";
import { Device, type CapabilityMethods, type DeviceCreationContext, type DeviceIdentity, type DeviceInstance, type DeviceModel, type SecretsBag, type SiteServices } from "../../../models/device";
import { binarySwitchSchema } from "../../../schemas";
import { describeValidationErrors, validators } from "../../../validation";

export interface OptimisticSwitchStateStore {
  get(id: string): BinarySwitchState | undefined;
  set(id: string, state: BinarySwitchState): void;
}

export class MemoryOptimisticSwitchStateStore implements OptimisticSwitchStateStore {
  private readonly states = new Map<string, BinarySwitchState>();
  get(id: string) { return this.states.get(id); }
  set(id: string, state: BinarySwitchState) { this.states.set(id, state); }
}

declare module "../../../models/device" {
  interface SiteServices {
    /** Shared across live config reloads so optimistic state is not reset by an edit. */
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

  /** Same Button for both: a power-button toggle, so a press flips remembered state instead of naming on or off. */
  private readonly isToggle: boolean;

  constructor(
    id: string,
    readonly onButton: Button,
    readonly offButton: Button,
    private readonly states: OptimisticSwitchStateStore,
    initialState?: BinarySwitchState,
  ) {
    super(id);
    this.isToggle = onButton === offButton;
    if (states.get(id) === undefined && initialState !== undefined) states.set(id, initialState);
    this.unsubscribes = this.isToggle
      ? [onButton.subscribe(() => states.set(id, states.get(id) === "on" ? "off" : "on"))]
      : [
          onButton.subscribe(() => states.set(id, "on")),
          offButton.subscribe(() => states.set(id, "off")),
        ];
  }

  async turnOn(): Promise<void> {
    if (this.isToggle) { if (this.states.get(this.id) !== "on") await this.onButton.press(); return; }
    await this.onButton.press();
  }
  async turnOff(): Promise<void> {
    if (this.isToggle) { if (this.states.get(this.id) !== "off") await this.offButton.press(); return; }
    await this.offButton.press();
  }
  async toggle(): Promise<void> {
    if (this.isToggle) { await this.onButton.press(); return; }
    if (this.states.get(this.id) === "on") await this.turnOff();
    else await this.turnOn();
  }
  async getState(): Promise<BinarySwitchState> {
    const state = this.states.get(this.id);
    if (!state) throw new BinarySwitchError("No button has been pressed yet, so this optimistic switch's state is unknown", "unknown_state");
    return state;
  }

  /** This switch is only ever as reachable as the button(s) that carry out its presses. */
  private async buttonsAvailability(): Promise<ReturnType<typeof combinedAvailability>> {
    const buttons = this.isToggle ? [this.onButton] : [this.onButton, this.offButton];
    const documents = await Promise.all(buttons.map((button) => button.describe()));
    return combinedAvailability(documents.map((document) => document.state.availability));
  }

  /** Snapshot combining the remembered value with the buttons' own reachability, not this switch's own memory. */
  override async describe(): Promise<BinarySwitchDocument> {
    const actions = { turnOn: {}, turnOff: {}, toggle: {}, getState: {} } as const;
    const availability = await this.buttonsAvailability();
    const value = this.states.get(this.id);
    const candidate: unknown = value === undefined
      ? { id: this.id, state: { availability }, actions }
      : { id: this.id, state: { availability, value, observedAt: new Date().toISOString() }, actions };
    if (!validators.binarySwitch(candidate)) {
      throw new Error(`Invalid binary switch document: ${describeValidationErrors(validators.binarySwitch.errors)}`);
    }
    return candidate;
  }

  close(): void { for (const unsubscribe of this.unsubscribes) unsubscribe(); }
}

function buttonFrom(context: DeviceCreationContext, id: string, label: string): Button {
  const device = context.device(id, { relation: "uses", label, capability: "button" });
  const button = device.capability("button");
  if (!(button instanceof Button)) throw new BinarySwitchError(`${device.name} (${id}) is not a Button`, "protocol");
  return button;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface OptimisticSwitchDevice extends CapabilityMethods<{ binarySwitch: OptimisticButtonSwitch }> {}

export class OptimisticSwitchDevice extends Device<OptimisticSwitchConfig> {
  readonly model = OPTIMISTIC_SWITCH;
  readonly capabilities;
  readonly switch: OptimisticButtonSwitch;

  constructor(instance: DeviceInstance, config: OptimisticSwitchConfig, services: SiteServices, context: DeviceCreationContext) {
    super(instance.id, instance.name, config);
    const states = services.optimisticSwitchStates ?? new MemoryOptimisticSwitchStateStore();
    this.switch = new OptimisticButtonSwitch(
      instance.id,
      buttonFrom(context, config.onButton, "on"),
      buttonFrom(context, config.offButton, "off"),
      states,
      config.initialState,
    );
    this.capabilities = this.expose({ binarySwitch: this.switch });
  }

  override async probe(): Promise<DeviceIdentity> {
    const { state } = await this.switch.describe();
    if (state.availability === "offline") throw new BinarySwitchError("The switch's buttons are unavailable", "unreachable");
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
