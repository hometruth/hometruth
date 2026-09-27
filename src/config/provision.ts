/**
 * Provisioning: config in, devices out. Every entry names a model from the
 * registry; its `config` is validated against that model's own config schema
 * and handed to the model's factory. Any problem names the entry.
 */
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { Device, DeviceCreationContext, DeviceModel, ReferenceIntent, SecretsBag, SiteServices } from "../models/device";
import type { DevicesConfig, SecretsFile } from "../schemas";
import { describeValidationErrors } from "../validation";
import { DevicesConfigError, type DeviceConfigEntry } from "./devices";
import { EMPTY_SECRETS, secretsFor } from "./secrets";

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);
const compiled = new Map<string, ValidateFunction>();

function validatorFor(key: string, schema: DeviceModel["configSchema"]): ValidateFunction {
  let validate = compiled.get(key);
  if (!validate) {
    validate = ajv.compile(schema);
    compiled.set(key, validate);
  }
  return validate;
}

/** Build one device from one config entry and that entry's secrets. */
export function provisionDevice(
  entry: DeviceConfigEntry,
  models: readonly DeviceModel[],
  services: SiteServices,
  secrets: SecretsFile = EMPTY_SECRETS,
  context?: DeviceCreationContext,
): Device {
  const model = models.find((candidate) => candidate.id === entry.model);
  if (!model) {
    throw new DevicesConfigError(
      `Device "${entry.id}" uses unknown model "${entry.model}"; known models: ${models.map((candidate) => candidate.id).join(", ")}`,
      "invalid_config",
    );
  }
  const validate = validatorFor(`${model.id}:config`, model.configSchema);
  if (!validate(entry.config)) {
    throw new DevicesConfigError(
      `Device "${entry.id}" has invalid ${model.title} config: ${describeValidationErrors(validate.errors)}`,
      "invalid_config",
    );
  }
  let deviceSecrets: SecretsBag = {};
  if (model.secretsSchema) {
    deviceSecrets = secretsFor(secrets, "devices", entry.id);
    const validateSecrets = validatorFor(`${model.id}:secrets`, model.secretsSchema);
    if (!validateSecrets(deviceSecrets)) {
      throw new DevicesConfigError(
        `Device "${entry.id}" has invalid ${model.title} secrets (devices.${entry.id} in the secrets file): ${describeValidationErrors(validateSecrets.errors)}`,
        "invalid_config",
      );
    }
  }
  const device = model.create({ id: entry.id, name: entry.name ?? entry.id }, entry.config, services, deviceSecrets, context);
  if (entry.room) device.room = entry.room;
  if (entry.icon) device.icon = entry.icon;
  device.enabled = entry.enabled !== false;
  return device;
}

/**
 * One resolved device-to-device reference, recorded where it was made.
 *
 * Composites do not receive id strings; they receive live sibling objects
 * through `DeviceCreationContext.device()`. That call is the moment the real
 * relationship is known, so recording it there is the one description that
 * cannot drift from what was actually wired up.
 */
export interface ResolvedReference {
  readonly from: string;
  readonly to: string;
  readonly relation: NonNullable<ReferenceIntent["relation"]>;
  readonly label?: string;
  readonly capability?: NonNullable<ReferenceIntent["capability"]>;
}

export interface ProvisionResult {
  readonly devices: Device[];
  readonly references: readonly ResolvedReference[];
}

/** Build every device in the config, in file order, and record what referred to what. */
export function provisionSite(
  config: DevicesConfig,
  models: readonly DeviceModel[],
  services: SiteServices,
  secrets: SecretsFile = EMPTY_SECRETS,
): ProvisionResult {
  const entries = config.devices ?? [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const built = new Map<string, Device>();
  const building: string[] = [];
  const references: ResolvedReference[] = [];
  const seen = new Set<string>();

  const build = (id: string, intent?: ReferenceIntent): Device => {
    const owner = building.at(-1);
    if (owner && intent && owner !== id) {
      const key = `${owner}\u0000${id}\u0000${intent.relation}\u0000${intent.label ?? ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        references.push({
          from: owner, to: id, relation: intent.relation,
          ...(intent.label ? { label: intent.label } : {}),
          ...(intent.capability ? { capability: intent.capability } : {}),
        });
      }
    }
    const existing = built.get(id);
    if (existing) return existing;
    const entry = byId.get(id);
    if (!entry) {
      throw new DevicesConfigError(`${owner ? `Device "${owner}" references` : "No configured device"} "${id}"`, "invalid_config");
    }
    const cycleStart = building.indexOf(id);
    if (cycleStart >= 0) {
      throw new DevicesConfigError(`Device composition cycle: ${[...building.slice(cycleStart), id].join(" -> ")}`, "invalid_config");
    }
    building.push(id);
    try {
      const device = provisionDevice(entry, models, services, secrets, { device: build });
      built.set(id, device);
      return device;
    } finally {
      building.pop();
    }
  };

  // A device with `enabled: false` stays fully provisioned (so it can still be
  // found, inspected, and re-enabled) but reports itself as disabled; anything
  // that must not actively poll or connect to it filters on `device.enabled`.
  const devices = entries.map((entry) => build(entry.id));
  for (const device of devices) device.validate?.();
  return { devices, references };
}

/** Build every device in the config, in file order. */
export function provision(
  config: DevicesConfig,
  models: readonly DeviceModel[],
  services: SiteServices,
  secrets: SecretsFile = EMPTY_SECRETS,
): Device[] {
  return provisionSite(config, models, services, secrets).devices;
}
