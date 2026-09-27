#!/usr/bin/env bun

import { resolve } from "node:path";
import { captureCameraSnapshot, type CameraMediaSource } from "../../camera-media.ts";
import {
  PET3T_CONTROL_BY_ID,
  PET3T_CONTROL_CATALOG,
  type ControlDefinition,
} from "../../devices/treat-dispensers/tkenpro-2k-pet-camera-treat-dispenser/controls.ts";
import { MeariClient } from "../../protocols/tkenpro/client.ts";
import {
  discoverCameras,
  isLocalProbeHost,
  type DiscoverCameraOptions,
  type DiscoveryReport,
} from "../../protocols/tkenpro/discovery.ts";
import {
  OnvifClient,
  redactRtspUri,
  type OnvifCapabilities,
  type OnvifClientConfig,
  type OnvifDeviceInformation,
  type OnvifMediaUri,
  type OnvifProfile,
  type OnvifPtzSpeed,
} from "../../protocols/onvif/client";
import type {
  AppProfileName,
  DestructiveConfirmation,
  IotValue,
  IotValues,
  MeariClientConfig,
  MeariDevice,
  MeariLoginResult,
} from "../../protocols/tkenpro/types.ts";

const HELP = `HomeTruth TKENPRO camera CLI

Usage:
  tkenpro discover [--host IP] [--cidr CIDR] [--json]
  tkenpro info --host IP [local options] [--json]
  tkenpro media --host IP [local options] [--json]
  tkenpro snapshot --host IP --output FILE [local options] [--force] [--json]
  tkenpro ptz <left|right|up|down|stop|home> --host IP [local options]
  tkenpro status [cloud options] [--json]
  tkenpro get [CONTROL_ID] [cloud options] [--json]
  tkenpro set CONTROL_ID VALUE [cloud options] [--confirm VALUE] [--json]
  tkenpro controls [--json]

Local options:
  --host IP                  Private camera address (or TKENPRO_CAMERA_HOST)
  --username NAME            ONVIF username (default: ONVIF_USERNAME or admin)
  --camera-password-env NAME Environment variable holding the camera password
                              (default: ONVIF_PASSWORD)
  --onvif-port PORT          ONVIF port (default: 8000)
  --timeout-ms MS            Request timeout (100-30000; default: 5000)

Cloud options:
  --profile NAME             tkenpro or cloudedge (default: TKENPRO_PROFILE or tkenpro)
  --account-env NAME         Environment variable holding the owner account
                              (default: TKENPRO_EMAIL)
  --app-password-env NAME    Environment variable holding the app password
                              (default: TKENPRO_PASSWORD)
  --country CODE             Account country (default: TKENPRO_COUNTRY or US)
  --phone-code CODE          Optional dialing prefix (or TKENPRO_PHONE_CODE)
  --serial SERIAL            Camera serial (or TKENPRO_SERIAL); optional for one camera

Safety:
  Caution controls require --confirm CONTROL_ID.
  Destructive controls require their exact literal shown by "tkenpro controls".
  PTZ movement has a three-second maximum lease and always sends stop.
  Secrets are accepted only through environment variables and are never printed.
`;

const BOOLEAN_OPTIONS = new Set(["force", "help", "json"]);
const GLOBAL_OPTIONS = ["help", "json"] as const;
const LOCAL_OPTIONS = ["host", "username", "camera-password-env", "onvif-port", "timeout-ms"] as const;
const CLOUD_OPTIONS = ["profile", "account-env", "app-password-env", "country", "phone-code", "serial"] as const;
const DESTRUCTIVE_CONFIRMATIONS: Readonly<Record<string, DestructiveConfirmation>> = Object.freeze({
  formatStorage: "FORMAT_STORAGE",
  deleteStorageFiles: "DELETE_STORAGE_FILES",
  restoreFactory: "RESTORE_FACTORY_SETTINGS",
  resetDevice: "RESET_DEVICE",
  hardReset: "HARD_RESET_DEVICE",
});
const SENSITIVE_IOT_CODES = new Set(["122"]);

type Environment = Readonly<Record<string, string | undefined>>;
type Output = (text: string) => void;

