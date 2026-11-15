/**
 * A Whisker account session and the Litter-Robot 4 GraphQL calls made with
 * it. Signs in with Cognito, renews the ID token before it expires, and on a
 * 401 signs in again from the password once before giving up.
 *
 * Credentials and tokens stay in this object: no message, log line or error
 * built here contains them.
 */
import { cognitoPasswordLogin, cognitoRefresh, jwtClaims, type CognitoOptions, type CognitoTokens } from "./cognito";
import {
  LR4_COMMAND_MUTATION, LR4_COMMAND_SOURCE, LR4_GRAPHQL_ENDPOINT, LR4_ROBOT_STATUS, LR4_ROBOTS_QUERY,
  WHISKER_COGNITO_CLIENT_ID, WHISKER_COGNITO_ENDPOINT, WHISKER_USER_ID_CLAIM, type Lr4Command,
} from "./constants";
import { WhiskerError, type WhiskerFetch } from "./errors";

export { WhiskerError, type WhiskerErrorCode, type WhiskerFetch } from "./errors";

/** One robot as HomeTruth reads it; a field is absent when Whisker did not send a usable value. */
export interface Lr4Robot {
  readonly serial: string;
  readonly name?: string;
  readonly firmware?: string;
  readonly online: boolean;
  readonly lastSeen?: string;
  /** Whisker's raw `robotStatus`. */
  readonly robotStatus?: string;
  /** A short status code and sentence, pylitterbot-style (`RDY` / "Ready"). */
  readonly status: { readonly code: string; readonly text: string };
  /** Waste drawer fill, 0..100. */
  readonly wasteDrawerPercent?: number;
  readonly wasteDrawerFull?: boolean;
  /** Litter level, 0..100. */
  readonly litterLevelPercent?: number;
  readonly litterLevelState?: string;
  /** Last recorded pet weight in pounds. */
  readonly catWeightPounds?: number;
  readonly cleanCycleWaitMinutes?: number;
  readonly keypadLockout?: boolean;
  /** `ON`, `OFF` or `AUTO`. */
  readonly nightLightMode?: string;
  readonly nightLightLit?: boolean;
  readonly sleeping?: boolean;
  readonly hopperRemoved?: boolean;
  /** `AC`, `DC`, … as Whisker spells the power source. */
  readonly powerType?: string;
}

export interface WhiskerCredentials {
  readonly username: string;
  readonly password: string;
}

export interface WhiskerClientOptions {
  readonly fetch?: WhiskerFetch;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

/** Renew this long before the ID token's stated expiry. */
const RENEW_MARGIN_MS = 60_000;

export class WhiskerClient {
  private readonly fetchImpl: WhiskerFetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private tokens: CognitoTokens | undefined;
  private signingIn: Promise<CognitoTokens> | undefined;

