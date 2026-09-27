/**
 * Camera recovery: reboot a Pet 3T wherever it currently is.
 *
 * The cameras keep a backup Wi-Fi network. After a Wi-Fi kick (or a flaky
 * link) a camera can fail over to that backup, come up on a different subnet,
 * and stay there: the vendor cloud still sees it, but the LAN address in
 * devices.yml is dead, so the dashboard shows "Status unknown" while
 * the camera's own status light is a steady blue.
 *
 * `rebootCamera` first tries the configured address, then asks the vendor
 * cloud where the camera last reported itself (IoT code 126), sends an ONVIF
 * SystemReboot at whichever address answers, and waits for the camera to come
 * back at the configured address. The pieces that touch the network are
 * injected so the flow is unit-testable and reusable from the CLI script.
 */

export interface CameraRecoveryCredentials {
  readonly username?: string;
  readonly password?: string;
}

/** What the camera reports about itself when probed. */
export interface CameraProbeResult {
  readonly serialNumber?: string;
  readonly model?: string;
  readonly firmwareVersion?: string;
}

/** How the vendor cloud can be asked about the camera. */
export interface CameraCloudAccount {
  readonly email: string;
  readonly password: string;
  readonly profile?: string;
  readonly countryCode?: string;
  readonly phoneCode?: string;
}

/** Whatever is known that singles out one camera on the account. */
export interface CameraIdentity {
  /** The printed nine-digit serial (the cloud lists it as deviceName). */
  readonly serialNumber?: string;
  /** The 16-hex device UUID; the cloud serial is "ppsc" + uuid. */
  readonly uuid?: string;
}

/** Where the vendor cloud says the camera is right now. */
export interface CameraLocation {
  readonly host: string;
  readonly gateway?: string;
}