interface CliCloudClient {
  login(): Promise<Pick<MeariLoginResult, "devices">>;
  getDeviceStatus(serialNumber: string): Promise<string>;
  getAllIotValues(serialNumber: string): Promise<IotValues>;
  getIotValues(serialNumber: string, codes: readonly (string | number)[]): Promise<IotValues>;
  configureOnvif(
    serialNumber: string,
    configuration: { readonly enabled: boolean; readonly password: string },
  ): Promise<unknown>;
  setControl(
    serialNumber: string,
    controlId: string,
    value: IotValue,
    options?: { readonly confirmation?: DestructiveConfirmation },
  ): Promise<unknown>;
}

interface CliOnvifClient {
  readonly serviceUrls: Readonly<Partial<Record<"device" | "media" | "ptz" | "imaging", string>>>;
  getDeviceInformation(): Promise<OnvifDeviceInformation>;
  getCapabilities(): Promise<OnvifCapabilities>;
  getProfiles(): Promise<OnvifProfile[]>;
  getStreamUri(profileToken: string): Promise<OnvifMediaUri>;
  getSnapshotUri(profileToken: string): Promise<OnvifMediaUri>;
  continuousMove(profileToken: string, velocity: OnvifPtzSpeed, timeout?: string): Promise<void>;
  stop(profileToken: string, panTilt?: boolean, zoom?: boolean): Promise<void>;
  gotoHomePosition(profileToken: string, speed?: OnvifPtzSpeed): Promise<void>;
}

export interface CliDependencies {
  readonly env?: Environment;
  readonly stdout?: Output;
  readonly stderr?: Output;
  readonly discover?: (options?: DiscoverCameraOptions) => Promise<DiscoveryReport>;
  readonly createCloudClient?: (config: MeariClientConfig) => CliCloudClient;
  readonly createOnvifClient?: (config: OnvifClientConfig) => CliOnvifClient;
  readonly captureSnapshot?: (source: CameraMediaSource, timeoutMs?: number) => Promise<Uint8Array>;
  readonly fileExists?: (path: string) => Promise<boolean>;
  readonly writeFile?: (path: string, bytes: Uint8Array) => Promise<number>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly cwd?: string;
}

interface ParsedArguments {
  readonly command: string;
  readonly positionals: readonly string[];
  readonly options: ReadonlyMap<string, readonly string[]>;
  readonly flags: ReadonlySet<string>;
}

class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  let command = "";
  const positionals: string[] = [];
  const options = new Map<string, string[]>();
  const flags = new Set<string>();
  let positionalOnly = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (!positionalOnly && token === "--") {
      positionalOnly = true;
      continue;
    }
    if (!positionalOnly && token.startsWith("--")) {
      const separator = token.indexOf("=");
      const name = token.slice(2, separator < 0 ? undefined : separator);
      if (!/^[a-z][a-z0-9-]*$/u.test(name)) throw new CliUsageError(`Invalid option ${token}`);
      if (BOOLEAN_OPTIONS.has(name)) {
        if (separator >= 0) throw new CliUsageError(`--${name} does not accept a value`);
        flags.add(name);
        continue;
      }
      const inlineValue = separator < 0 ? undefined : token.slice(separator + 1);
      const next = inlineValue ?? argv[index + 1];
      if (next === undefined || (inlineValue === undefined && next.startsWith("--"))) {
        throw new CliUsageError(`--${name} requires a value`);
      }
      if (inlineValue === undefined) index += 1;
      const values = options.get(name) ?? [];
      values.push(next);
      options.set(name, values);
      continue;
    }
    if (!command) command = token;
    else positionals.push(token);
  }

  return { command, positionals, options, flags };
}

function option(parsed: ParsedArguments, name: string): string | undefined {
  const values = parsed.options.get(name);
  if (values === undefined) return undefined;
  if (values.length !== 1) throw new CliUsageError(`--${name} may be supplied only once`);
  return values[0];
}

function options(parsed: ParsedArguments, name: string): readonly string[] {
  return parsed.options.get(name) ?? [];
}