  constructor(private readonly credentials: WhiskerCredentials, options: WhiskerClientOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  /** Every robot on the account, Litter-Robot 4 only. */
  async robots(): Promise<Lr4Robot[]> {
    const userId = this.userId(await this.idToken());
    const data = await this.graphql(LR4_ROBOTS_QUERY, { userId });
    const list = data.getLitterRobot4ByUser;
    if (list === null || list === undefined) return [];
    if (!Array.isArray(list)) throw new WhiskerError("Whisker returned robots in an unexpected shape", "protocol");
    return list.flatMap(entry => {
      const robot = parseLr4Robot(entry);
      return robot ? [robot] : [];
    });
  }

  async command(serial: string, command: Lr4Command, value?: string): Promise<void> {
    const data = await this.graphql(LR4_COMMAND_MUTATION, { serial, command, value: value ?? null, commandSource: LR4_COMMAND_SOURCE });
    const answer = data.sendLitterRobot4Command;
    if (typeof answer === "string" && /error/iu.test(answer)) {
      throw new WhiskerError(`Whisker refused ${command}: ${answer.slice(0, 200)}`, "protocol");
    }
  }

  /** A current ID token, signing in or renewing as needed; concurrent callers share one sign-in. */
  async idToken(): Promise<string> {
    if (this.tokens && this.tokens.expiresAt - RENEW_MARGIN_MS > this.now()) return this.tokens.idToken;
    this.signingIn ??= this.renew().finally(() => { this.signingIn = undefined; });
    this.tokens = await this.signingIn;
    return this.tokens.idToken;
  }

  private async renew(): Promise<CognitoTokens> {
    const options = this.cognito();
    if (this.tokens) {
      try { return await cognitoRefresh(options, this.tokens.refreshToken); }
      catch (error) {
        // A revoked or expired refresh token is answered by signing in again.
        if (!(error instanceof WhiskerError) || error.code !== "authentication") throw error;
      }
    }
    return cognitoPasswordLogin(options, this.credentials.username, this.credentials.password);
  }

  private cognito(): CognitoOptions {
    return { endpoint: WHISKER_COGNITO_ENDPOINT, clientId: WHISKER_COGNITO_CLIENT_ID, fetch: this.fetchImpl, timeoutMs: this.timeoutMs, now: this.now };
  }

  private userId(idToken: string): string {
    const claims = jwtClaims(idToken);
    const id = claims[WHISKER_USER_ID_CLAIM] ?? claims.sub;
    if (typeof id !== "string" && typeof id !== "number") throw new WhiskerError("Whisker's ID token carries no user id", "protocol");
    return String(id);
  }

  private async graphql(query: string, variables: Record<string, unknown>, retried = false): Promise<Record<string, unknown>> {
    const token = await this.idToken();
    let response: Response;
    try {
      response = await this.fetchImpl(LR4_GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ query, variables }),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new WhiskerError(`Whisker's Litter-Robot service is unreachable: ${error instanceof Error ? error.message : String(error)}`, "unreachable");
    }
    const body: unknown = await response.json().catch(() => undefined);
    const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
    const errors = Array.isArray(record.errors) ? record.errors as unknown[] : [];
    const unauthorized = response.status === 401 || response.status === 403
      || errors.some(error => /unauthori[sz]ed/iu.test(String((error as { errorType?: unknown; message?: unknown })?.errorType ?? (error as { message?: unknown })?.message ?? "")));
    if (unauthorized) {
      if (retried) throw new WhiskerError("Whisker refused the session after signing in again", "authentication");
      // The token may have been revoked server-side; start over from the password.
      this.tokens = undefined;
      return this.graphql(query, variables, true);
    }
    if (response.status >= 500) throw new WhiskerError(`Whisker's Litter-Robot service answered HTTP ${response.status}`, "unreachable");
    if (!response.ok) throw new WhiskerError(`Whisker's Litter-Robot service answered HTTP ${response.status}`, "protocol");
    if (errors.length) {
      const message = (errors[0] as { message?: unknown })?.message;
      throw new WhiskerError(`Whisker's Litter-Robot service returned an error: ${typeof message === "string" ? message.slice(0, 200) : "unspecified"}`, "protocol");
    }
    if (typeof record.data !== "object" || record.data === null) throw new WhiskerError("Whisker's Litter-Robot service returned no data", "protocol");
    return record.data as Record<string, unknown>;
  }
}

const finite = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim().slice(0, 100) : undefined;
const flag = (value: unknown): boolean | undefined => typeof value === "boolean" ? value : undefined;
const within = (value: number | undefined, min: number, max: number) => value !== undefined && value >= min && value <= max ? value : undefined;

/** One robot record from `getLitterRobot4ByUser`, or undefined when it has no serial. */
export function parseLr4Robot(raw: unknown): Lr4Robot | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const data = raw as Record<string, unknown>;
  const serial = text(data.serial);
  if (!serial) return undefined;
  const online = data.isOnline === true;
  const robotStatus = text(data.robotStatus);
  const wasteDrawerFull = flag(data.isDFIFull);
  const lastSeen = text(data.lastSeen);
  const litterFraction = within(finite(data.litterLevelPercentage), 0, 1);
  const sleepStatus = text(data.sleepStatus);
  const robot: Lr4Robot = {
    serial,
    online,
    status: statusOf(online, robotStatus, wasteDrawerFull),
    ...optional("name", text(data.name)),
    ...optional("firmware", text(data.espFirmware)),
    ...optional("lastSeen", lastSeen && !Number.isNaN(Date.parse(lastSeen)) ? new Date(lastSeen).toISOString() : undefined),
    ...optional("robotStatus", robotStatus),
    ...optional("wasteDrawerPercent", within(finite(data.DFILevelPercent), 0, 100)),
    ...optional("wasteDrawerFull", wasteDrawerFull),
    // Whisker sends a 0..1 fraction here.
    ...optional("litterLevelPercent", litterFraction === undefined ? undefined : Math.round(litterFraction * 1000) / 10),
    ...optional("litterLevelState", text(data.litterLevelState)),
    ...optional("catWeightPounds", within(finite(data.catWeight), 0, 100)),
    ...optional("cleanCycleWaitMinutes", within(finite(data.cleanCycleWaitTime), 0, 120)),
    ...optional("keypadLockout", flag(data.isKeypadLockout)),
    ...optional("nightLightMode", text(data.nightLightMode)?.toUpperCase()),
    ...optional("nightLightLit", flag(data.isNightLightLEDOn)),
    ...optional("sleeping", sleepStatus ? sleepStatus.toUpperCase() !== "WAKE" : undefined),
    ...optional("hopperRemoved", flag(data.isHopperRemoved)),
    ...optional("powerType", text(data.unitPowerType)),
  };
  return robot;
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

function statusOf(online: boolean, robotStatus: string | undefined, drawerFull: boolean | undefined): { code: string; text: string } {
  if (!online) return { code: "OFFLINE", text: "Offline" };
  const known = robotStatus ? (LR4_ROBOT_STATUS as Record<string, { code: string; text: string }>)[robotStatus] : undefined;
  if (!known) return { code: "UNKNOWN", text: robotStatus ? `Unknown status ${robotStatus}` : "Unknown status" };
  if (known.code === "RDY" && drawerFull) return { code: "DFS", text: "Waste drawer full" };
  return { code: known.code, text: known.text };
}