export interface CameraRecoveryDependencies {
  /** ONVIF GetDeviceInformation at `host`; rejects when nothing answers there. */
  probe(host: string, credentials: CameraRecoveryCredentials): Promise<CameraProbeResult>;
  /** ONVIF SystemReboot at `host`. */
  reboot(host: string, credentials: CameraRecoveryCredentials): Promise<void>;
  /** Asks the vendor cloud which address the camera last reported. Absent when no cloud lookup exists. */
  locate?(identity: CameraIdentity, account: CameraCloudAccount): Promise<CameraLocation | undefined>;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

export interface CameraRebootRequest {
  /** The LAN address the camera is supposed to have (devices.yml). */
  readonly configuredHost: string;
  readonly identity?: CameraIdentity;
  readonly credentials?: CameraRecoveryCredentials;
  /** Saved app account, used only if the configured address does not answer. */
  readonly account?: CameraCloudAccount;
}

export interface CameraRebootOptions {
  /** How long to wait for the camera to answer at the configured address again. */
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}

export interface CameraRebootOutcome {
  readonly configuredHost: string;
  /** The address the reboot was sent to. */
  readonly rebootedAt: string;
  readonly reachedVia: "configured-host" | "vendor-cloud";
  readonly cloudLocation?: CameraLocation;
  readonly serialNumber?: string;
  /** Milliseconds until the camera answered at the configured address; undefined when it did not within the timeout. */
  readonly backAfterMs?: number;
  readonly message: string;
}

export type CameraRecoveryErrorCode = "unreachable" | "wrong_camera" | "not_configured" | "camera_error";

export class CameraRecoveryError extends Error {
  constructor(message: string, readonly code: CameraRecoveryErrorCode) {
    super(message);
    this.name = "CameraRecoveryError";
  }
}

export const DEFAULT_REBOOT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
/** How long to wait for the camera to stop answering after the reboot was accepted. */
const DOWN_TIMEOUT_MS = 30_000;

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)} s`;
}

/** True when the probe result names a different camera than the one requested. */
export function isDifferentCamera(identity: CameraIdentity | undefined, probe: CameraProbeResult): boolean {
  const expected = identity?.serialNumber?.trim();
  const actual = probe.serialNumber?.trim();
  return Boolean(expected && actual && expected !== actual);
}

/**
 * Find the camera, reboot it, and wait for it to return to its configured
 * address. Resolves with a report either way the wait ends; rejects with a
 * CameraRecoveryError when the camera could not be found or the reboot was
 * not accepted.
 */
export async function rebootCamera(
  dependencies: CameraRecoveryDependencies,
  request: CameraRebootRequest,
  options: CameraRebootOptions = {},
): Promise<CameraRebootOutcome> {
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = dependencies.now ?? (() => Date.now());
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_REBOOT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const credentials = request.credentials ?? {};
  const { configuredHost } = request;
  const notes: string[] = [];

  let rebootedAt: string | undefined;
  let reachedVia: CameraRebootOutcome["reachedVia"] = "configured-host";
  let cloudLocation: CameraLocation | undefined;
  let probe: CameraProbeResult | undefined;

  try {
    probe = await dependencies.probe(configuredHost, credentials);
    rebootedAt = configuredHost;
  } catch (error) {
    notes.push(`${configuredHost} did not answer ONVIF (${detail(error)})`);
  }

  if (!rebootedAt) {
    if (!dependencies.locate) {
      throw new CameraRecoveryError(`${notes[0]} and no vendor-cloud lookup is available; check power and Wi-Fi`, "unreachable");
    }
    if (!request.account) {
      throw new CameraRecoveryError(`${notes[0]}. Save the app account in camera settings so HomeTruth can ask the vendor cloud where the camera went`, "not_configured");
    }
    try {
      cloudLocation = await dependencies.locate(request.identity ?? {}, request.account);
    } catch (error) {
      throw new CameraRecoveryError(`${notes[0]} and the vendor cloud could not be asked where it is (${detail(error)})`, "camera_error");
    }
    if (!cloudLocation) {
      throw new CameraRecoveryError(`${notes[0]} and the vendor cloud does not list this camera; check power and Wi-Fi`, "unreachable");
    }
    if (cloudLocation.host === configuredHost) {
      throw new CameraRecoveryError(`${notes[0]}; the vendor cloud also reports it at ${configuredHost}, so it is off or its Wi-Fi is down. Power-cycle it`, "unreachable");
    }
    const where = `${cloudLocation.host}${cloudLocation.gateway ? ` (gateway ${cloudLocation.gateway}, so it joined its backup Wi-Fi)` : ""}`;
    try {
      probe = await dependencies.probe(cloudLocation.host, credentials);
    } catch (error) {
      throw new CameraRecoveryError(`${notes[0]}; the vendor cloud says it is at ${where}, but it did not answer ONVIF there either (${detail(error)})`, "unreachable");
    }
    rebootedAt = cloudLocation.host;
    reachedVia = "vendor-cloud";
    notes.push(`the vendor cloud reported it at ${where}`);
  }

  if (probe && isDifferentCamera(request.identity, probe)) {
    throw new CameraRecoveryError(
      `The camera answering at ${rebootedAt} is serial ${probe.serialNumber}, not ${request.identity?.serialNumber}; not rebooting it`,
      "wrong_camera",
    );
  }

  try {
    await dependencies.reboot(rebootedAt, credentials);
  } catch (error) {
    throw new CameraRecoveryError(`${rebootedAt} did not accept the ONVIF reboot (${detail(error)})`, "camera_error");
  }
  notes.push(`rebooted it at ${rebootedAt}`);

  const started = now();
  let backAfterMs: number | undefined;
  // A camera rebooted at its configured address still answers for a moment;
  // wait for it to go away before counting an answer as "back".
  let wentDown = reachedVia === "vendor-cloud";
  while (now() - started < timeoutMs) {
    await sleep(pollIntervalMs);
    const elapsed = now() - started;
    let answered = false;
    try {
      await dependencies.probe(configuredHost, credentials);
      answered = true;
    } catch {
      wentDown = true;
    }
    if (!answered) continue;
    if (wentDown) {
      backAfterMs = elapsed;
      break;
    }
    if (elapsed >= DOWN_TIMEOUT_MS) {
      // Still answering long after the reboot was accepted: treat that as back.
      backAfterMs = elapsed;
      break;
    }
  }

  const message = backAfterMs === undefined
    ? `${capitalize(notes.join("; "))}, but it has not answered at ${configuredHost} after ${seconds(timeoutMs)}. It may have rejoined its backup Wi-Fi; try again or power-cycle it`
    : `${capitalize(notes.join("; "))}; it answered at ${configuredHost} again ${seconds(backAfterMs)} later`;

  return {
    configuredHost,
    rebootedAt,
    reachedVia,
    ...(cloudLocation ? { cloudLocation } : {}),
    ...(probe?.serialNumber ? { serialNumber: probe.serialNumber } : {}),
    ...(backAfterMs !== undefined ? { backAfterMs } : {}),
    message,
  };
}

function capitalize(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}
