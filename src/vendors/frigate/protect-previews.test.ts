import { expect, test } from "bun:test";
import { createProtectPreviews, protectPreviewConfig } from "./protect-previews";
import { PreviewAccessError } from "./previews";

const config = protectPreviewConfig({ baseUrl: "https://recorder.test", skipTlsVerify: true }, { front: "a".repeat(24) }, "viewer", "private-password")!;
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]);
const signal = () => new AbortController().signal;

test("Protect previews require explicit local credentials and a credential-free HTTPS origin", () => {
  expect(protectPreviewConfig({ baseUrl: "https://recorder.test" }, {}, undefined, undefined)).toBeUndefined();
  for (const baseUrl of ["http://recorder.test", "https://user:password@recorder.test", "https://recorder.test/path", "https://recorder.test?token=secret"]) {
    expect(() => protectPreviewConfig({ baseUrl }, {}, "viewer", "password")).toThrow();
  }
  expect(() => protectPreviewConfig({ baseUrl: "https://recorder.test" }, { front: "../other" }, "viewer", "password")).toThrow();
});

test("Protect login stays private and timed reads use the established camera mapping", async () => {
  const paths: string[] = []; let logins = 0;
  const reader = createProtectPreviews(config, (async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://recorder.test"); expect(init!.redirect).toBe("error");
    if (url.pathname === "/api/auth/login") {
      logins++; expect(init!.method).toBe("POST");
      expect(JSON.parse(init!.body as string)).toEqual({ username: "viewer", password: "private-password", rememberMe: false });
      return new Response("{}", { headers: { "set-cookie": "TOKEN=private-cookie; HttpOnly; Secure", "x-csrf-token": "private-csrf" } });
    }
    paths.push(url.pathname + url.search);
    expect(new Headers(init!.headers).get("cookie")).toBe("TOKEN=private-cookie");
    expect(new Headers(init!.headers).get("x-csrf-token")).toBe("private-csrf");
    return new Response(jpeg, { headers: { "content-type": "image/jpeg" } });
  }));
  const value = await reader.read("front", 100, signal());
  expect(logins).toBe(1); expect(paths.length).toBe(10);
  expect(paths[0]).toBe(`/proxy/protect/api/cameras/${"a".repeat(24)}/recording-snapshot?ts=98000&w=480`);
  expect(JSON.stringify(value)).not.toContain("private");
  expect(await reader.read("unmapped", 100, signal())).toBeUndefined(); expect(paths.length).toBe(10);
});

test("rejected logins cool down instead of retrying for every frame and event", async () => {
  let attempts = 0;
  const reader = createProtectPreviews(config, async () => { attempts++; return new Response(null, { status: 401 }); });
  await expect(reader.read("front", 100, signal())).rejects.toBeInstanceOf(PreviewAccessError);
  await expect(reader.read("front", 120, signal())).rejects.toBeInstanceOf(PreviewAccessError);
  expect(attempts).toBe(1);
});

test("expired recordings are missing and an oversized or non-JPEG response is rejected", async () => {
  for (const mode of ["missing", "large", "html", "forbidden"]) {
    const reader = createProtectPreviews(config, (async input => {
      if (new URL(String(input)).pathname === "/api/auth/login") return new Response(null, { headers: { "set-cookie": "TOKEN=private" } });
      if (mode === "missing") return new Response(null, { status: 404 });
      if (mode === "forbidden") return new Response(null, { status: 403 });
      return new Response(mode === "large" ? new Uint8Array(256 * 1024 + 1) : "html", { headers: { "content-type": mode === "large" ? "image/jpeg" : "text/html" } });
    }));
    if (mode === "missing") expect(await reader.read("front", 100, signal())).toBeUndefined();
    else await expect(reader.read("front", 100, signal())).rejects.toThrow();
  }
});
