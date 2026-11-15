import { describe, expect, test } from "bun:test";
import { EnvoyClient } from "./client";
import { EnphaseProtocolError, parseBatteryPower, parseEnsembleInventory, parseInfo, parseInverters, parseProduction, parseSecctrl } from "./local-api";
import { ENLIGHTEN_LOGIN_URL, ENTREZ_TOKENS_URL, EnlightenOwnerToken, StaticOwnerToken, tokenExpiry, type EnphaseFetch } from "./token";
import { ENSEMBLE_POWER, HOST, INFO_XML, INVERTERS, PRODUCTION, PRODUCTION_WITHOUT_METERS, SECCTRL, SERIAL, inventory, ownerToken } from "./test-fixtures";

describe("Enphase local API parsers", () => {
  test("/info yields serial, part number and firmware without the build letter", () => {
    expect(parseInfo(INFO_XML)).toEqual({ serialNumber: SERIAL, partNumber: "800-00654-r08", firmwareVersion: "8.2.4499", webTokens: true });
    expect(() => parseInfo("<html>login</html>")).toThrow(EnphaseProtocolError);
    expect(() => parseInfo("<envoy_info><device><sn>x</sn></device></envoy_info>")).toThrow("no serial");
  });

  test("production.json prefers active CTs and keeps Enphase's net sign", () => {
    expect(parseProduction(PRODUCTION)).toEqual({
      production: { watts: 6123.4, whToday: 18_456.8, whLifetime: 41_387_512.6, source: "eim" },
      consumption: { watts: 3376.2, whToday: 12_034.5, whLifetime: 30_123_456.7 },
      net: { watts: -2747.2 },
      invertersActive: 30,
    });
  });

  test("production.json without CTs falls back to the inverters and reports no consumption", () => {
    expect(parseProduction(PRODUCTION_WITHOUT_METERS)).toEqual({
      production: { watts: 6012, whLifetime: 41_250_000, source: "inverters" },
      invertersActive: 30,
    });
    expect(() => parseProduction({ production: [] })).toThrow("no production reading");
    expect(() => parseProduction({ wNow: 5 })).toThrow("no production list");
    expect(() => parseProduction({ production: [{ type: "eim", measurementType: "production", activeCount: 1, wNow: "5" }] })).toThrow(EnphaseProtocolError);
  });

  test("inverters keep their own report time and drop malformed entries", () => {
    const readings = parseInverters([...INVERTERS, { serialNumber: "bad serial!", lastReportWatts: 5 }, { serialNumber: "122199999999" }]);
    expect(readings).toHaveLength(30);
    expect(readings[0]).toEqual({ serialNumber: INVERTERS[0]!.serialNumber, watts: 200, maxWatts: 295, reportedAt: new Date(INVERTERS[0]!.lastReportDate * 1000).toISOString() });
    expect(() => parseInverters({})).toThrow(EnphaseProtocolError);
  });

  test("ensemble inventory, secctrl and power", () => {
    const parsed = parseEnsembleInventory(inventory());
    expect(parsed.batteries).toHaveLength(6);
    expect(parsed.batteries[5]).toMatchObject({ percent: 86, capacityWh: 3360 });
    expect(parsed.controllers).toEqual([expect.objectContaining({ grid: "on-grid" })]);
    expect(parseEnsembleInventory(inventory("open")).controllers[0]!.grid).toBe("off-grid");
    expect(parseEnsembleInventory([])).toEqual({ batteries: [], controllers: [] });
    expect(parseSecctrl(SECCTRL)).toEqual({ percent: 82, availableWh: 16531, capacityWh: 20160 });
    expect(parseSecctrl({ agg_soc: 40 })).toEqual({ percent: 40 });
    expect(parseBatteryPower(ENSEMBLE_POWER)).toBe(-1500);
    expect(parseBatteryPower({ devices: [{ real_power_mw: 1000 }] })).toBe(1);
    expect(parseBatteryPower({ "devices:": [] })).toBeUndefined();
    expect(() => parseBatteryPower({ power: 1 })).toThrow(EnphaseProtocolError);
  });
});