function assertAllowedOptions(parsed: ParsedArguments, allowed: readonly string[]): void {
  const names = new Set([...GLOBAL_OPTIONS, ...allowed]);
  for (const name of parsed.options.keys()) {
    if (!names.has(name)) {
      if (name === "password" || name.endsWith("-password")) {
        throw new CliUsageError(`--${name} is not accepted because command-line secrets can leak; use the corresponding --*-password-env option`);
      }
      throw new CliUsageError(`Unknown option --${name} for ${parsed.command}`);
    }
  }
  for (const flag of parsed.flags) {
    if (!names.has(flag)) throw new CliUsageError(`Unknown flag --${flag} for ${parsed.command}`);
  }
}

function integerOption(parsed: ParsedArguments, name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = option(parsed, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new CliUsageError(`--${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function numberOption(parsed: ParsedArguments, name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = option(parsed, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new CliUsageError(`--${name} must be from ${minimum} to ${maximum}`);
  }
  return value;
}

function environmentName(parsed: ParsedArguments, optionName: string, fallback: string): string {
  const name = option(parsed, optionName) ?? fallback;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
    throw new CliUsageError(`--${optionName} must name an environment variable`);
  }
  return name;
}

function requiredEnvironmentValue(env: Environment, name: string, label: string): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new CliUsageError(`${label} is missing; set ${name}`);
  }
  return value;
}

function localConnection(parsed: ParsedArguments, env: Environment): {
  readonly config: OnvifClientConfig;
  readonly host: string;
  readonly username: string;
  readonly password: string;
  readonly timeoutMs: number;
} {
  const host = (option(parsed, "host") ?? env.TKENPRO_CAMERA_HOST ?? "").trim().toLowerCase().replace(/\.$/u, "");
  if (!host) throw new CliUsageError("Camera host is missing; use --host or set TKENPRO_CAMERA_HOST");
  if (!isLocalProbeHost(host)) throw new CliUsageError("Camera host must be a private IPv4 address or local hostname");
  const port = integerOption(parsed, "onvif-port", 8000, 1, 65_535);
  const timeoutMs = integerOption(parsed, "timeout-ms", 5_000, 100, 30_000);
  const username = option(parsed, "username") ?? env.ONVIF_USERNAME ?? "admin";
  if (!username) throw new CliUsageError("ONVIF username must not be empty");
  const passwordName = environmentName(parsed, "camera-password-env", "ONVIF_PASSWORD");
  const password = requiredEnvironmentValue(env, passwordName, "Camera password");
  return {
    config: {
      deviceServiceUrl: `http://${host}:${port}/onvif/device_service`,
      username,
      password,
      timeoutMs,
    },
    host,
    username,
    password,
    timeoutMs,
  };
}

function cloudConfig(parsed: ParsedArguments, env: Environment): MeariClientConfig {
  const accountName = environmentName(parsed, "account-env", "TKENPRO_EMAIL");
  const passwordName = environmentName(parsed, "app-password-env", "TKENPRO_PASSWORD");
  const rawProfile = (option(parsed, "profile") ?? env.TKENPRO_PROFILE ?? "tkenpro").trim().toLowerCase();
  if (rawProfile !== "tkenpro" && rawProfile !== "cloudedge") {
    throw new CliUsageError("--profile must be tkenpro or cloudedge");
  }
  const phoneCode = option(parsed, "phone-code") ?? env.TKENPRO_PHONE_CODE;
  return {
    profile: rawProfile satisfies AppProfileName,
    email: requiredEnvironmentValue(env, accountName, "Owner account"),
    password: requiredEnvironmentValue(env, passwordName, "App password"),
    countryCode: (option(parsed, "country") ?? env.TKENPRO_COUNTRY ?? "US").trim().toUpperCase(),
    ...(phoneCode === undefined ? {} : { phoneCode }),
  };
}

