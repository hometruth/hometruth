import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selfSignedCertificate } from "./tls-cert";

describe("selfSignedCertificate", () => {
  test("makes a PEM pair that Bun can serve for every hostname, and reuses it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tls-"));
    const first = await selfSignedCertificate(["apis-us-west.cloudedge360.com", "Meari-OSS-US.oss-us-west-1.aliyuncs.com"], directory);
    expect(first.hostnames).toEqual(["apis-us-west.cloudedge360.com", "meari-oss-us.oss-us-west-1.aliyuncs.com"]);
    expect(first.cert).toContain("BEGIN CERTIFICATE");
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { key: first.key, cert: first.cert }, fetch: (request) => new Response(request.headers.get("host") ?? "") });
    try {
      const response = await fetch(`https://127.0.0.1:${server.port}/`, { headers: { host: "apis-us-west.cloudedge360.com" }, tls: { rejectUnauthorized: false } } as RequestInit);
      expect(await response.text()).toBe("apis-us-west.cloudedge360.com");
    } finally {
      server.stop(true);
    }
    const again = await selfSignedCertificate(["meari-oss-us.oss-us-west-1.aliyuncs.com", "apis-us-west.cloudedge360.com"], directory);
    expect(again.cert).toBe(first.cert);
  });

  test("refuses hostnames that could reach the shell", async () => {
    await expect(selfSignedCertificate(["bad host;rm"], await mkdtemp(join(tmpdir(), "tls-")))).rejects.toThrow(/oddly formed/u);
  });
});
