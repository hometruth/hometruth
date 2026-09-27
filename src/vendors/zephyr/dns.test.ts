import { expect, test } from "bun:test";
import { lookupGatewayDns, parseDnsAnswer, verifyDnsEventually } from "./dns";

test("parses only direct A answers, without discarding conflicting records", () => {
  expect(parseDnsAnswer("192.0.2.20\n")).toEqual(["192.0.2.20"]);
  expect(parseDnsAnswer("192.0.2.20\n192.0.2.10\n")).toEqual(["192.0.2.20", "192.0.2.10"]);
  expect(parseDnsAnswer("\n")).toEqual([]);
  expect(() => parseDnsAnswer("alias.example\n192.0.2.20")).toThrow("unexpected");
});
test("validates wire-query arguments before spawning the DNS utility", async () => {
  await expect(lookupGatewayDns("untrusted.example", "cloud.example")).rejects.toThrow("numeric");
  await expect(lookupGatewayDns("192.0.2.1", "+trace")).rejects.toThrow("hostname");
});

test("waits for an acknowledged DNS policy to reach the resolver", async () => {
  const delays: number[] = [];
  let attempt = 0;
  await verifyDnsEventually(async () => ++attempt < 3 ? ["192.0.2.10"] : ["192.0.2.20"], "192.0.2.20", async delay => { delays.push(delay); });
  expect(attempt).toBe(3);
  expect(delays).toEqual([500, 1000]);
});
test("tolerates a transient resolver error", async () => {
  let attempt = 0;
  await verifyDnsEventually(async () => { if (++attempt === 1) throw new Error("DNS unavailable"); return ["192.0.2.20"]; }, "192.0.2.20", async () => {});
  expect(attempt).toBe(2);
});
test("bounds retries and refuses mixed local/cloud answers", async () => {
  let attempts = 0;
  await expect(verifyDnsEventually(async () => { attempts++; return ["192.0.2.20", "192.0.2.10"]; }, "192.0.2.20", async () => {})).rejects.toThrow("propagation window");
  expect(attempts).toBe(10);
});