function selectedDevice(devices: readonly MeariDevice[], requestedSerial: string | undefined): MeariDevice {
  const cameras = devices.filter((device) => typeof device.snNum === "string" && device.snNum.length > 0);
  if (requestedSerial !== undefined) {
    const normalizedRequest = requestedSerial.trim();
    const requestedIdentity = serialIdentity(normalizedRequest);
    const requestedHardwareId = /^\d{9}$/u.test(normalizedRequest) ? normalizedRequest : undefined;
    const matches = cameras.filter((candidate) =>
      serialIdentity(String(candidate.snNum)) === requestedIdentity
      || (
        requestedHardwareId !== undefined
        && typeof candidate.deviceName === "string"
        && /^\d{9}$/u.test(candidate.deviceName.trim())
        && candidate.deviceName.trim() === requestedHardwareId
      ),
    );
    if (matches.length === 0) throw new CliUsageError(`Camera serial ${requestedSerial} was not found in this account`);
    if (matches.length > 1) throw new CliUsageError(`Camera serial ${requestedSerial} matched more than one camera in this account`);
    const device = matches[0];
    if (device === undefined) throw new CliUsageError(`Camera serial ${requestedSerial} was not found in this account`);
    return device;
  }
  if (cameras.length === 0) throw new CliUsageError("No cameras were found in this account");
  if (cameras.length > 1) throw new CliUsageError("More than one camera was found; use --serial or set TKENPRO_SERIAL");
  const first = cameras[0];
  if (first === undefined) throw new CliUsageError("No cameras were found in this account");
  return first;
}

function serialIdentity(value: string): string {
  const normalized = value.trim().toLowerCase();
  const withoutPrefix = normalized.startsWith("ppsl") ? normalized.slice(4) : normalized;
  return /^\d{9}$/u.test(withoutPrefix) ? withoutPrefix.padStart(16, "0") : withoutPrefix;
}

function deviceSummary(device: MeariDevice): Record<string, unknown> {
  return {
    serialNumber: device.snNum ?? null,
    name: device.deviceName ?? null,
    deviceId: device.deviceID ?? null,
    typeId: device.devTypeID ?? null,
    category: device._category ?? null,
  };
}

function controlSummary(definition: Readonly<ControlDefinition>): Record<string, unknown> {
  const destructiveConfirmation = DESTRUCTIVE_CONFIRMATIONS[definition.id];
  return {
    id: definition.id,
    code: definition.code,
    label: definition.label,
    category: definition.category,
    kind: definition.kind,
    access: definition.access,
    safety: definition.safety,
    ...(definition.min === undefined ? {} : { min: definition.min }),
    ...(definition.max === undefined ? {} : { max: definition.max }),
    ...(definition.options === undefined ? {} : { options: definition.options }),
    ...(definition.description === undefined ? {} : { description: definition.description }),
    ...(destructiveConfirmation === undefined ? {} : { confirmation: destructiveConfirmation }),
  };
}

function profileSummary(profile: OnvifProfile): Record<string, unknown> {
  return {
    token: profile.token,
    name: profile.name ?? null,
    fixed: profile.fixed ?? null,
    videoSourceConfigurationToken: profile.videoSourceConfigurationToken ?? null,
    ptzConfigurationToken: profile.ptzConfigurationToken ?? null,
    videoEncoderConfiguration: profile.videoEncoderConfiguration ?? null,
  };
}

function capabilitySummary(capabilities: OnvifCapabilities): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(capabilities)
      .filter(([key]) => key !== "rawXml")
      .map(([key, value]) => [key, typeof value === "string" ? redactMediaUri(value) : value]),
  );
}

function serviceUrlSummary(serviceUrls: CliOnvifClient["serviceUrls"]): Record<string, string> {
  return Object.fromEntries(
    Object.entries(serviceUrls).map(([key, value]) => [key, redactMediaUri(value)]),
  );
}

function redactMediaUri(uri: string): string {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol === "rtsp:" || parsed.protocol === "rtsps:") return redactRtspUri(uri);
    if (parsed.username || parsed.password) {
      parsed.username = "redacted";
      parsed.password = "redacted";
    }
    return parsed.toString();
  } catch {
    return "[invalid media URI]";
  }
}

function parseControlValue(raw: string): IotValue {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "on") return true;
  if (normalized === "false" || normalized === "off") return false;
  if (normalized === "null") return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(raw.trim())) return Number(raw);
  if (raw.startsWith("{") || raw.startsWith("[") || raw.startsWith('"')) {
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new CliUsageError("Control VALUE begins like JSON but is not valid JSON");
    }
    if (!isJsonValue(value)) throw new CliUsageError("Control VALUE must be JSON-compatible");
    return value;
  }
  return raw;
}

function isJsonValue(value: unknown): value is IotValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function safeIotValues(values: IotValues): Record<string, IotValue | string> {
  return Object.fromEntries(
    Object.entries(values).map(([code, value]) => [code, SENSITIVE_IOT_CODES.has(code) ? "[redacted]" : sanitizeValue(value)]),
  );
}

