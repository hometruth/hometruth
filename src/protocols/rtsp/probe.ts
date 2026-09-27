/**
 * A minimal RTSP liveness probe: one `OPTIONS` request over TCP, no media.
 *
 * Every local route to a fixed camera ends in an RTSP server (the vendor's,
 * wz_mini's, Thingino's), and `OPTIONS` is the one request all of them answer
 * without a session. A `401` is still "the server is there"; only a refused
 * connection, a timeout, or a non-RTSP reply means the camera is not
 * reachable. No credentials are ever sent by this probe.
 */
import { isSafeCameraUri } from "../../camera-media";

export interface RtspProbeOptions {
  /** A private LAN address or `.local` name. Public hosts are rejected. */
  readonly host: string;
  readonly port: number;
  /** Request path (`/ch0`); only echoed in the request line. */
  readonly path?: string;
  readonly timeoutMs?: number;
}

export interface RtspProbeResult {
  readonly statusCode: number;
  /** The `Server` header when the firmware sends one (`prudynt-t`, `LIVE555`, …). */
  readonly server?: string;
  /** Methods listed in the `Public` header. */
  readonly methods: readonly string[];
  /** True when the server answered `401`: reachable, credentials needed for media. */
  readonly authRequired: boolean;
}

export type RtspProbeErrorCode = "invalid_host" | "unreachable" | "timeout" | "protocol";

export class RtspProbeError extends Error {
  constructor(message: string, readonly code: RtspProbeErrorCode) {
    super(message);
    this.name = "RtspProbeError";
  }
}

/** The shape of `rtspOptions`, so a product can take a fake in tests. */
export type RtspProbe = (options: RtspProbeOptions) => Promise<RtspProbeResult>;

const MAX_REPLY_BYTES = 16 * 1024;

/** Parse one RTSP reply head (status line plus headers), ignoring any body. */
export function parseRtspReply(text: string): RtspProbeResult {
  const head = text.split("\r\n\r\n")[0] ?? "";
  const [statusLine = "", ...headerLines] = head.split("\r\n");
  const match = /^RTSP\/1\.[01] (\d{3})/u.exec(statusLine);
  if (!match) throw new RtspProbeError("The reply was not RTSP", "protocol");
  const statusCode = Number(match[1]);
  const headers = new Map<string, string>();
  for (const line of headerLines) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }
  const methods = (headers.get("public") ?? "")
    .split(",")
    .map((method) => method.trim().toUpperCase())
    .filter((method) => method.length > 0);
  const server = headers.get("server");
  return {
    statusCode,
    ...(server ? { server } : {}),
    methods,
    authRequired: statusCode === 401,
  };
}

/** Send `OPTIONS` and parse the reply. Rejects with `RtspProbeError` for anything but an RTSP answer. */
export async function rtspOptions(options: RtspProbeOptions): Promise<RtspProbeResult> {
  const host = options.host.trim();
  const port = options.port;
  if (!/^[A-Za-z0-9.-]+$/u.test(host) || !isSafeCameraUri(`rtsp://${host}:${port}/`)) {
    throw new RtspProbeError("RTSP probe host must be a private LAN address", "invalid_host");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RtspProbeError("RTSP probe port must be 1..65535", "invalid_host");
  }
  const path = options.path ?? "/";
  const timeoutMs = options.timeoutMs ?? 3_000;
  const request = `OPTIONS rtsp://${host}:${port}${path.startsWith("/") ? path : `/${path}`} RTSP/1.0\r\nCSeq: 1\r\nUser-Agent: HomeTruth\r\n\r\n`;

  return await new Promise<RtspProbeResult>((resolve, reject) => {
    let settled = false;
    let received = "";
    let socket: { end(): void } | undefined;
    const finish = (outcome: { result: RtspProbeResult } | { error: RtspProbeError }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.end();
      if ("result" in outcome) resolve(outcome.result);
      else reject(outcome.error);
    };
    const timer = setTimeout(() => finish({ error: new RtspProbeError(`No RTSP answer from ${host}:${port} within ${timeoutMs} ms`, "timeout") }), timeoutMs);

    Bun.connect({
      hostname: host,
      port,
      socket: {
        open(connection) {
          socket = connection;
          connection.write(request);
        },
        data(_connection, chunk) {
          received += new TextDecoder().decode(chunk);
          if (received.includes("\r\n\r\n")) {
            try {
              finish({ result: parseRtspReply(received) });
            } catch (error) {
              finish({ error: error instanceof RtspProbeError ? error : new RtspProbeError(String(error), "protocol") });
            }
          } else if (received.length > MAX_REPLY_BYTES) {
            finish({ error: new RtspProbeError("The reply was not RTSP", "protocol") });
          }
        },
        error(_connection, error) {
          finish({ error: new RtspProbeError(`RTSP probe of ${host}:${port} failed: ${error.message}`, "unreachable") });
        },
        connectError(_connection, error) {
          finish({ error: new RtspProbeError(`${host}:${port} refused the RTSP probe: ${error.message}`, "unreachable") });
        },
        close() {
          finish({ error: new RtspProbeError(`${host}:${port} closed the connection before answering`, "protocol") });
        },
      },
    }).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      finish({ error: new RtspProbeError(`${host}:${port} is unreachable: ${detail}`, "unreachable") });
    });
  });
}
