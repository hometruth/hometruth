/** A stateless Button projected from any configured device control. */
import type { FromSchema } from "json-schema-to-ts";
import { Button, type ButtonPressOptions } from "../../../models/button";
import { CapabilityError, type Availability } from "../../../models/capability";
import { Device, type CapabilityMethods, type DeviceCreationContext, type DeviceIdentity, type DeviceInstance, type DeviceModel, type SecretsBag, type SiteServices } from "../../../models/device";
import { MAX_SEND_DURATION_MS } from "../../../models/blaster";
import type { SignalCodeStore } from "../../../signal-code-store";
import { buttonSchema } from "../../../schemas";

export const ACTION_BUTTON_CONFIG_SCHEMA = {
  $id: "https://hometruth.ai/schemas/models/action-button/config",
  title: "Device action button config",
  type: "object",
  additionalProperties: false,
  properties: {
    device: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]*$", minLength: 1, maxLength: 100 },
    /** A control from the target device's flat control namespace. */
    control: { type: "string", pattern: "^[a-zA-Z][a-zA-Z0-9]*(?:\\.[a-zA-Z][a-zA-Z0-9]*)*$", minLength: 1, maxLength: 100 },
    /** Fixed argument sent to the control on every press. */
    value: {},
    /** Enables a hold; durationMs is merged into an object-valued fixed argument. */
    durationMaximumMs: { type: "integer", minimum: 0, maximum: 86400000 },
    /** Stable id of a command in the target IR/RF blaster's saved-code store. */
    savedCodeId: { type: "string", minLength: 1, maxLength: 100 },
  },
  required: ["device"],
  oneOf: [
    { properties: { control: {}, savedCodeId: false }, required: ["control"] },
    { properties: { savedCodeId: {}, control: false, value: false, durationMaximumMs: false }, required: ["savedCodeId"] },
  ],
} as const;

export type ActionButtonConfig = FromSchema<typeof ACTION_BUTTON_CONFIG_SCHEMA>;

declare module "../../../models/device" {
  interface SiteServices {
    /** Shared saved IR/RF command catalog used by saved-command buttons and the blaster UI. */
    signalCodes?: SignalCodeStore;
  }
}

export class DeviceActionButton extends Button {
  constructor(
    id: string,
    readonly config: ActionButtonConfig,
    private readonly target: Device,
    private readonly signalCodes?: SignalCodeStore,
  ) {
    super(id);
    if (config.control && config.durationMaximumMs !== undefined && (!config.value || typeof config.value !== "object" || Array.isArray(config.value))) {
      throw new CapabilityError("A duration-aware action button needs an object-valued fixed value", "invalid_value");
    }
    if (config.savedCodeId && !signalCodes) {
      throw new CapabilityError("Saved-command buttons require the shared signal-code store", "not_supported");
    }
  }

  protected override maximumDurationMs(): number | undefined {
    return this.config.savedCodeId ? MAX_SEND_DURATION_MS : this.config.durationMaximumMs;
  }

  /** Reachable exactly when the device this button presses is. */
  protected override async availability(): Promise<Availability> {
    return await this.target.availability();
  }

  protected override async performPress(options: ButtonPressOptions): Promise<void> {
    if (this.config.savedCodeId) return await this.pressSavedSignal(this.config.savedCodeId, options);
    const value = options.durationMs === undefined
      ? this.config.value
      : { ...(this.config.value as Record<string, unknown>), durationMs: options.durationMs };
    await this.target.invokeControl(this.config.control!, value);
  }

  private async pressSavedSignal(codeId: string, options: ButtonPressOptions): Promise<void> {
    const saved = (await this.signalCodes!.list(this.target.id)).find((candidate) => candidate.id === codeId);
    if (!saved) throw new CapabilityError(`No saved command "${codeId}" exists for ${this.target.name}`, "not_supported");
    const capability = this.target.capability(saved.channel === "infrared" ? "infraredBlaster" : "radioFrequencyBlaster");
    if (!capability) throw new CapabilityError(`${this.target.name} no longer exposes the saved command's ${saved.channel} channel`, "not_supported");
    const durationMs = options.durationMs ?? saved.durationMs ?? 0;
    await capability.invoke("send", durationMs > 0 ? { code: saved.code, durationMs } : saved.code);
  }
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ActionButtonDevice extends CapabilityMethods<{ button: DeviceActionButton }> {}

export class ActionButtonDevice extends Device<ActionButtonConfig> {
  readonly model = ACTION_BUTTON;
  readonly capabilities;
  readonly button: DeviceActionButton;
  private readonly target: Device;

  constructor(instance: DeviceInstance, config: ActionButtonConfig, services: SiteServices, context: DeviceCreationContext) {
    super(instance.id, instance.name, config);
    this.target = context.device(config.device, { relation: "uses" });
    if (config.control) this.target.resolveControl(config.control);
    this.button = new DeviceActionButton(instance.id, config, this.target, services.signalCodes);
    this.capabilities = this.expose({ button: this.button });
  }

  override async probe(): Promise<DeviceIdentity> { return await this.target.probe(); }
  override displayHost(): string { return `action on ${this.target.name}`; }
}

export const ACTION_BUTTON: DeviceModel<ActionButtonConfig> = {
  id: "action-button",
  title: "Device action button",
  manufacturer: "HomeTruth",
  product: "Action button",
  capabilities: ["button"],
  connectionTypes: ["composed"],
  configSchema: ACTION_BUTTON_CONFIG_SCHEMA,
  objectSchemaId: buttonSchema.$id,
  create(instance: DeviceInstance, config: ActionButtonConfig, services: SiteServices, _secrets: SecretsBag, context?: DeviceCreationContext): ActionButtonDevice {
    if (!context) throw new CapabilityError("An action button must be provisioned as part of a site", "not_supported");
    return new ActionButtonDevice(instance, config, services, context);
  },
};