function sanitizeValue(value: IotValue): IotValue | string {
  if (typeof value === "string") {
    if (/^(?:rtsp|rtsps|https?):\/\//iu.test(value)) return redactMediaUri(value);
    return value;
  }
  if (Array.isArray(value)) return value.map(sanitizeValue) as IotValue;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [isSensitiveKey(key) ? key : key, isSensitiveKey(key) ? "[redacted]" : sanitizeValue(child)]),
    ) as IotValue;
  }
  return value;
}

function isSensitiveKey(key: string): boolean {
  return /(?:password|passwd|token|secret|signature|accesskey|clientid)/iu.test(key);
}

function redactError(error: unknown, secrets: readonly string[]): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets.filter((value) => value.length > 0).sort((left, right) => right.length - left.length)) {
    message = message.replaceAll(secret, "[redacted]");
  }
  message = message.replace(/(?:rtsp|rtsps|https?):\/\/[^\s/@:]+:[^\s/@]+@/giu, (match) => {
    const separator = match.indexOf("://") + 3;
    const at = match.lastIndexOf("@");
    return `${match.slice(0, separator)}redacted:redacted${match.slice(at)}`;
  });
  return message;
}

function credentialSecrets(parsed: ParsedArguments, env: Environment): string[] {
  const names = new Set(["ONVIF_PASSWORD", "TKENPRO_PASSWORD", "TKENPRO_EMAIL"]);
  for (const optionName of ["camera-password-env", "app-password-env", "account-env"] as const) {
    for (const name of parsed.options.get(optionName) ?? []) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) names.add(name);
    }
  }
  for (const key of Object.keys(env)) {
    if (/(?:PASSWORD|TOKEN|SECRET|SIGNATURE|ACCESS_KEY)/u.test(key)) names.add(key);
  }
  return [...names].flatMap((name) => {
    const value = env[name];
    return value === undefined || value.length === 0 ? [] : [value];
  });
}

function emitResult(output: Output, value: unknown, compact: boolean): void {
  output(`${JSON.stringify(value, null, compact ? undefined : 2)}\n`);
}

async function onvifProfiles(client: CliOnvifClient): Promise<OnvifProfile[]> {
  await client.getCapabilities();
  const profiles = await client.getProfiles();
  if (profiles.length === 0) throw new CliUsageError("The camera returned no ONVIF media profiles");
  return profiles;
}

async function mediaForProfile(client: CliOnvifClient, profile: OnvifProfile, secrets: readonly string[]): Promise<Record<string, unknown>> {
  const [stream, snapshot] = await Promise.all([
    client.getStreamUri(profile.token).then((value) => ({ uri: redactMediaUri(value.uri) })).catch((error: unknown) => ({ error: redactError(error, secrets) })),
    client.getSnapshotUri(profile.token).then((value) => ({ uri: redactMediaUri(value.uri) })).catch((error: unknown) => ({ error: redactError(error, secrets) })),
  ]);
  return { profile: profileSummary(profile), stream, snapshot };
}

async function commandDiscover(parsed: ParsedArguments, dependencies: Required<Pick<CliDependencies, "discover">>): Promise<unknown> {
  assertAllowedOptions(parsed, ["cidr", "host", "timeout-ms"]);
  if (parsed.positionals.length > 0) throw new CliUsageError("discover does not accept positional arguments");
  const timeoutMs = integerOption(parsed, "timeout-ms", 1_200, 50, 10_000);
  return await dependencies.discover({
    hosts: options(parsed, "host"),
    cidrs: options(parsed, "cidr"),
    multicastTimeoutMs: timeoutMs,
    probeTimeoutMs: Math.min(timeoutMs, 5_000),
    maxProbeHosts: 256,
  });
}

async function commandInfo(parsed: ParsedArguments, env: Environment, createClient: (config: OnvifClientConfig) => CliOnvifClient): Promise<unknown> {
  assertAllowedOptions(parsed, LOCAL_OPTIONS);
  if (parsed.positionals.length > 0) throw new CliUsageError("info does not accept positional arguments");
  const connection = localConnection(parsed, env);
  const client = createClient(connection.config);
  const device = await client.getDeviceInformation();
  const capabilities = await client.getCapabilities();
  const profiles = await client.getProfiles();
  return {
    host: connection.host,
    device,
    capabilities: capabilitySummary(capabilities),
    services: serviceUrlSummary(client.serviceUrls),
    profiles: profiles.map(profileSummary),
  };
}

