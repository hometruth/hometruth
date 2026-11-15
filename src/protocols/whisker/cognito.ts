/**
 * The two AWS Cognito `InitiateAuth` flows Whisker's account needs:
 * `USER_PASSWORD_AUTH` to sign in and `REFRESH_TOKEN_AUTH` to renew. Both are
 * the documented Cognito Identity Provider JSON API; nothing here is
 * Whisker-specific beyond the client id passed in.
 *
 * No token or password ever appears in an error message.
 */
import { WhiskerError, type WhiskerFetch } from "./errors";

export interface CognitoTokens {
  readonly idToken: string;
  readonly refreshToken: string;
  /** Epoch milliseconds when the ID token stops being accepted. */
  readonly expiresAt: number;
}

export interface CognitoOptions {
  readonly endpoint: string;
  readonly clientId: string;
  readonly fetch: WhiskerFetch;
  readonly timeoutMs: number;
  readonly now: () => number;
}

export async function cognitoPasswordLogin(options: CognitoOptions, username: string, password: string): Promise<CognitoTokens> {
  const result = await initiateAuth(options, "USER_PASSWORD_AUTH", { USERNAME: username, PASSWORD: password });
  if (!result.refreshToken) throw new WhiskerError("Whisker sign-in returned no refresh token", "protocol");
  return { idToken: result.idToken, refreshToken: result.refreshToken, expiresAt: result.expiresAt };
}

/** Cognito does not rotate the refresh token here, so the old one is kept. */
export async function cognitoRefresh(options: CognitoOptions, refreshToken: string): Promise<CognitoTokens> {
  const result = await initiateAuth(options, "REFRESH_TOKEN_AUTH", { REFRESH_TOKEN: refreshToken });
  return { idToken: result.idToken, refreshToken: result.refreshToken ?? refreshToken, expiresAt: result.expiresAt };
}

async function initiateAuth(options: CognitoOptions, flow: string, parameters: Record<string, string>): Promise<{ idToken: string; refreshToken?: string; expiresAt: number }> {
  let response: Response;
  try {
    response = await options.fetch(options.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": "AWSCognitoIdentityProviderService.InitiateAuth",
      },
      body: JSON.stringify({ AuthFlow: flow, ClientId: options.clientId, AuthParameters: parameters }),
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    throw new WhiskerError(`Whisker sign-in is unreachable: ${error instanceof Error ? error.message : String(error)}`, "unreachable");
  }
  const body: unknown = await response.json().catch(() => undefined);
  const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
  if (!response.ok) {
    const type = typeof record.__type === "string" ? record.__type.split("#").pop() ?? "" : "";
    // Cognito's own messages name the problem without echoing credentials.
    const message = typeof record.message === "string" ? record.message.slice(0, 200) : `HTTP ${response.status}`;
    if (type === "NotAuthorizedException" || type === "UserNotFoundException" || type === "PasswordResetRequiredException" || type === "UserNotConfirmedException") {
      throw new WhiskerError(`Whisker rejected the account: ${message}. Check vendors.whisker.username and vendors.whisker.password`, "authentication");
    }
    if (response.status >= 500 || type === "TooManyRequestsException") throw new WhiskerError(`Whisker sign-in is unavailable: ${message}`, "unreachable");
    throw new WhiskerError(`Whisker sign-in failed: ${type || message}`, "protocol");
  }
  const result = record.AuthenticationResult;
  if (typeof result !== "object" || result === null) {
    // A challenge (MFA, new password) cannot be answered unattended.
    const challenge = typeof record.ChallengeName === "string" ? record.ChallengeName : "an unknown challenge";
    throw new WhiskerError(`Whisker sign-in asked for ${challenge}; finish it in the Whisker app first`, "authentication");
  }
  const { IdToken, RefreshToken, ExpiresIn } = result as Record<string, unknown>;
  if (typeof IdToken !== "string" || !IdToken) throw new WhiskerError("Whisker sign-in returned no ID token", "protocol");
  const lifetimeSeconds = typeof ExpiresIn === "number" && ExpiresIn > 0 ? ExpiresIn : 3600;
  const claimedExpiry = jwtClaims(IdToken).exp;
  const expiresAt = typeof claimedExpiry === "number" ? claimedExpiry * 1000 : options.now() + lifetimeSeconds * 1000;
  return { idToken: IdToken, ...(typeof RefreshToken === "string" && RefreshToken ? { refreshToken: RefreshToken } : {}), expiresAt };
}

/** The payload of a JWT, unverified: only used to read our own token's claims. */
export function jwtClaims(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (!payload) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
