import { expect, test } from "bun:test";
import { listenerConfig, parsePublicOrigin, publicRequestUrl } from "./listener-config";

test("loopback stays loopback; exposing a listener requires an explicit bind", () => {
  expect(listenerConfig({}).hostname).toBe("127.0.0.1");
  expect(listenerConfig({ HOST: "127.0.0.1" }).hostname).toBe("127.0.0.1");
  expect(listenerConfig({ HOST: "0.0.0.0", PORT: "8080" })).toMatchObject({ hostname: "0.0.0.0", port: 8080 });
  expect(() => listenerConfig({ PORT: "65536" })).toThrow();
});

test("public origin accepts only an origin and never echoes invalid credentials", () => {
  expect(parsePublicOrigin("https://control.example.test/")).toBe("https://control.example.test");
  for (const value of ["", "ftp://example.test", "https://user:test-secret@example.test", "https://example.test/path", "https://example.test?x=1", "https://example.test#fragment"]) {
    expect(() => parsePublicOrigin(value)).toThrow("HOMETRUTH_PUBLIC_ORIGIN must be");
  }
});

test("proxy requests retain path and query under the fixed public origin", () => {
  expect(publicRequestUrl("http://127.0.0.1:3000/api/devices?after=a%2Fb", "https://control.example.test"))
    .toBe("https://control.example.test/api/devices?after=a%2Fb");
  expect(publicRequestUrl("http://untrusted.test//attacker.test/path", "https://control.example.test"))
    .toBe("https://control.example.test//attacker.test/path");
  expect(publicRequestUrl("http://localhost:3000/", undefined)).toBe("http://localhost:3000/");
});
