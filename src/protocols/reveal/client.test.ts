import { describe, expect, test } from "bun:test";
import { REVEAL_API, REVEAL_AUTH, REVEAL_CLIENT_ID, RevealClient, revealPhotoUrl } from "./client";
import { authResponse, credentials, imageResponse, jpeg, photoResponse, samplePhoto } from "./test-fixtures";

describe("REVEAL cloud client", () => {
  test("explicit all mode traverses beyond the default cap until the server ends the feed", async () => {
    let pages = 0;
    const client = new RevealClient(credentials, { fetch: async url => {
      if (url.href === REVEAL_AUTH) return authResponse();
      pages++;
      return pages < 105 ? photoResponse([], String(pages)) : photoResponse([samplePhoto]);
    } });
    const saved = [];
    for await (const photo of client.photos("camera-1", "all")) saved.push(photo.photoId);
    expect(pages).toBe(105);
    expect(saved).toEqual([samplePhoto.photoId]);
  });
  test("uses the web app's login, access-token headers, camera filter and pagination", async () => {
    const calls: { url: URL; init: RequestInit }[] = [];
    const client = new RevealClient(credentials, { fetch: async (url, init = {}) => {
      calls.push({ url, init });
      if (url.href === REVEAL_AUTH) return authResponse();
      if (url.pathname.endsWith("/cameras")) return Response.json({ response: { cameras: [{ cameraId: "camera-1", name: "Woods", secret: "omit" }] } });
      return photoResponse([samplePhoto], "next+/=");
    } });
    const [cameras, page] = await Promise.all([client.listCameras(), client.listPhotos({ cameraId: "camera-1", size: 10, paginationKey: "opaque+/=" })]);
    expect(cameras).toEqual([{ cameraId: "camera-1", name: "Woods" }]);
    expect(page.nextToken).toBe("next+/=");
    expect(calls.filter(c => c.url.href === REVEAL_AUTH)).toHaveLength(1);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ ClientId: REVEAL_CLIENT_ID, AuthFlow: "USER_PASSWORD_AUTH", AuthParameters: { USERNAME: credentials.email, PASSWORD: credentials.password } });
    const api = calls.find(c => c.url.pathname.endsWith("/photos/v2"))!;
    expect(api.url.origin + "/v1/").toBe(REVEAL_API);
    expect(Object.fromEntries(api.url.searchParams)).toEqual({ cameraIds: "camera-1", size: "10", paginationKey: "opaque+/=" });
    const headers = new Headers(api.init.headers);
    expect(headers.get("Authorization")).toBe("Bearer test-access");
    expect(headers.get("Reveal-User-Agent")).toBe("RevealWeb/5.10.0");
    expect(api.init.redirect).toBe("error");
  });

  test("refreshes expired tokens, and falls back to login if the refresh session expired", async () => {
    let now = 0;
    const flows: string[] = [];
    const client = new RevealClient(credentials, { now: () => now, fetch: async (url, init) => {
      if (url.href !== REVEAL_AUTH) return photoResponse();
      const body = JSON.parse(init!.body as string);
      flows.push(body.AuthFlow);
      if (flows.length === 2) {
        expect(body.AuthParameters).toEqual({ REFRESH_TOKEN: "test-refresh" });
        return Response.json({ __type: "NotAuthorizedException", message: "private" }, { status: 400 });
      }
      return authResponse();
    } });
    await client.listPhotos({ cameraId: "camera-1" });
    now = 3_600_000;
    await client.listPhotos({ cameraId: "camera-1" });
    expect(flows).toEqual(["USER_PASSWORD_AUTH", "REFRESH_TOKEN_AUTH", "USER_PASSWORD_AUTH"]);
  });

  test("retries an unauthorized API request only once with a renewed access token", async () => {
    let auth = 0;
    let reads = 0;
    const client = new RevealClient(credentials, { fetch: async url => {
      if (url.href === REVEAL_AUTH) return authResponse(`token-${++auth}`);
      reads++;
      return new Response(null, { status: 401 });
    } });
    await expect(client.listPhotos({ cameraId: "camera-1" })).rejects.toMatchObject({ code: "authentication" });
    expect(auth).toBe(2);
    expect(reads).toBe(2);
  });

  test("reports interactive challenges and redacts upstream authentication messages", async () => {
    const challenged = new RevealClient(credentials, { fetch: async () => Response.json({ ChallengeName: "SOFTWARE_TOKEN_MFA", Session: "secret-session" }) });
    await expect(challenged.listCameras()).rejects.toMatchObject({ code: "challenge" });
    const failed = new RevealClient(credentials, { fetch: async () => Response.json({ message: credentials.password }, { status: 400 }) });
    await expect(failed.listCameras()).rejects.toThrow("REVEAL login failed");
    const network = new RevealClient(credentials, { fetch: async () => { throw new Error(samplePhoto.photoUrl); } });
    await expect(network.listCameras()).rejects.toThrow("REVEAL cloud request failed or timed out");
  });

  test("paginates, deduplicates overlapping pages, and follows empty pages with a cursor", async () => {
    const cursors: (string | null)[] = [];
    const client = new RevealClient(credentials, { fetch: async url => {
      if (url.href === REVEAL_AUTH) return authResponse();
      const cursor = url.searchParams.get("paginationKey");
      cursors.push(cursor);
      if (cursor === null) return photoResponse([samplePhoto], "second");
      if (cursor === "second") return photoResponse([], "third");
      return photoResponse([samplePhoto, { ...samplePhoto, photoId: "photo-2" }]);
    } });
    const ids: string[] = [];
    for await (const photo of client.photos("camera-1")) ids.push(photo.photoId);
    expect(ids).toEqual(["photo-1", "photo-2"]);
    expect(cursors).toEqual([null, "second", "third"]);
  });

  test("does not silently truncate on a repeated cursor or page limit", async () => {
    const client = new RevealClient(credentials, { fetch: async url => url.href === REVEAL_AUTH ? authResponse() : photoResponse([], "repeat") });
    const collect = async (maxPages: number) => { for await (const _photo of client.photos("camera-1", maxPages)) {} };
    await expect(collect(10)).rejects.toThrow("repeated a pagination token");
    await expect(collect(1)).rejects.toThrow("reached its page limit");
  });

  test("rejects malformed payloads, cross-camera photos and rate limits without extra requests", async () => {
    for (const response of [
      () => Response.json({ response: {} }),
      () => photoResponse([{ ...samplePhoto, cameraId: "another-camera" }]),
      () => Response.json({ success: false, response: { photos: [] } }),
      () => new Response("not json"),
      () => new Response(null, { status: 429 }),
    ]) {
      let reads = 0;
      const client = new RevealClient(credentials, { fetch: async url => {
        if (url.href === REVEAL_AUTH) return authResponse();
        reads++; return response();
      } });
      await expect(client.listPhotos({ cameraId: "camera-1" })).rejects.toThrow();
      expect(reads).toBe(1);
    }
  });

  test("downloads JPEG bytes without account headers, renewing an expired signed URL once", async () => {
    let media = 0;
    const client = new RevealClient(credentials, { fetch: async (url, init) => {
      if (url.href === REVEAL_AUTH) return authResponse();
      if (url.href.startsWith(REVEAL_API)) return Response.json({ response: { photo: { ...samplePhoto, photoUrl: samplePhoto.photoUrl.replace("private-example", "renewed") } } });
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      expect(init?.redirect).toBe("error");
      media++;
      if (media === 1) return new Response(null, { status: 403 });
      expect(url.searchParams.get("X-Amz-Signature")).toBe("renewed");
      return imageResponse();
    } });
    expect(await client.downloadPhoto(samplePhoto)).toEqual(jpeg);
    expect(media).toBe(2);
  });

  test("blocks non-vendor URLs, content masquerading as an image, and oversized bodies", async () => {
    for (const url of ["http://revealcellcam.com/a", "https://127.0.0.1/a", "https://revealcellcam.com.evil.test/a", "https://user:pass@revealcellcam.com/a", "https://example.com/a"]) {
      expect(() => revealPhotoUrl(url)).toThrow();
    }
    for (const response of [
      () => new Response("<html>login</html>", { headers: { "Content-Type": "text/html" } }),
      () => new Response("not JPEG", { headers: { "Content-Type": "image/jpeg" } }),
      () => new Response(new Uint8Array(20 * 1024 * 1024 + 1)),
    ]) {
      const client = new RevealClient(credentials, { fetch: async () => response() });
      await expect(client.downloadPhoto(samplePhoto)).rejects.toMatchObject({ code: "protocol" });
    }
  });
});
