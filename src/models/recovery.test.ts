import { describe, expect, test } from "bun:test";
import {
  CameraRecoveryError,
  isDifferentCamera,
  rebootCamera,
  type CameraLocation,
  type CameraRecoveryDependencies,
} from "./recovery";

interface FixtureOptions {
  /** Hosts that answer ONVIF, mapped to their serial; the set may change over fake time. */
  answering?: Record<string, string>;
  /** Fake time after the reboot at which the configured host answers again (ms). */
  backAtMs?: number;
  /** Fake time after the reboot at which a camera rebooted in place stops answering. */
  downAtMs?: number;
  cloudLocation?: CameraLocation | undefined;
  locateError?: Error;
  rebootError?: Error;
  withLocate?: boolean;
}

function fixture(options: FixtureOptions = {}) {
  const calls: string[] = [];
  let clock = 0;
  let rebootedAt: number | undefined;
  const answering = new Map(Object.entries(options.answering ?? {}));
  const dependencies: CameraRecoveryDependencies = {
    async probe(host) {
      calls.push(`probe:${host}@${clock}`);
      if (rebootedAt !== undefined) {
        const since = clock - rebootedAt;
        if (options.downAtMs !== undefined && since >= options.downAtMs) answering.delete("10.78.0.147");
        if (options.backAtMs !== undefined && since >= options.backAtMs) answering.set("10.78.0.147", "100000001");
      }
      const serial = answering.get(host);
      if (!serial) throw new Error("connect ETIMEDOUT");
      return { serialNumber: serial, model: "Pet 3T" };
    },
    async reboot(host) {
      calls.push(`reboot:${host}`);
      if (options.rebootError) throw options.rebootError;
      rebootedAt = clock;
    },
    ...(options.withLocate === false ? {} : {
      async locate(identity, account) {
        calls.push(`locate:${identity.serialNumber ?? ""}:${account.email}`);
        if (options.locateError) throw options.locateError;
        return options.cloudLocation;
      },
    }),
    async sleep(ms) { clock += ms; },
    now: () => clock,
  };
  return { dependencies, calls };
}

const request = {
  configuredHost: "10.78.0.147",
  identity: { serialNumber: "100000001", uuid: "708dc5f1b76b4d2b" },
  credentials: { username: "admin", password: "admin" },
  account: { email: "owner@example.com", password: "pw" },
};

