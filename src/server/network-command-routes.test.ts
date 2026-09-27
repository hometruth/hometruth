import { describe, expect, test } from "bun:test";
import { WifiAdmissionService } from "../network/wifi-admission-service";
import type { AdmissionResult } from "../network/wifi-admission";
import { createApp } from "./app";

function fixture() {
  let finish: ((result: AdmissionResult) => void) | undefined;
  let fail: ((error: Error) => void) | undefined;
  let report: ((message: string) => void) | undefined;
  let aborted = false;
  let starts = 0;
  const service = new WifiAdmissionService({
    inspect: async () => ({ networks: [{ ssid: "Test IoT", available: true, allowedCount: 2 }] }),
    run: async (_options, progress, signal) => {
      starts++;
      report = progress;
      signal.addEventListener("abort", () => { aborted = true; });
      return await new Promise<AdmissionResult>((resolve, reject) => { finish = resolve; fail = reject; });
    },
  });
  const app = createApp(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, service);
  const post = (path: string, body: unknown, origin?: string) => app.request(path, { method: "POST", headers: {
    "content-type": "application/json", ...(origin ? { origin } : {}),
  }, body: JSON.stringify(body) });
  return { app, post, service, starts: () => starts, aborted: () => aborted,
    finish: (result: AdmissionResult) => finish!(result), fail: (message: string) => fail!(new Error(message)), report: (message: string) => report!(message) };
}
const api = "/api/network/commands/accept-next";
const settled = () => Bun.sleep(0);

describe("Network Commands", () => {
  test("network page links to a read-only command page and never starts on load or refresh", async () => {
    const f = fixture();
    const network = await f.app.request("/network-isolation");
    expect(network.status).toBe(200);
    expect(await network.text()).toContain('href="/network/commands/accept-next"');
    const page = await f.app.request("/network/commands/accept-next");
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(await page.text()).toContain("Run command");
    const options = await f.app.request(`${api}/options`);
    expect(await options.json()).toEqual({ networks: [{ ssid: "Test IoT", available: true, allowedCount: 2 }] });
    expect(f.starts()).toBe(0);
  });

  test("returns immediately, streams progress through snapshots, prevents overlap, and keeps joined details", async () => {
    const f = fixture();
    const response = await f.post(api, { ssid: "Test IoT", timeoutSeconds: 120 });
    expect(response.status).toBe(202);
    const { run } = await response.json();
    expect(run).toMatchObject({ ssid: "Test IoT", status: "running", timeoutSeconds: 120 });
    expect((await f.post(api, { ssid: "Test IoT" })).status).toBe(409);
    expect(f.starts()).toBe(1);
    f.report("Window is open");
    expect((await (await f.app.request(api)).json()).run.activity[0].message).toBe("Window is open");
    f.finish({ status: "accepted", ssid: "Test IoT", allowedCount: 3, filterEnabled: true,
      client: { ssid: "Test IoT", mac: "02:00:00:00:00:02", name: '<img src=x onerror="alert(1)">', address: "10.78.0.52" } });
    await settled();
    const complete = (await (await f.app.request(api)).json()).run;
    expect(complete).toMatchObject({ id: run.id, status: "complete", result: { client: { address: "10.78.0.52" } } });
    const refreshed = await (await f.app.request("/network/commands/accept-next")).text();
    expect(refreshed).toContain("10.78.0.52");
    expect(refreshed).toContain("&lt;img src=x");
    expect(refreshed).not.toContain('<img src=x');
    const copy = f.service.snapshot()!;
    copy.activity.length = 0;
    expect(f.service.snapshot()!.activity).toHaveLength(1);
  });

  test("cancellation waits for restoration and a stale page cannot cancel a different run", async () => {
    const f = fixture();
    const { run } = await (await f.post(api, { ssid: "Test IoT" })).json();
    expect((await f.post(`${api}/old-run/cancel`, {})).status).toBe(409);
    const cancel = await f.post(`${api}/${run.id}/cancel`, {});
    expect((await cancel.json()).run.status).toBe("stopping");
    expect(f.aborted()).toBe(true);
    expect((await f.post(api, { ssid: "Test IoT" })).status).toBe(409);
    f.finish({ status: "cancelled", ssid: "Test IoT", allowedCount: 2, filterEnabled: true });
    await settled();
    expect(f.service.snapshot()).toMatchObject({ status: "complete", result: { status: "cancelled" } });
  });

  test("reports failures without claiming restoration and allows explicit recovery", async () => {
    const f = fixture();
    await f.post(api, { ssid: "Test IoT" });
    f.fail("The router is unreachable; recovery snapshot retained");
    await settled();
    expect(f.service.snapshot()).toMatchObject({ status: "failed", error: "The router is unreachable; recovery snapshot retained" });
    expect(f.service.snapshot()?.result).toBeUndefined();
    const { run } = await (await f.post(api, { ssid: "Test IoT", recover: true })).json();
    expect(run.recovery).toBe(true);
    expect((await f.post(`${api}/${run.id}/cancel`, {})).status).toBe(409);
    f.finish({ status: "restored", ssid: "Test IoT", allowedCount: 2, filterEnabled: true });
    await settled();
  });

  test("rejects malformed requests and cross-origin changes before starting", async () => {
    const f = fixture();
    for (const value of [null, [], {}, { ssid: "" }, { ssid: "Test", timeoutSeconds: 601 }, { ssid: "Test", timeoutSeconds: "180" }, { ssid: "Test", recover: "yes" }, { ssid: "Test", command: "anything" }]) {
      expect((await f.post(api, value)).status).toBe(400);
    }
    expect((await f.post(api, { ssid: "Test IoT" }, "https://untrusted.example")).status).toBe(403);
    expect(f.starts()).toBe(0);
  });
});
