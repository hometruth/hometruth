import { afterEach, describe, expect, test } from "bun:test";
import { RtspProbeError, parseRtspReply, rtspOptions } from "./probe";

type Server = { readonly port: number; stop(closeActiveConnections?: boolean): void };
const servers: Server[] = [];

function listen(reply: string | undefined): Server {
  const server: Server = Bun.listen<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, chunk) {
        const request = new TextDecoder().decode(chunk);
        if (!request.startsWith("OPTIONS rtsp://")) {
          socket.end();
          return;
        }
        if (reply !== undefined) socket.write(reply);
      },
    },
  });
  servers.push(server);
  return server;
}

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe("parseRtspReply", () => {
  test("reads the status, server, and public methods from a prudynt-style reply", () => {
    const result = parseRtspReply("RTSP/1.0 200 OK\r\nCSeq: 1\r\nServer: prudynt-t\r\nPublic: OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN\r\n\r\n");
    expect(result).toEqual({ statusCode: 200, server: "prudynt-t", methods: ["OPTIONS", "DESCRIBE", "SETUP", "PLAY", "TEARDOWN"], authRequired: false });
  });

  test("treats 401 as reachable with credentials required", () => {
    const result = parseRtspReply('RTSP/1.0 401 Unauthorized\r\nCSeq: 1\r\nWWW-Authenticate: Digest realm="wyze", nonce="abc"\r\n\r\n');
    expect(result.authRequired).toBe(true);
    expect(result.statusCode).toBe(401);
    expect(result.methods).toEqual([]);
  });

  test("rejects a non-RTSP reply", () => {
    expect(() => parseRtspReply("HTTP/1.1 200 OK\r\n\r\n")).toThrow(RtspProbeError);
  });
});

describe("rtspOptions", () => {
  test("sends OPTIONS and parses the answer", async () => {
    const server = listen("RTSP/1.0 200 OK\r\nCSeq: 1\r\nServer: fake-rtsp\r\nPublic: OPTIONS, DESCRIBE\r\n\r\n");
    const result = await rtspOptions({ host: "127.0.0.1", port: server.port, path: "/ch0", timeoutMs: 1_000 });
    expect(result).toEqual({ statusCode: 200, server: "fake-rtsp", methods: ["OPTIONS", "DESCRIBE"], authRequired: false });
  });

  test("times out when the server never answers", async () => {
    const server = listen(undefined);
    await expect(rtspOptions({ host: "127.0.0.1", port: server.port, timeoutMs: 150 })).rejects.toMatchObject({ code: "timeout" });
  });

  test("reports a refused connection as unreachable", async () => {
    const server = listen(undefined);
    const port = server.port;
    server.stop(true);
    servers.pop();
    await expect(rtspOptions({ host: "127.0.0.1", port, timeoutMs: 1_000 })).rejects.toMatchObject({ code: "unreachable" });
  });

  test("refuses public hosts before opening a socket", async () => {
    await expect(rtspOptions({ host: "8.8.8.8", port: 554 })).rejects.toMatchObject({ code: "invalid_host" });
    await expect(rtspOptions({ host: "10.77.0.5", port: 0 })).rejects.toMatchObject({ code: "invalid_host" });
  });
});
