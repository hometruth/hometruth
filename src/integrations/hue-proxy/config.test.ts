import { expect, test } from "bun:test";
import { parseProxyConfig } from "./config";
const base = { listen: { advertiseAddress: "10.77.0.80" }, bridge: { url: "https://10.77.0.2" } };
test("config applies defaults without mutating the input", () => {
  const config = parseProxyConfig(base);
  expect(config.listen.httpsPort).toBe(443);
  expect(config.monitor.enabled).toBe(true);
  expect(base.listen).not.toHaveProperty("httpsPort");
});
test("config catches unknown targets, typos, public bridges and proxy loops", () => {
  expect(() => parseProxyConfig({ ...base, typo: true })).toThrow();
  expect(() => parseProxyConfig({ ...base, routes: [{ id: "sync", sources: ["light/*"], targets: ["missing"] }] })).toThrow("unknown target");
  expect(() => parseProxyConfig({ ...base, bridge: { url: "https://8.8.8.8" } })).toThrow("private IPv4");
  expect(() => parseProxyConfig({ ...base, bridge: { url: "https://10.77.0.80" } })).toThrow("back at the proxy");
});
test("config refuses secrets in URLs and raw sends back to source bridge", () => {
  expect(() => parseProxyConfig({ ...base, targets: [{ id: "x", kind: "webhook", url: "https://user:password@example.com" }] })).toThrow("credentials");
  expect(() => parseProxyConfig({ ...base, targets: [{ id: "x", kind: "webhook", url: "https://10.77.0.2" }] })).toThrow("feedback loop");
});
