import { describe, expect, test } from "bun:test";
import { CameraService, credentialsForHost, type HostCredentials, type LocalCameraCredentials } from "./camera-service";

describe("per-camera credentials", () => {
  test("credentialsForHost prefers the camera's own login over the site-wide fallback", () => {
    const credentials: LocalCameraCredentials = { username: "admin", password: "site", perHost: { "10.78.0.64": { username: "admin", password: "own" } } };
    expect(credentialsForHost(credentials, "10.78.0.64")).toEqual({ username: "admin", password: "own" });
    expect(credentialsForHost(credentials, "10.78.0.147")).toEqual({ username: "admin", password: "site" });
    expect(credentialsForHost({}, "10.78.0.147")).toEqual({});
  });

  test("registered credentials reach discovery per host, and the settings form saves ONVIF fields under the selected camera", async () => {
    const seen: LocalCameraCredentials[] = [];
    const saved: [string, HostCredentials][] = [];
    const service = new CameraService({
      async connectCloud() { return { async discover() { return []; } }; },
      async discoverLocal(_request, credentials) {
        seen.push(credentials);
        return [{
          view: { id: "100000001", name: "cam", host: "10.78.0.147", status: "online", stream: "unknown", snapshot: "unknown", capabilities: [] },
          controller: { async control() {}, async ptzStart() {}, async ptzStop() {} },
        }];
      },
      localControlAvailable: true,
      setupStore: { async load() { return undefined; }, async save() {}, async clear() {} },
      async saveHostCredentials(host, credentials) { saved.push([host, credentials]); },
    });
    service.registerHostCredentials("10.78.0.147", { username: "admin", password: "own" });
    await service.discover({ hosts: ["10.78.0.147"], cidrs: [] });
    expect(seen[0]?.perHost).toEqual({ "10.78.0.147": { username: "admin", password: "own" } });

    await service.select("100000001");
    await service.setup({ profile: "cloudedge", onvifUsername: "admin", onvifPassword: "typed" });
    expect(saved).toEqual([["10.78.0.147", { username: "admin", password: "typed" }]]);
    await service.discover({ hosts: ["10.78.0.147"], cidrs: [] });
    expect(seen[1]?.perHost?.["10.78.0.147"]).toEqual({ username: "admin", password: "typed" });
  });
});
