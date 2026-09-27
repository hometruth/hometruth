import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isSafeCameraUri } from "../../camera-media";

export type LutronZoneKind = "switched" | "dimmed";

export interface LutronZoneStatus {
  readonly level: number;
  readonly switchedOn?: boolean;
}

export class LutronLeapError extends Error {
  constructor(message: string, readonly code: "invalid_host" | "unreachable" | "protocol") {
    super(message);
    this.name = "LutronLeapError";
  }
}

interface LeapResponse {
  readonly Header?: { readonly ClientTag?: string; readonly StatusCode?: string };
  readonly Body?: Record<string, unknown>;
}

const LEAP_PORT = 8081;
const DEFAULT_CERTIFICATE_DIRECTORY = ".hometruth/lutron";

/** Small LEAP-over-mutual-TLS client for the local Caséta Smart Bridge. */
export class LutronLeapClient {
  constructor(
    private readonly certificateDirectory = DEFAULT_CERTIFICATE_DIRECTORY,
    private readonly timeoutMs = 5_000,
  ) {}

  async readZone(host: string, zone: number): Promise<LutronZoneStatus> {
    const response = await this.request(host, `/zone/${zone}/status`);
    const status = response.Body?.ZoneStatus;
    if (!isRecord(status)) throw new LutronLeapError("Lutron zone status was missing", "protocol");
    const level = typeof status.Level === "number" ? status.Level : undefined;
    const switchedLevel = typeof status.SwitchedLevel === "string" ? status.SwitchedLevel : undefined;
    if (level === undefined && switchedLevel === undefined) {
      throw new LutronLeapError("Lutron zone status did not include a level", "protocol");
    }
    if (level !== undefined && (!Number.isFinite(level) || level < 0 || level > 100)) {
      throw new LutronLeapError("Lutron zone status reported an invalid level", "protocol");
    }
    return {
      level: level ?? (switchedLevel === "On" ? 100 : 0),
      ...(switchedLevel !== undefined ? { switchedOn: switchedLevel === "On" } : {}),
    };
  }

  async setLevel(host: string, zone: number, kind: LutronZoneKind, level: number): Promise<void> {
    if (!Number.isFinite(level) || level < 0 || level > 100) {
      throw new LutronLeapError("Lutron level must be between 0 and 100", "protocol");
    }
    const command = kind === "dimmed"
      ? { CommandType: "GoToDimmedLevel", DimmedLevelParameters: { Level: level } }
      : { CommandType: "GoToLevel", Parameter: [{ Type: "Level", Value: level }] };
    await this.request(host, `/zone/${zone}/commandprocessor`, "CreateRequest", { Command: command });
  }

  private async request(host: string, url: string, communiqueType = "ReadRequest", body?: Record<string, unknown>): Promise<LeapResponse> {
    const normalizedHost = host.trim();
    if (!/^[A-Za-z0-9.-]+$/u.test(normalizedHost) || !isSafeCameraUri(`https://${normalizedHost}/`)) {
      throw new LutronLeapError("Lutron bridge host must be a private LAN address", "invalid_host");
    }
    if (!/^\/[-A-Za-z0-9_/]+$/u.test(url)) throw new LutronLeapError("Invalid Lutron LEAP resource", "protocol");

    let ca: string;
    let cert: string;
    let key: string;
    try {
      [ca, cert, key] = await Promise.all([
        readFile(join(this.certificateDirectory, "bridge.crt"), "utf8"),
        readFile(join(this.certificateDirectory, "client.crt"), "utf8"),
        readFile(join(this.certificateDirectory, "client.key"), "utf8"),
      ]);
    } catch {
      throw new LutronLeapError(`Lutron pairing certificates are missing in ${this.certificateDirectory}`, "protocol");
    }

    const tag = crypto.randomUUID();
    const payload = `${JSON.stringify({ CommuniqueType: communiqueType, Header: { ClientTag: tag, Url: url }, ...(body ? { Body: body } : {}) })}\r\n`;
    return await new Promise<LeapResponse>((resolve, reject) => {
      let settled = false;
      let buffer = "";
      let socket: { write(data: string): void; end(): void } | undefined;
      const finish = (result: { response: LeapResponse } | { error: LutronLeapError }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { socket?.end(); } catch { /* already closed */ }
        if ("response" in result) resolve(result.response);
        else reject(result.error);
      };
      const timer = setTimeout(() => finish({ error: new LutronLeapError(`Lutron bridge at ${normalizedHost} did not respond`, "unreachable") }), this.timeoutMs);
      const parse = (line: string) => {
        let response: LeapResponse;
        try { response = JSON.parse(line) as LeapResponse; } catch { return; }
        if (response.Header?.ClientTag !== tag) return;
        const status = response.Header.StatusCode ?? "";
        if (!status.startsWith("2")) {
          finish({ error: new LutronLeapError(`Lutron LEAP request ${url} failed: ${status || "unknown status"}`, "protocol") });
          return;
        }
        finish({ response });
      };
      void Bun.connect({
        hostname: normalizedHost,
        port: LEAP_PORT,
        tls: { ca, cert, key, serverName: "", rejectUnauthorized: true },
        socket: {
          open(connection) {
            socket = connection;
            connection.write(payload);
          },
          data(_connection, chunk) {
            buffer += new TextDecoder().decode(chunk);
            let newline = buffer.indexOf("\r\n");
            while (newline >= 0) {
              const line = buffer.slice(0, newline);
              buffer = buffer.slice(newline + 2);
              parse(line);
              newline = buffer.indexOf("\r\n");
            }
          },
          error(_connection, error) {
            finish({ error: new LutronLeapError(`Lutron bridge at ${normalizedHost} is unreachable: ${error.message}`, "unreachable") });
          },
          connectError(_connection, error) {
            finish({ error: new LutronLeapError(`Lutron bridge at ${normalizedHost} is unreachable: ${error.message}`, "unreachable") });
          },
          close() {
            if (!settled) finish({ error: new LutronLeapError(`Lutron bridge at ${normalizedHost} closed the connection`, "unreachable") });
          },
        },
      }).catch((error: unknown) => {
        finish({ error: new LutronLeapError(`Lutron bridge at ${normalizedHost} is unreachable: ${error instanceof Error ? error.message : String(error)}`, "unreachable") });
      });
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
