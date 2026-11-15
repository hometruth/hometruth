import { describe, expect, test } from "bun:test";
import { WhiskerClient, WhiskerError, parseLr4Robot } from "./client";
import { LR4_COMMAND_SOURCE, WHISKER_COGNITO_CLIENT_ID } from "./constants";
import { PASSWORD, SERIAL, USERNAME, fakeWhisker, idToken, json, robotRecord } from "./test-fixtures";

const credentials = { username: USERNAME, password: PASSWORD };

async function failure(promise: Promise<unknown>): Promise<WhiskerError> {
  try { await promise; } catch (error) { expect(error).toBeInstanceOf(WhiskerError); return error as WhiskerError; }
  throw new Error("expected a rejection");
}

describe("WhiskerClient", () => {
  test("signs in with USER_PASSWORD_AUTH and queries robots by the token's user id", async () => {
    const fake = fakeWhisker();
    const robots = await new WhiskerClient(credentials, { fetch: fake.fetch }).robots();
    const [login] = fake.cognito();
    expect(login!.headers.get("x-amz-target")).toBe("AWSCognitoIdentityProviderService.InitiateAuth");
    expect(login!.headers.get("content-type")).toBe("application/x-amz-json-1.1");
    expect(login!.body).toEqual({ AuthFlow: "USER_PASSWORD_AUTH", ClientId: WHISKER_COGNITO_CLIENT_ID, AuthParameters: { USERNAME: USERNAME, PASSWORD: PASSWORD } });
    const [query] = fake.graphql();
    expect(query!.headers.get("authorization")).toBe(`Bearer ${idToken()}`);
    expect(String(query!.body.query)).toContain("getLitterRobot4ByUser(userId: $userId)");
    expect(query!.body.variables).toEqual({ userId: "user-0001" });
    expect(robots.map(robot => robot.serial)).toEqual([SERIAL]);
  });

  test("reuses a live token and renews an expiring one with REFRESH_TOKEN_AUTH", async () => {
    let now = 1_000_000;
    const fake = fakeWhisker({
      auth: body => json({ AuthenticationResult: { IdToken: idToken({ exp: Math.floor(now / 1000) + 3600, marker: String(body.AuthFlow) }), ...(body.AuthFlow === "USER_PASSWORD_AUTH" ? { RefreshToken: "refresh-1" } : {}), ExpiresIn: 3600 } }),
    });
    const client = new WhiskerClient(credentials, { fetch: fake.fetch, now: () => now });
    await client.robots();
    await client.robots();
    expect(fake.cognito()).toHaveLength(1);
    now += 3_590_000;
    await client.robots();
    expect(fake.cognito().map(request => request.body.AuthFlow)).toEqual(["USER_PASSWORD_AUTH", "REFRESH_TOKEN_AUTH"]);
    expect(fake.cognito()[1]!.body.AuthParameters).toEqual({ REFRESH_TOKEN: "refresh-1" });
  });

  test("a refused refresh token falls back to the password", async () => {
    let now = 1_000_000;
    let calls = 0;
    const fake = fakeWhisker({
      auth: body => {
        calls++;
        if (body.AuthFlow === "REFRESH_TOKEN_AUTH") return json({ __type: "NotAuthorizedException", message: "Refresh Token has expired" }, 400);
        return json({ AuthenticationResult: { IdToken: idToken({ exp: Math.floor(now / 1000) + 3600 }), RefreshToken: `refresh-${calls}`, ExpiresIn: 3600 } });
      },
    });
    const client = new WhiskerClient(credentials, { fetch: fake.fetch, now: () => now });
    await client.robots();
    now += 3_600_000;
    await client.robots();
    expect(fake.cognito().map(request => request.body.AuthFlow)).toEqual(["USER_PASSWORD_AUTH", "REFRESH_TOKEN_AUTH", "USER_PASSWORD_AUTH"]);
  });

  test("concurrent callers share one sign-in", async () => {
    const fake = fakeWhisker();
    const client = new WhiskerClient(credentials, { fetch: fake.fetch });
    await Promise.all([client.robots(), client.robots(), client.robots()]);
    expect(fake.cognito()).toHaveLength(1);
  });

  test("a 401 signs in again from the password once, then gives up", async () => {
    let rejections = 1;
    const fake = fakeWhisker({ api: () => rejections-- > 0 ? json({ message: "Unauthorized" }, 401) : json({ data: { getLitterRobot4ByUser: [robotRecord()] } }) });
    const client = new WhiskerClient(credentials, { fetch: fake.fetch });
    expect(await client.robots()).toHaveLength(1);
    expect(fake.cognito().map(request => request.body.AuthFlow)).toEqual(["USER_PASSWORD_AUTH", "USER_PASSWORD_AUTH"]);

    const always = fakeWhisker({ api: () => json({ errors: [{ errorType: "UnauthorizedException", message: "Unauthorized" }] }) });
    const error = await failure(new WhiskerClient(credentials, { fetch: always.fetch }).robots());
    expect(error.code).toBe("authentication");
    expect(always.graphql()).toHaveLength(2);
  });

  test("a rejected password is an authentication error that names the fix and not the password", async () => {
    const fake = fakeWhisker({ auth: () => json({ __type: "com.amazonaws#NotAuthorizedException", message: "Incorrect username or password." }, 400) });
    const error = await failure(new WhiskerClient(credentials, { fetch: fake.fetch }).robots());
    expect(error.code).toBe("authentication");
    expect(error.message).toContain("vendors.whisker.password");
    expect(error.message).not.toContain(PASSWORD);
    expect(fake.graphql()).toHaveLength(0);
  });

  test("a challenge cannot be answered unattended", async () => {
    const fake = fakeWhisker({ auth: () => json({ ChallengeName: "SMS_MFA", Session: "s" }) });
    expect((await failure(new WhiskerClient(credentials, { fetch: fake.fetch }).robots())).code).toBe("authentication");
  });

  test("network failures are unreachable and GraphQL errors are protocol errors, without tokens", async () => {
    const down = await failure(new WhiskerClient(credentials, { fetch: async () => { throw new Error("connect ECONNREFUSED"); } }).robots());
    expect(down.code).toBe("unreachable");

    const fake = fakeWhisker({ api: () => json({ errors: [{ message: "Validation error of type FieldUndefined" }] }) });
    const error = await failure(new WhiskerClient(credentials, { fetch: fake.fetch }).robots());
    expect(error.code).toBe("protocol");
    expect(error.message).not.toContain(idToken());

    const server = fakeWhisker({ api: () => json({}, 503) });
    expect((await failure(new WhiskerClient(credentials, { fetch: server.fetch }).robots())).code).toBe("unreachable");
  });

  test("commands go through sendLitterRobot4Command and a refusal is an error", async () => {
    const fake = fakeWhisker();
    const client = new WhiskerClient(credentials, { fetch: fake.fetch });
    await client.command(SERIAL, "cleanCycle");
    const [mutation] = fake.graphql();
    expect(String(mutation!.body.query)).toContain("sendLitterRobot4Command(input:");
    expect(mutation!.body.variables).toEqual({ serial: SERIAL, command: "cleanCycle", value: null, commandSource: LR4_COMMAND_SOURCE });

    const refusing = fakeWhisker({ api: () => json({ data: { sendLitterRobot4Command: "Error sending a command" } }) });
    expect((await failure(new WhiskerClient(credentials, { fetch: refusing.fetch }).command(SERIAL, "cleanCycle"))).code).toBe("protocol");
  });

  test("an account with no robots is an empty list", async () => {
    const fake = fakeWhisker({ api: () => json({ data: { getLitterRobot4ByUser: null } }) });
    expect(await new WhiskerClient(credentials, { fetch: fake.fetch }).robots()).toEqual([]);
  });
});

