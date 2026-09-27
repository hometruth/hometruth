import { describe, expect, test } from "bun:test";
import { MemorySecretStore, secretsFor } from "../../config/secrets";
import { decodeAuthConfig, RING_OAUTH } from "../../protocols/ring/client";
import { oauthResponse, storedToken, ticketResponse } from "../../protocols/ring/test-fixtures";
import type { SecretsFile } from "../../schemas";
import { createRingSiteService } from "./site-service";

const EMPTY: SecretsFile = { schemaVersion: 1 };
const withToken = (refreshToken: string): SecretsFile => ({ schemaVersion: 1, vendors: { ring: { refreshToken } } });

describe("createRingSiteService", () => {
  test("a site without a Ring account has no Ring service", () => {
    expect(createRingSiteService(EMPTY)).toBeUndefined();
    expect(createRingSiteService({ schemaVersion: 1, vendors: { ring: { refreshToken: "   " } } })).toBeUndefined();
  });

  test("hands out one connection per location, so two devices cannot fight over it", () => {
    const service = createRingSiteService(withToken(storedToken("refresh-1")))!;
    expect(service.connectionFor("loc-1")).toBe(service.connectionFor("loc-1"));
    expect(service.connectionFor("loc-1")).not.toBe(service.connectionFor("loc-2"));
    service.stop();
  });

  test("writes the rotated refresh token back, or the next restart has a dead one", async () => {
    const store = new MemorySecretStore(withToken(storedToken("refresh-1")));
    const service = createRingSiteService(await store.load(), {
      store,
      fetch: async url => url.href === RING_OAUTH ? oauthResponse({ refresh_token: "refresh-2" }) : ticketResponse(),
    })!;
    await service.client.token();
    const saved = secretsFor(await store.load(), "vendors", "ring").refreshToken;
    expect(decodeAuthConfig(String(saved)).rt).toBe("refresh-2");
    service.stop();
  });

  test("a store that cannot be written is reported, not swallowed, and does not break the session", async () => {
    const failing = new MemorySecretStore(withToken(storedToken("refresh-1")));
    failing.save = async () => { throw new Error("disk full"); };
    const problems: string[] = [];
    const service = createRingSiteService(withToken(storedToken("refresh-1")), {
      store: failing,
      onError: message => problems.push(message),
      fetch: async url => url.href === RING_OAUTH ? oauthResponse({ refresh_token: "refresh-2" }) : ticketResponse(),
    })!;
    expect(await service.client.token()).toBe("access-1");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("disk full");
    service.stop();
  });
});
