import { describe, expect, test } from "bun:test";
import { decodeAuthConfig, encodeAuthConfig, RingClient, RingError, RING_OAUTH } from "./client";
import { oauthResponse, ringDevicesResponse, ticketResponse, RING_HARDWARE_ID, RING_LOCATION, storedToken } from "./test-fixtures";

interface Call { url: string; headers: Record<string, string>; body?: unknown }

function fixture(responses: (url: URL) => Response | undefined, options: { token?: string } = {}) {
  const calls: Call[] = [];
  const stored: string[] = [];
  let now = 1_000_000;
  const client = new RingClient(options.token ?? storedToken("refresh-1"), {
    now: () => now,
    hardwareId: () => RING_HARDWARE_ID,
    onRefreshToken: encoded => { stored.push(encoded); },
    fetch: async (url, init) => {
      const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
      calls.push({ url: url.href, headers, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      return responses(url) ?? new Response(null, { status: 500 });
    },
  });
  return { client, calls, stored, advance: (ms: number) => { now += ms; } };
}

const happyPath = (url: URL): Response | undefined => {
  if (url.href === RING_OAUTH) return oauthResponse();
  if (url.pathname.endsWith("/ring_devices")) return ringDevicesResponse();
  if (url.pathname.endsWith("/clap/tickets")) return ticketResponse();
  return undefined;
};

describe("Ring auth config", () => {
  test("reads the wrapped token ring-auth-cli emits, and a bare token too", () => {
    expect(decodeAuthConfig(encodeAuthConfig({ rt: "abc", hid: "hw" }))).toEqual({ rt: "abc", hid: "hw" });
    expect(decodeAuthConfig("plain-token")).toEqual({ rt: "plain-token" });
    // Base64 of something that is not an auth config is a token, not a crash.
    expect(decodeAuthConfig(Buffer.from('{"nope":1}').toString("base64")).rt).toContain("eyJub3BlIjoxfQ");
  });
});

describe("RingClient", () => {
  test("refreshes once and reuses the access token until it nears expiry", async () => {
    const f = fixture(happyPath);
    await f.client.listBridges();
    await f.client.listBridges();
    expect(f.calls.filter(call => call.url === RING_OAUTH)).toHaveLength(1);
    f.advance(3600_000);
    await f.client.listBridges();
    expect(f.calls.filter(call => call.url === RING_OAUTH)).toHaveLength(2);
  });

  test("sends the app's client id and the token's own hardware id", async () => {
    const f = fixture(happyPath);
    await f.client.listBridges();
    const auth = f.calls.find(call => call.url === RING_OAUTH)!;
    expect(auth.body).toEqual({ grant_type: "refresh_token", refresh_token: "refresh-1", client_id: "ring_official_android", scope: "client" });
    expect(auth.headers.hardware_id).toBe(RING_HARDWARE_ID);
    expect(auth.headers["User-Agent"]).toBe("android:com.ringapp");
    const read = f.calls.find(call => call.url.endsWith("/ring_devices"))!;
    expect(read.headers.authorization).toBe("Bearer access-1");
  });

  test("stores the rotated refresh token, keeping the hardware id with it", async () => {
    const f = fixture(url => url.href === RING_OAUTH ? oauthResponse({ refresh_token: "refresh-2" }) : happyPath(url));
    await f.client.listBridges();
    expect(f.stored).toHaveLength(1);
    expect(decodeAuthConfig(f.stored[0]!)).toEqual({ rt: "refresh-2", hid: RING_HARDWARE_ID });
    expect(decodeAuthConfig(f.client.storedToken).rt).toBe("refresh-2");
  });

  test("does not rewrite the token when Ring returns the same one", async () => {
    const f = fixture(url => url.href === RING_OAUTH ? oauthResponse({ refresh_token: "refresh-1" }) : happyPath(url));
    await f.client.listBridges();
    expect(f.stored).toEqual([]);
  });

  test("names the fix when Ring rejects the refresh token", async () => {
    const f = fixture(url => url.href === RING_OAUTH ? new Response(null, { status: 401 }) : undefined);
    const error = await f.client.listBridges().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RingError);
    expect((error as RingError).code).toBe("authentication");
    expect((error as RingError).message).toContain("ring-auth-cli");
  });

  test("reports rate limiting as its own condition rather than an outage", async () => {
    const f = fixture(url => url.href === RING_OAUTH ? oauthResponse() : new Response(null, { status: 429 }));
    const error = await f.client.listBridges().catch((e: unknown) => e);
    expect((error as RingError).code).toBe("rate_limited");
  });

  test("re-authenticates after the access token is refused", async () => {
    let refuse = true;
    const f = fixture(url => {
      if (url.href === RING_OAUTH) return oauthResponse();
      if (refuse) { refuse = false; return new Response(null, { status: 401 }); }
      return ringDevicesResponse();
    });
    await expect(f.client.listBridges()).rejects.toThrow(RingError);
    await f.client.listBridges();
    expect(f.calls.filter(call => call.url === RING_OAUTH)).toHaveLength(2);
  });

  test("never lets a token reach an error message", async () => {
    const f = fixture(url => url.href === RING_OAUTH ? oauthResponse() : undefined);
    const error = await f.client.ticket(RING_LOCATION).catch((e: unknown) => e) as RingError;
    expect(error.message).not.toContain("refresh-1");
    expect(error.message).not.toContain("access-1");
  });

  test("turns a network failure into an outage without leaking the request", async () => {
    const client = new RingClient(storedToken("refresh-1"), { fetch: async () => { throw new Error("connect ECONNREFUSED refresh-1"); } });
    const error = await client.listBridges().catch((e: unknown) => e) as RingError;
    expect(error.code).toBe("unavailable");
    expect(error.message).not.toContain("refresh-1");
  });

  test("reads the bridges and the websocket ticket out of Ring's shapes", async () => {
    const f = fixture(happyPath);
    expect(await f.client.listBridges()).toEqual([{ id: "42", locationId: RING_LOCATION, description: "Bridge", kind: "beams_bridge_v1" }]);
    const ticket = await f.client.ticket(RING_LOCATION);
    expect(ticket.host).toBe("ws.example.ring.com");
    expect(ticket.assets).toEqual([{ uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", kind: "beams_bridge_v1" }]);
    const request = f.calls.find(call => call.url.includes("clap/tickets"))!;
    expect(request.url).toContain(`locationID=${RING_LOCATION}`);
    expect(request.url).toContain("requestedTransport=ws");
  });

  test("rejects a location id that is not one", async () => {
    const f = fixture(happyPath);
    await expect(f.client.ticket("../../etc")).rejects.toThrow(RingError);
  });

  test("an account with no bridges is an empty list, not an error", async () => {
    const f = fixture(url => url.pathname.endsWith("/ring_devices") ? ringDevicesResponse([]) : happyPath(url));
    expect(await f.client.listBridges()).toEqual([]);
  });
});
