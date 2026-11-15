/** Synthetic Whisker responses for tests. No real account, serial or token. */
import { LR4_GRAPHQL_ENDPOINT, WHISKER_COGNITO_ENDPOINT } from "./constants";

export const SERIAL = "LR4C000001";
export const USERNAME = "owner@example.com";
export const PASSWORD = "synthetic-password";

/** An unsigned JWT-shaped token carrying `mid` and `exp`. */
export function idToken(options: { mid?: string; exp?: number; marker?: string } = {}): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ mid: options.mid ?? "user-0001", exp: options.exp ?? 4_102_444_800, marker: options.marker ?? "a" })}.sig`;
}

export function robotRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    unitId: "unit-0001", name: "Synthetic Robot", serial: SERIAL, espFirmware: "1.1.50",
    unitPowerType: "AC", robotStatus: "ROBOT_IDLE", catWeight: 9.4, cleanCycleWaitTime: 7,
    isKeypadLockout: false, nightLightMode: "AUTO", isNightLightLEDOn: true, sleepStatus: "WAKE",
    DFILevelPercent: 40, isDFIFull: false, litterLevelPercentage: 0.65, litterLevelState: "OPTIMAL",
    isHopperRemoved: false, isOnline: true, lastSeen: "2026-01-01T12:00:00.000Z",
    ...overrides,
  };
}

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export interface RecordedRequest {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

export interface FakeWhisker {
  readonly fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  readonly requests: RecordedRequest[];
  readonly cognito: () => RecordedRequest[];
  readonly graphql: () => RecordedRequest[];
}

/**
 * A fake of both endpoints. `auth` answers Cognito, `api` answers GraphQL;
 * each gets the parsed body and the request's headers.
 */
export function fakeWhisker(handlers: {
  auth?: (body: Record<string, unknown>) => Response;
  api?: (body: Record<string, unknown>, headers: Headers) => Response;
} = {}): FakeWhisker {
  const requests: RecordedRequest[] = [];
  const auth = handlers.auth ?? (() => json({ AuthenticationResult: { IdToken: idToken(), RefreshToken: "refresh-1", ExpiresIn: 3600, AccessToken: "access" } }));
  const api = handlers.api ?? ((body: Record<string, unknown>) => String(body.query).startsWith("mutation")
    ? json({ data: { sendLitterRobot4Command: "Command Sent" } })
    : json({ data: { getLitterRobot4ByUser: [robotRecord()] } }));
  const fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push({ url, headers, body });
    if (url === WHISKER_COGNITO_ENDPOINT) return auth(body);
    if (url === LR4_GRAPHQL_ENDPOINT) return api(body, headers);
    throw new Error(`unexpected request to ${url}`);
  };
  return {
    fetch: fetchImpl,
    requests,
    cognito: () => requests.filter(request => request.url === WHISKER_COGNITO_ENDPOINT),
    graphql: () => requests.filter(request => request.url === LR4_GRAPHQL_ENDPOINT),
  };
}