describe("owner tokens", () => {
  test("a static token is used until its exp, then names the fix", async () => {
    const token = ownerToken(2_000_000_000);
    expect(tokenExpiry(token)?.toISOString()).toBe("2033-05-18T03:33:20.000Z");
    let now = 1_900_000_000_000;
    const source = new StaticOwnerToken(token, () => now);
    expect(await source.token()).toBe(token);
    expect(source.rejected()).toBe(false);
    now = 2_000_000_001_000;
    const error = await source.token().catch((e: Error) => e);
    expect(String(error)).toContain("expired on 2033-05-18; replace it in the secrets file");
    expect(String(error)).not.toContain(token);
    expect(() => new StaticOwnerToken("not-a-token")).toThrow("not a JWT");
  });

  function cloud(options: { password?: string; tokens?: string[] } = {}) {
    const calls: { url: string; body: string; headers: Headers }[] = [];
    const issued = [...(options.tokens ?? [ownerToken()])];
    const fetch: EnphaseFetch = async (url, init) => {
      const body = String(init?.body ?? "");
      calls.push({ url: url.href, body, headers: new Headers(init?.headers) });
      expect(init?.method).toBe("POST");
      if (url.href === ENLIGHTEN_LOGIN_URL) {
        const form = new URLSearchParams(body);
        return form.get("user[password]") === (options.password ?? "correct horse") && form.get("user[email]") === "owner@example.com"
          ? Response.json({ message: "success", session_id: "synthetic-session", manager_token: "x", is_consumer: true })
          : Response.json({ message: "failure" });
      }
      if (url.href === ENTREZ_TOKENS_URL) {
        expect(JSON.parse(body)).toEqual({ session_id: "synthetic-session", serial_num: SERIAL, username: "owner@example.com" });
        return new Response(issued.shift() ?? ownerToken(), { headers: { "content-type": "text/plain" } });
      }
      return new Response("not found", { status: 404 });
    };
    return { calls, fetch };
  }

  test("Enlighten login fetches once, caches, and refreshes after the gateway refuses it", async () => {
    const first = ownerToken(1_893_456_000, "00000000-0000-4000-8000-00000000000a");
    const second = ownerToken(1_893_456_000, "00000000-0000-4000-8000-00000000000b");
    const { calls, fetch } = cloud({ tokens: [first, second] });
    let now = 1_800_000_000_000;
    const source = new EnlightenOwnerToken({ username: "owner@example.com", password: "correct horse", serialNumber: async () => SERIAL, fetch, now: () => now });
    const [a, b] = await Promise.all([source.token(), source.token()]);
    expect(a).toBe(first);
    expect(b).toBe(first);
    expect(calls.map((call) => call.url)).toEqual([ENLIGHTEN_LOGIN_URL, ENTREZ_TOKENS_URL]);
    expect(calls[0]!.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    now += 10 * 60_000;
    expect(source.rejected(first)).toBe(true);
    expect(await source.token()).toBe(second);
    expect(calls).toHaveLength(4);
    // A just-issued token that is refused again backs off instead of asking the cloud every poll.
    expect(source.rejected(second)).toBe(false);
    await expect(source.token()).rejects.toThrow("retrying later");
    expect(calls).toHaveLength(4);
  });

  test("a wrong password fails without echoing it and backs off", async () => {
    const { calls, fetch } = cloud({ password: "something else" });
    let now = 1_800_000_000_000;
    const source = new EnlightenOwnerToken({ username: "owner@example.com", password: "correct horse", serialNumber: async () => SERIAL, fetch, now: () => now, retryAfterMs: 60_000 });
    const error = await source.token().catch((e: Error) => e);
    expect(String(error)).toContain("refused the username or password");
    expect(String(error)).not.toContain("correct horse");
    await expect(source.token()).rejects.toThrow("retrying later");
    expect(calls).toHaveLength(1);
    now += 61_000;
    await expect(source.token()).rejects.toThrow("refused");
    expect(calls).toHaveLength(2);
  });

  test("renews a cached token near its exp", async () => {
    const soon = ownerToken(1_800_000_100);
    const { calls, fetch } = cloud({ tokens: [soon, ownerToken()] });
    const source = new EnlightenOwnerToken({ username: "owner@example.com", password: "correct horse", serialNumber: async () => SERIAL, fetch, now: () => 1_800_000_000_000 });
    expect(await source.token()).toBe(soon);
    expect(await source.token()).toBe(ownerToken());
    expect(calls).toHaveLength(4);
  });
});

describe("Envoy HTTPS client", () => {
  test("rejects public hosts before any request", () => {
    expect(() => new EnvoyClient({ host: "8.8.8.8" })).toThrow("private LAN address");
    expect(() => new EnvoyClient({ host: "envoy.example.com" })).toThrow("private LAN address");
    expect(() => new EnvoyClient({ host: "envoy.local" })).not.toThrow();
  });

  test("sends the bearer token over HTTPS, retries one 401 with a fresh token, and maps 404 to absent", async () => {
    const good = ownerToken(1_893_456_000, "00000000-0000-4000-8000-0000000000b0");
    const stale = ownerToken(1_893_456_000, "00000000-0000-4000-8000-0000000000a0");
    let current = stale;
    const seen: string[] = [];
    const client = new EnvoyClient({
      host: HOST,
      tokens: { token: async () => current, rejected: (token) => { if (token === stale) { current = good; return true; } return false; } },
      fetch: async (url, init) => {
        expect(url.protocol).toBe("https:");
        expect(url.hostname).toBe(HOST);
        expect(init?.redirect).toBe("manual");
        const auth = new Headers(init?.headers).get("authorization");
        seen.push(`${url.pathname} ${auth === `Bearer ${good}` ? "good" : auth === `Bearer ${stale}` ? "stale" : "none"}`);
        if (auth !== `Bearer ${good}`) return new Response("", { status: 401 });
        return url.pathname === "/missing" ? new Response("", { status: 404 }) : Response.json({ ok: true });
      },
    });
    expect(await client.json("/production.json?details=1")).toEqual({ ok: true });
    expect(await client.json("/missing")).toBeUndefined();
    expect(seen).toEqual(["/production.json stale", "/production.json good", "/missing good"]);
  });

  test("a refused token is unauthorized and the message carries no token", async () => {
    const token = ownerToken();
    const client = new EnvoyClient({ host: HOST, tokens: new StaticOwnerToken(token), fetch: async () => new Response("", { status: 302, headers: { location: "/home" } }) });
    const error = await client.json("/production.json").catch((e: Error & { code?: string }) => e);
    expect((error as { code?: string }).code).toBe("unauthorized");
    expect(String(error)).not.toContain(token);
  });

  test("/info needs no token; an unreachable gateway is unreachable", async () => {
    const client = new EnvoyClient({ host: HOST, fetch: async (url, init) => {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return new Response(url.pathname === "/info" ? INFO_XML : "", { status: url.pathname === "/info" ? 200 : 404 });
    } });
    expect((await client.info()).serialNumber).toBe(SERIAL);
    const down = new EnvoyClient({ host: HOST, fetch: async () => { throw new TypeError("connect EHOSTUNREACH"); } });
    await expect(down.info()).rejects.toMatchObject({ code: "unreachable" });
  });
});