async function commandMedia(parsed: ParsedArguments, env: Environment, createClient: (config: OnvifClientConfig) => CliOnvifClient): Promise<unknown> {
  assertAllowedOptions(parsed, LOCAL_OPTIONS);
  if (parsed.positionals.length > 0) throw new CliUsageError("media does not accept positional arguments");
  const connection = localConnection(parsed, env);
  const client = createClient(connection.config);
  const profiles = await onvifProfiles(client);
  return {
    host: connection.host,
    credentials: { username: connection.username, password: "[environment]" },
    media: await Promise.all(profiles.map((profile) => mediaForProfile(client, profile, [connection.password]))),
  };
}

async function commandSnapshot(
  parsed: ParsedArguments,
  env: Environment,
  dependencies: Required<Pick<CliDependencies, "captureSnapshot" | "createOnvifClient" | "fileExists" | "writeFile" | "cwd">>,
): Promise<unknown> {
  assertAllowedOptions(parsed, [...LOCAL_OPTIONS, "output", "force"]);
  if (parsed.positionals.length > 0) throw new CliUsageError("snapshot does not accept positional arguments");
  const rawOutput = option(parsed, "output");
  if (!rawOutput) throw new CliUsageError("snapshot requires --output FILE");
  const outputPath = resolve(dependencies.cwd, rawOutput);
  if (await dependencies.fileExists(outputPath) && !parsed.flags.has("force")) {
    throw new CliUsageError(`Refusing to overwrite ${outputPath}; use --force to replace it`);
  }
  const connection = localConnection(parsed, env);
  const client = dependencies.createOnvifClient(connection.config);
  const profile = (await onvifProfiles(client))[0];
  if (profile === undefined) throw new CliUsageError("The camera returned no ONVIF media profiles");
  const stream = await client.getStreamUri(profile.token).catch(() => undefined);
  const snapshot = await client.getSnapshotUri(profile.token).catch(() => undefined);
  if (stream === undefined && snapshot === undefined) throw new CliUsageError("The camera did not return a snapshot or stream URL");
  const bytes = await dependencies.captureSnapshot({
    ...(stream === undefined ? {} : { streamUri: stream.uri }),
    ...(snapshot === undefined ? {} : { snapshotUri: snapshot.uri }),
    username: connection.username,
    password: connection.password,
  }, connection.timeoutMs);
  await dependencies.writeFile(outputPath, bytes);
  return { saved: outputPath, bytes: bytes.byteLength, profile: profile.token };
}

function ptzVector(direction: string, speed: number): OnvifPtzSpeed {
  switch (direction) {
    case "left": return { panTilt: { x: -speed, y: 0 } };
    case "right": return { panTilt: { x: speed, y: 0 } };
    case "up": return { panTilt: { x: 0, y: speed } };
    case "down": return { panTilt: { x: 0, y: -speed } };
    default: throw new CliUsageError("PTZ direction must be left, right, up, down, stop, or home");
  }
}

