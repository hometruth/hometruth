import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { MeariCameraRegistration, MeariRegistrationAuthorizer } from "./cloud-emulator.ts";

const AUTH_VERSION = 2;
const MAX_AUTH_FILE_BYTES = 262_144;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const PEER_TEXT_PATTERN = /^[\x20-\x7e]+$/u;
const MAX_CAPABILITY_FLAGS = 64;

/** Numeric, non-secret firmware flags that affect controls exposed by CloudEdge. */
export const MEARI_LOCAL_CAPABILITY_FLAG_NAMES: ReadonlySet<string> = new Set([
  "alb", "bowl", "cct", "dri", "flt", "fmr", "fprm", "food", "hmd", "las", "ltl",
  "md", "mmn", "nms", "nst", "ovc", "ovf", "pdt", "pet", "pfp", "pfv", "pir",
  "pkl", "plv", "pms", "ptc", "ptd", "ptf", "ptr", "ptz", "ptz2", "rec", "rgd",
  "rgb", "sd", "sir", "sla", "smd", "tmpr", "uvd", "vtk", "wlc",
]);

export interface MeariLocalPeerAuthorization {
  /** Per-device VVP authentication key returned during the one-time bootstrap. */
  readonly hostKey: string;
  /** Native VVP/PPCS protocol generation (normally the device's `p2p` value). */
  readonly protocolVersion: number;
  /** Twenty-character identifier appended to modern VVP authentication frames. */
  readonly licenceId: string;
  /** Stable CloudEdge client identity accepted by the camera's signaling layer. */
  readonly clientUuid?: string;
}

export interface MeariLocalCameraAuthorization {
  readonly uuid: string;
  readonly registrationPasswordSha256: string;
  readonly sourceAddress?: string;
  readonly clientId?: string;
  readonly peer?: MeariLocalPeerAuthorization;
  /** Sanitized feature metadata captured once so local UI gating needs no cloud. */
  readonly capabilityFlags?: Readonly<Record<string, number>>;
}

export interface MeariLocalCloudAuthorizationFile {
  readonly version: 2;
  readonly devices: readonly MeariLocalCameraAuthorization[];
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === code;
}

export function sanitizeMeariLocalCapabilityFlags(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, number>> {
  const entries = Object.entries(value)
    .filter(([key, candidate]) => (
      MEARI_LOCAL_CAPABILITY_FLAG_NAMES.has(key)
      && Number.isSafeInteger(candidate)
      && Number(candidate) >= -1
      && Number(candidate) <= 65_535
    ))
    .map(([key, candidate]) => [key, Number(candidate)] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return Object.freeze(Object.fromEntries(entries));
}

function validateCapabilityFlags(value: unknown): Readonly<Record<string, number>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Local camera capability flags are not an object");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_CAPABILITY_FLAGS) {
    throw new Error("Local camera authorization contains too many capability flags");
  }
  const sanitized = sanitizeMeariLocalCapabilityFlags(value as Record<string, unknown>);
  if (Object.keys(sanitized).length !== entries.length) {
    throw new Error("Local camera authorization contains an invalid capability flag");
  }
  return sanitized;
}

