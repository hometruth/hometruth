/**
 * Site-specific devices live in a separate private installation YAML file so that the generic
 * HomeTruth project never carries one home's addresses. See devices.example.yml.
 *
 * Each entry is `model + config`: the model id names a `DeviceModel` from the
 * registry, and `config` is validated against that model's own config schema
 * when the site is provisioned (`provision.ts`).
 */
import type { DevicesConfig } from "../schemas";
import { describeValidationErrors, validators } from "../validation";

export const DEFAULT_DEVICES_CONFIG_PATH = "devices.yml";

export type DevicesConfigErrorCode = "missing" | "invalid_yaml" | "invalid_config";

export class DevicesConfigError extends Error {
  constructor(message: string, readonly code: DevicesConfigErrorCode) {
    super(message);
    this.name = "DevicesConfigError";
  }
}

export type DeviceConfigEntry = NonNullable<DevicesConfig["devices"]>[number];

export function parseDevicesConfig(text: string, source = DEFAULT_DEVICES_CONFIG_PATH): DevicesConfig {
  let candidate: unknown;
  try {
    candidate = Bun.YAML.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DevicesConfigError(`${source} is not valid YAML: ${detail}`, "invalid_yaml");
  }
  if (candidate === null || candidate === undefined) candidate = {};
  if (!validators.devicesConfig(candidate)) {
    throw new DevicesConfigError(
      `${source} is invalid: ${describeValidationErrors(validators.devicesConfig.errors)}`,
      "invalid_config",
    );
  }
  const ids = new Set<string>();
  for (const entry of candidate.devices ?? []) {
    if (ids.has(entry.id)) {
      throw new DevicesConfigError(`${source} defines device "${entry.id}" more than once`, "invalid_config");
    }
    ids.add(entry.id);
  }
  const groupIds = new Set<string>();
  for (const group of candidate.deviceGroups ?? []) {
    if (groupIds.has(group.id)) throw new DevicesConfigError(`${source} defines group "${group.id}" more than once`, "invalid_config");
    if (group.id.startsWith("automatic:")) throw new DevicesConfigError(`Group ids beginning with automatic: are reserved`, "invalid_config");
    groupIds.add(group.id);
    for (const id of group.members ?? []) {
      if (!ids.has(id)) throw new DevicesConfigError(`Group "${group.id}" references missing device "${id}"`, "invalid_config");
    }
  }
  return candidate;
}

export async function loadDevicesConfig(path = DEFAULT_DEVICES_CONFIG_PATH): Promise<DevicesConfig> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new DevicesConfigError(
      `${path} was not found; copy devices.example.yml to ${DEFAULT_DEVICES_CONFIG_PATH} and describe this site's devices`,
      "missing",
    );
  }
  return parseDevicesConfig(await file.text(), path);
}

/** The configured LAN addresses of every enabled entry for one model, in file order, without duplicates. */
export function hostsForModel(config: DevicesConfig, modelId: string): string[] {
  const hosts = new Set<string>();
  for (const entry of config.devices ?? []) {
    if (entry.enabled === false) continue;
    const host = entry.model === modelId ? entry.config.host : undefined;
    if (typeof host === "string" && host) hosts.add(host);
  }
  return [...hosts];
}