describe("parseLr4Robot", () => {
  test("maps the fields HomeTruth reads", () => {
    expect(parseLr4Robot(robotRecord())).toEqual({
      serial: SERIAL, name: "Synthetic Robot", firmware: "1.1.50", online: true, lastSeen: "2026-01-01T12:00:00.000Z",
      robotStatus: "ROBOT_IDLE", status: { code: "RDY", text: "Ready" },
      wasteDrawerPercent: 40, wasteDrawerFull: false, litterLevelPercent: 65, litterLevelState: "OPTIMAL",
      catWeightPounds: 9.4, cleanCycleWaitMinutes: 7, keypadLockout: false, nightLightMode: "AUTO", nightLightLit: true,
      sleeping: false, hopperRemoved: false, powerType: "AC",
    });
  });

  test("derives status from robotStatus, the drawer and connectivity", () => {
    expect(parseLr4Robot(robotRecord({ robotStatus: "ROBOT_CLEAN" }))!.status.code).toBe("CCP");
    expect(parseLr4Robot(robotRecord({ isDFIFull: true }))!.status).toEqual({ code: "DFS", text: "Waste drawer full" });
    expect(parseLr4Robot(robotRecord({ isOnline: false }))!.status.code).toBe("OFFLINE");
    expect(parseLr4Robot(robotRecord({ robotStatus: "ROBOT_NEW_THING" }))!.status).toEqual({ code: "UNKNOWN", text: "Unknown status ROBOT_NEW_THING" });
    expect(parseLr4Robot(robotRecord({ sleepStatus: "SLEEPING" }))!.sleeping).toBe(true);
  });

  test("drops out-of-range or mistyped values instead of guessing", () => {
    const robot = parseLr4Robot(robotRecord({ DFILevelPercent: 140, litterLevelPercentage: 65, catWeight: "heavy", isKeypadLockout: "no" }))!;
    expect(robot.wasteDrawerPercent).toBeUndefined();
    expect(robot.litterLevelPercent).toBeUndefined();
    expect(robot.catWeightPounds).toBeUndefined();
    expect(robot.keypadLockout).toBeUndefined();
    expect(parseLr4Robot({ name: "no serial" })).toBeUndefined();
    expect(parseLr4Robot(null)).toBeUndefined();
  });
});