function validateEntry(value: unknown): MeariLocalCameraAuthorization {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Local camera authorization entry is not an object");
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry.uuid !== "string" || !entry.uuid || entry.uuid.length > 200) {
    throw new Error("Local camera authorization omitted a valid UUID");
  }
  if (
    typeof entry.registrationPasswordSha256 !== "string"
    || !SHA256_PATTERN.test(entry.registrationPasswordSha256)
  ) {
    throw new Error("Local camera authorization omitted a valid proof fingerprint");
  }
  if (entry.sourceAddress !== undefined && (typeof entry.sourceAddress !== "string" || !entry.sourceAddress)) {
    throw new Error("Local camera authorization has an invalid source address");
  }
  if (entry.clientId !== undefined && (typeof entry.clientId !== "string" || !entry.clientId)) {
    throw new Error("Local camera authorization has an invalid client ID");
  }
  let peer: MeariLocalPeerAuthorization | undefined;
  if (entry.peer !== undefined) {
    if (!entry.peer || typeof entry.peer !== "object" || Array.isArray(entry.peer)) {
      throw new Error("Local camera peer authorization is not an object");
    }
    const candidate = entry.peer as Record<string, unknown>;
    if (
      typeof candidate.hostKey !== "string"
      || candidate.hostKey.length < 8
      || candidate.hostKey.length > 256
      || !PEER_TEXT_PATTERN.test(candidate.hostKey)
    ) {
      throw new Error("Local camera peer authorization omitted a valid host key");
    }
    if (
      !Number.isInteger(candidate.protocolVersion)
      || Number(candidate.protocolVersion) < 1
      || Number(candidate.protocolVersion) > 255
    ) {
      throw new Error("Local camera peer authorization has an invalid protocol version");
    }
    if (
      typeof candidate.licenceId !== "string"
      || candidate.licenceId.length < 1
      || candidate.licenceId.length > 64
      || !/^[A-Za-z0-9_-]+$/u.test(candidate.licenceId)
    ) {
      throw new Error("Local camera peer authorization omitted a valid licence ID");
    }
    if (
      candidate.clientUuid !== undefined
      && (typeof candidate.clientUuid !== "string" || !/^[0-9a-f]{16}$/u.test(candidate.clientUuid))
    ) {
      throw new Error("Local camera peer authorization has an invalid client UUID");
    }
    peer = {
      hostKey: candidate.hostKey,
      protocolVersion: Number(candidate.protocolVersion),
      licenceId: candidate.licenceId,
      ...(typeof candidate.clientUuid === "string" ? { clientUuid: candidate.clientUuid } : {}),
    };
  }
  const capabilityFlags = entry.capabilityFlags === undefined
    ? undefined
    : validateCapabilityFlags(entry.capabilityFlags);
  return {
    uuid: entry.uuid,
    registrationPasswordSha256: entry.registrationPasswordSha256,
    ...(typeof entry.sourceAddress === "string" ? { sourceAddress: entry.sourceAddress } : {}),
    ...(typeof entry.clientId === "string" ? { clientId: entry.clientId } : {}),
    ...(peer ? { peer } : {}),
    ...(capabilityFlags ? { capabilityFlags } : {}),
  };
}

function validateDocument(value: unknown): MeariLocalCloudAuthorizationFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Local camera authorization file is not an object");
  }
  const document = value as Record<string, unknown>;
  if (![1, AUTH_VERSION].includes(Number(document.version)) || !Array.isArray(document.devices)) {
    throw new Error("Unsupported local camera authorization file");
  }
  const devices = document.devices.map(validateEntry);
  if (devices.length === 0) throw new Error("Local camera authorization file has no devices");
  // Version 1 did not include peer credentials. Normalize it in memory so the
  // next atomic save upgrades the file without weakening registration checks.
  return { version: AUTH_VERSION, devices };
}

function passwordFingerprint(password: string): Buffer {
  return createHash("sha256").update(password, "utf8").digest();
}

/** Build a constant-time registration-proof validator from a local allow-list. */
export function createMeariRegistrationAuthorizer(
  devices: readonly MeariLocalCameraAuthorization[],
): MeariRegistrationAuthorizer {
  const entries = devices.map(validateEntry);
  return (registration: MeariCameraRegistration): boolean => {
    const candidateHash = passwordFingerprint(registration.password);
    let accepted = false;
    for (const entry of entries) {
      const expectedHash = Buffer.from(entry.registrationPasswordSha256, "hex");
      const identityMatches = entry.uuid === registration.uuid
        && (!entry.sourceAddress || entry.sourceAddress === registration.remoteAddress)
        && (!entry.clientId || entry.clientId === registration.clientId);
      accepted = (timingSafeEqual(candidateHash, expectedHash) && identityMatches) || accepted;
    }
    return accepted;
  };
}

/** Permission-restricted storage for camera registration fingerprints. */
export class MeariLocalCloudAuthStore {
  readonly path: string;

  constructor(path = ".hometruth/local-camera-auth.json") {
    this.path = resolve(path);
  }

  async load(): Promise<MeariLocalCloudAuthorizationFile> {
    const metadata = await lstat(this.path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error("Refusing to load local camera authorization from a non-file or symbolic link");
    }
    if (metadata.size > MAX_AUTH_FILE_BYTES) {
      throw new Error("Refusing to load an unexpectedly large local camera authorization file");
    }
    return validateDocument(JSON.parse(await readFile(this.path, "utf8")) as unknown);
  }

  async save(devices: readonly MeariLocalCameraAuthorization[]): Promise<void> {
    const document = validateDocument({ version: AUTH_VERSION, devices });
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryMetadata = await lstat(directory);
    if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
      throw new Error("Refusing to store local camera authorization in a non-directory or symbolic link");
    }
    await chmod(directory, 0o700);

    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.path);
      await chmod(this.path, 0o600);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}
