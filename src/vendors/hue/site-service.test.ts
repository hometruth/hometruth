import { describe, expect, test } from "bun:test";
import { createHueSiteService } from "./site-service";
import { EMPTY_SECRETS } from "../../config/secrets";
import type { SecretsFile } from "../../schemas";

function secretsWith(hue: Record<string, unknown> | undefined): SecretsFile {
  return { schemaVersion: 1, ...(hue ? { vendors: { hue } } : {}) };
}

describe("createHueSiteService", () => {
  test("returns undefined when there is no vendors.hue block at all", () => {
    expect(createHueSiteService(EMPTY_SECRETS)).toBeUndefined();
  });

  test("returns undefined when any required key is missing", () => {
    const complete = { host: "10.77.0.29", applicationKey: "key", clientKey: "abcd", entertainmentAreaId: "area-1" };
    for (const missing of Object.keys(complete)) {
      const partial = { ...complete, [missing]: undefined };
      expect(createHueSiteService(secretsWith(partial))).toBeUndefined();
    }
  });

  test("returns undefined when a required key is an empty string", () => {
    expect(createHueSiteService(secretsWith({
      host: "", applicationKey: "key", clientKey: "abcd", entertainmentAreaId: "area-1",
    }))).toBeUndefined();
  });

  test("builds a service when every key is present", () => {
    const service = createHueSiteService(secretsWith({
      host: "10.77.0.29", applicationKey: "key", clientKey: "abcd", entertainmentAreaId: "area-1", bridgeId: "ECB5FA",
    }));
    expect(service).toBeDefined();
    expect(service!.clip.host).toBe("10.77.0.29");
    expect(service!.entertainmentAreaId).toBe("area-1");
    expect(service!.bridgeId).toBe("ECB5FA");
    expect(service!.session.isConnected).toBe(false);
  });

  test("bridgeId is optional", () => {
    const service = createHueSiteService(secretsWith({
      host: "10.77.0.29", applicationKey: "key", clientKey: "abcd", entertainmentAreaId: "area-1",
    }));
    expect(service?.bridgeId).toBeUndefined();
  });
});