describe("rebootCamera", () => {
  test("reboots a camera that answers at its configured address and waits for it to go down and come back", async () => {
    const { dependencies, calls } = fixture({ answering: { "10.78.0.147": "100000001" }, downAtMs: 5_000, backAtMs: 35_000 });
    const outcome = await rebootCamera(dependencies, request, { pollIntervalMs: 5_000 });
    expect(outcome.reachedVia).toBe("configured-host");
    expect(outcome.rebootedAt).toBe("10.78.0.147");
    expect(outcome.backAfterMs).toBe(35_000);
    expect(outcome.message).toBe("Rebooted it at 10.78.0.147; it answered at 10.78.0.147 again 35 s later");
    expect(calls).toContain("reboot:10.78.0.147");
    expect(calls.some((call) => call.startsWith("locate:"))).toBe(false);
  });

  test("asks the vendor cloud when the configured address is dead and reboots the camera where it really is", async () => {
    const { dependencies, calls } = fixture({
      answering: { "10.0.0.82": "100000001" },
      cloudLocation: { host: "10.0.0.82", gateway: "10.0.0.1" },
      backAtMs: 33_000,
    });
    const outcome = await rebootCamera(dependencies, request, { pollIntervalMs: 5_000 });
    expect(outcome.reachedVia).toBe("vendor-cloud");
    expect(outcome.rebootedAt).toBe("10.0.0.82");
    expect(outcome.cloudLocation).toEqual({ host: "10.0.0.82", gateway: "10.0.0.1" });
    expect(outcome.backAfterMs).toBe(35_000);
    expect(outcome.message).toContain("10.78.0.147 did not answer ONVIF (connect ETIMEDOUT)");
    expect(outcome.message).toContain("the vendor cloud reported it at 10.0.0.82 (gateway 10.0.0.1, so it joined its backup Wi-Fi)");
    expect(outcome.message).toContain("rebooted it at 10.0.0.82; it answered at 10.78.0.147 again 35 s later");
    expect(calls).toContain("locate:100000001:owner@example.com");
    expect(calls).toContain("reboot:10.0.0.82");
  });

  test("reports a camera that never comes back without failing", async () => {
    const { dependencies } = fixture({ answering: { "10.0.0.82": "100000001" }, cloudLocation: { host: "10.0.0.82" } });
    const outcome = await rebootCamera(dependencies, request, { timeoutMs: 20_000, pollIntervalMs: 5_000 });
    expect(outcome.backAfterMs).toBeUndefined();
    expect(outcome.message).toContain("has not answered at 10.78.0.147 after 20 s");
    expect(outcome.message).toContain("backup Wi-Fi");
  });

  test("treats a camera that keeps answering in place as back once the down-wait expires", async () => {
    const { dependencies } = fixture({ answering: { "10.78.0.147": "100000001" } });
    const outcome = await rebootCamera(dependencies, request, { timeoutMs: 60_000, pollIntervalMs: 10_000 });
    expect(outcome.backAfterMs).toBe(30_000);
  });

  test("refuses to reboot a different camera answering at the located address", async () => {
    const { dependencies, calls } = fixture({ answering: { "10.0.0.82": "100000002" }, cloudLocation: { host: "10.0.0.82" } });
    await expect(rebootCamera(dependencies, request)).rejects.toMatchObject({ code: "wrong_camera" });
    expect(calls.some((call) => call.startsWith("reboot:"))).toBe(false);
  });

  test("explains an unreachable camera when the cloud has no better address", async () => {
    const same = fixture({ cloudLocation: { host: "10.78.0.147" } });
    await expect(rebootCamera(same.dependencies, request)).rejects.toThrow(/also reports it at 10\.78\.0\.147/u);
    const unlisted = fixture({ cloudLocation: undefined });
    await expect(rebootCamera(unlisted.dependencies, request)).rejects.toThrow(/does not list this camera/u);
    const silent = fixture({ cloudLocation: { host: "10.0.0.82" } });
    await expect(rebootCamera(silent.dependencies, request)).rejects.toThrow(/did not answer ONVIF there either/u);
  });

  test("needs the saved app account to ask the cloud", async () => {
    const { dependencies } = fixture({ cloudLocation: { host: "10.0.0.82" } });
    const { account: _account, ...withoutAccount } = request;
    const error = await rebootCamera(dependencies, withoutAccount).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CameraRecoveryError);
    expect((error as CameraRecoveryError).code).toBe("not_configured");
    expect((error as CameraRecoveryError).message).toContain("Save the app account");
  });

  test("fails plainly when there is no cloud lookup at all", async () => {
    const { dependencies } = fixture({ withLocate: false });
    await expect(rebootCamera(dependencies, request)).rejects.toMatchObject({ code: "unreachable" });
  });

  test("wraps cloud and reboot failures", async () => {
    const cloud = fixture({ locateError: new Error("login rejected") });
    await expect(rebootCamera(cloud.dependencies, request)).rejects.toThrow(/could not be asked where it is \(login rejected\)/u);
    const reboot = fixture({ answering: { "10.78.0.147": "100000001" }, rebootError: new Error("HTTP 401") });
    await expect(rebootCamera(reboot.dependencies, request)).rejects.toThrow(/did not accept the ONVIF reboot \(HTTP 401\)/u);
  });
});

describe("isDifferentCamera", () => {
  test("only flags a mismatch when both serials are known", () => {
    expect(isDifferentCamera({ serialNumber: "1" }, { serialNumber: "2" })).toBe(true);
    expect(isDifferentCamera({ serialNumber: "1" }, { serialNumber: "1" })).toBe(false);
    expect(isDifferentCamera({}, { serialNumber: "2" })).toBe(false);
    expect(isDifferentCamera({ serialNumber: "1" }, {})).toBe(false);
  });
});