async function commandPtz(
  parsed: ParsedArguments,
  env: Environment,
  createClient: (config: OnvifClientConfig) => CliOnvifClient,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<unknown> {
  assertAllowedOptions(parsed, [...LOCAL_OPTIONS, "duration-ms", "speed"]);
  if (parsed.positionals.length !== 1) throw new CliUsageError("ptz requires one action: left, right, up, down, stop, or home");
  const action = parsed.positionals[0]?.toLowerCase() ?? "";
  if (!new Set(["left", "right", "up", "down", "stop", "home"]).has(action)) {
    throw new CliUsageError("PTZ direction must be left, right, up, down, stop, or home");
  }
  const connection = localConnection(parsed, env);
  const client = createClient(connection.config);
  const profiles = await onvifProfiles(client);
  const profile = profiles.find((candidate) => candidate.ptzConfigurationToken !== undefined) ?? profiles[0];
  if (profile === undefined) throw new CliUsageError("The camera returned no ONVIF PTZ profile");
  if (action === "stop") {
    await client.stop(profile.token);
    return { action, stopped: true, profile: profile.token };
  }
  const speed = numberOption(parsed, "speed", 0.35, 0.05, 1);
  if (action === "home") {
    await client.gotoHomePosition(profile.token, { panTilt: { x: speed, y: speed } });
    return { action, profile: profile.token };
  }
  const durationMs = integerOption(parsed, "duration-ms", 300, 50, 3_000);
  await client.continuousMove(profile.token, ptzVector(action, speed), `PT${durationMs / 1_000}S`);
  try {
    await sleep(durationMs);
  } finally {
    await client.stop(profile.token);
  }
  return { action, durationMs, speed, stopped: true, profile: profile.token };
}

async function cloudSession(
  parsed: ParsedArguments,
  env: Environment,
  createClient: (config: MeariClientConfig) => CliCloudClient,
): Promise<{ readonly client: CliCloudClient; readonly device: MeariDevice }> {
  const client = createClient(cloudConfig(parsed, env));
  const login = await client.login();
  const requested = option(parsed, "serial") ?? env.TKENPRO_SERIAL;
  return { client, device: selectedDevice(login.devices, requested) };
}

async function commandStatus(parsed: ParsedArguments, env: Environment, createClient: (config: MeariClientConfig) => CliCloudClient): Promise<unknown> {
  assertAllowedOptions(parsed, CLOUD_OPTIONS);
  if (parsed.positionals.length > 0) throw new CliUsageError("status does not accept positional arguments");
  const { client, device } = await cloudSession(parsed, env, createClient);
  const serial = String(device.snNum);
  return { device: deviceSummary(device), status: await client.getDeviceStatus(serial) };
}

async function commandGet(parsed: ParsedArguments, env: Environment, createClient: (config: MeariClientConfig) => CliCloudClient): Promise<unknown> {
  assertAllowedOptions(parsed, CLOUD_OPTIONS);
  if (parsed.positionals.length > 1) throw new CliUsageError("get accepts at most one CONTROL_ID");
  const controlId = parsed.positionals[0];
  const definition = controlId === undefined ? undefined : PET3T_CONTROL_BY_ID[controlId];
  if (controlId !== undefined && definition === undefined) throw new CliUsageError(`Unknown control ${controlId}; run "tkenpro controls"`);
  const { client, device } = await cloudSession(parsed, env, createClient);
  const serial = String(device.snNum);
  const values = definition === undefined
    ? await client.getAllIotValues(serial)
    : await client.getIotValues(serial, [definition.code]);
  return {
    device: deviceSummary(device),
    ...(definition === undefined ? {} : { control: controlSummary(definition) }),
    values: safeIotValues(values),
  };
}

function confirmationFor(parsed: ParsedArguments, definition: Readonly<ControlDefinition>): DestructiveConfirmation | undefined {
  const supplied = option(parsed, "confirm");
  if (definition.safety === "safe") {
    if (supplied !== undefined) throw new CliUsageError(`${definition.id} is safe and does not use --confirm`);
    return undefined;
  }
  if (definition.safety === "caution") {
    if (supplied !== definition.id) {
      throw new CliUsageError(`${definition.id} is a caution control; repeat --confirm ${definition.id}`);
    }
    return undefined;
  }
  const expected = DESTRUCTIVE_CONFIRMATIONS[definition.id];
  if (expected === undefined) throw new CliUsageError(`No destructive confirmation is registered for ${definition.id}`);
  if (supplied !== expected) throw new CliUsageError(`${definition.id} is destructive; repeat --confirm ${expected}`);
  return expected;
}

async function commandSet(parsed: ParsedArguments, env: Environment, createClient: (config: MeariClientConfig) => CliCloudClient): Promise<unknown> {
  assertAllowedOptions(parsed, [...CLOUD_OPTIONS, "camera-password-env", "confirm"]);
  if (parsed.positionals.length !== 2) throw new CliUsageError("set requires CONTROL_ID and VALUE");
  const controlId = parsed.positionals[0] ?? "";
  const definition = PET3T_CONTROL_BY_ID[controlId];
  if (!definition) throw new CliUsageError(`Unknown control ${controlId}; run "tkenpro controls"`);
  if (definition.access === "read") throw new CliUsageError(`${controlId} is read-only`);
  const confirmation = confirmationFor(parsed, definition);
  const value = parseControlValue(parsed.positionals[1] ?? "");
  let onvifConfiguration: { readonly enabled: boolean; readonly password: string } | undefined;
  if (controlId === "onvif") {
    if (value !== true && value !== false && value !== 0 && value !== 1) {
      throw new CliUsageError("onvif expects true/false or 0/1");
    }
    const passwordName = environmentName(parsed, "camera-password-env", "ONVIF_PASSWORD");
    onvifConfiguration = {
      enabled: value === true || value === 1,
      password: requiredEnvironmentValue(env, passwordName, "Camera password"),
    };
  }
  const { client, device } = await cloudSession(parsed, env, createClient);
  const serial = String(device.snNum);
  if (onvifConfiguration !== undefined) {
    await client.configureOnvif(serial, onvifConfiguration);
  } else {
    await client.setControl(serial, controlId, value, confirmation === undefined ? {} : { confirmation });
  }
  return { changed: true, device: deviceSummary(device), control: controlSummary(definition) };
}

/** Execute one CLI invocation. Returns a process-style exit code without exiting. */
export async function runCli(argv: readonly string[], dependencies: CliDependencies = {}): Promise<number> {
  const env = dependencies.env ?? process.env;
  const stdout = dependencies.stdout ?? ((text) => process.stdout.write(text));
  const stderr = dependencies.stderr ?? ((text) => process.stderr.write(text));
  let parsed: ParsedArguments;
  try {
    parsed = parseArguments(argv);
  } catch (error) {
    stderr(`Error: ${redactError(error, [])}\n`);
    return 2;
  }
  if (!parsed.command || parsed.command === "help" || parsed.flags.has("help")) {
    stdout(HELP);
    return 0;
  }

  const createOnvifClient = dependencies.createOnvifClient ?? ((config) => new OnvifClient(config));
  const createCloudClient = dependencies.createCloudClient ?? ((config) => new MeariClient(config));
  const secrets = credentialSecrets(parsed, env);

  try {
    let result: unknown;
    switch (parsed.command) {
      case "discover":
        result = await commandDiscover(parsed, { discover: dependencies.discover ?? discoverCameras });
        break;
      case "info":
        result = await commandInfo(parsed, env, createOnvifClient);
        break;
      case "media":
        result = await commandMedia(parsed, env, createOnvifClient);
        break;
      case "snapshot":
        result = await commandSnapshot(parsed, env, {
          captureSnapshot: dependencies.captureSnapshot ?? captureCameraSnapshot,
          createOnvifClient,
          fileExists: dependencies.fileExists ?? (async (path) => await Bun.file(path).exists()),
          writeFile: dependencies.writeFile ?? (async (path, bytes) => await Bun.write(path, bytes)),
          cwd: dependencies.cwd ?? process.cwd(),
        });
        break;
      case "ptz":
        result = await commandPtz(parsed, env, createOnvifClient, dependencies.sleep ?? (async (milliseconds) => await Bun.sleep(milliseconds)));
        break;
      case "status":
        result = await commandStatus(parsed, env, createCloudClient);
        break;
      case "get":
        result = await commandGet(parsed, env, createCloudClient);
        break;
      case "set":
        result = await commandSet(parsed, env, createCloudClient);
        break;
      case "controls":
        assertAllowedOptions(parsed, []);
        if (parsed.positionals.length > 0) throw new CliUsageError("controls does not accept positional arguments");
        result = { count: PET3T_CONTROL_CATALOG.length, controls: PET3T_CONTROL_CATALOG.map(controlSummary) };
        break;
      default:
        throw new CliUsageError(`Unknown command ${parsed.command}; run "tkenpro help"`);
    }
    emitResult(stdout, result, parsed.flags.has("json"));
    return 0;
  } catch (error) {
    const message = redactError(error, secrets);
    if (parsed.flags.has("json")) emitResult(stderr, { ok: false, error: message }, true);
    else stderr(`Error: ${message}\n`);
    return error instanceof CliUsageError ? 2 : 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runCli(Bun.argv.slice(2));
}
