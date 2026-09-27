/**
 * Thingino web API for the 2026 web UI generation, including the
 * ciao+2c3eca5 endpoint shapes. See docs/WYZE.md for firmware requirements.
 *
 * Three surfaces, all unlocked by the camera's per-device web API key
 * (Settings → Web UI → "API key for automation and integrations"):
 *
 * - `GET /x/json-heartbeat-slow.cgi?token=…` — one JSON snapshot of the
 *   camera's switches (day/night, IR cut, IR LEDs, colour mode, privacy,
 *   mic/speaker, recording, motion). `/x/json-heartbeat.cgi` is the
 *   server-sent-events stream the UI uses; this module only takes snapshots.
 * - `POST /x/json-imp.cgi?token=…` with `{ cmd, val }` — the imaging
 *   switches (`ir850`, `ir940`, `ircut`, `white`, `color`, `auto`,
 *   `daynight`). The CGI layer only honours the token in the query string.
 * - `POST http://host:8080/api/v1/config` with header `X-API-Key` — prudynt's
 *   own config API: `{ privacy: { enabled } }`, `{ audio: { mic_enabled,
 *   spk_enabled } }`, `{ motion: { enabled } }`. A `null` value reads.
 *
 * No device knowledge here beyond the endpoint shapes; the Wyze product maps
 * them to controls.
 */
import { isSafeCameraUri } from "../../camera-media";

export type ThinginoFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface ThinginoWebApiOptions {
  /** A private LAN address or `.local` name. */
  readonly host: string;
  readonly apiKey: string;
  readonly timeoutMs?: number;
  readonly fetch?: ThinginoFetch;
  /** prudynt's config API port; 8080 on every build seen so far. */
  readonly streamerPort?: number;
}

export type ThinginoErrorCode = "invalid_host" | "unauthorized" | "unreachable" | "protocol";

export class ThinginoError extends Error {
  constructor(message: string, readonly code: ThinginoErrorCode) {
    super(message);
    this.name = "ThinginoError";
  }
}

export type ThinginoDayNightMode = "day" | "night";

/** The camera's switches as the slow heartbeat reports them. Unknown fields are kept in `raw`. */
export interface ThinginoHeartbeat {
  readonly uptimeSeconds?: number;
  readonly dayNightMode?: ThinginoDayNightMode;
  /** Automatic day/night switching by sensor gain. */
  readonly dayNightAuto?: boolean;
  readonly irCut?: boolean;
  readonly ir850?: boolean;
  readonly ir940?: boolean;
  readonly whiteLight?: boolean;
  /** prudynt's ISP mode: true = black and white, false = colour. */
  readonly monochrome?: boolean;
  readonly privacy?: boolean;
  readonly microphone?: boolean;
  readonly speaker?: boolean;
  readonly motionDetection?: boolean;
  readonly recordingMain?: boolean;
  readonly recordingSub?: boolean;
  readonly raw: Readonly<Record<string, unknown>>;
}

/** `cmd` values `json-imp.cgi` accepts, from the web UI's toggle map. */
export type ThinginoImpSwitch = "ir850" | "ir940" | "ircut" | "white" | "color" | "auto";
export const THINGINO_IMP_SWITCHES: readonly ThinginoImpSwitch[] = ["ir850", "ir940", "ircut", "white", "color", "auto"];

function flag(value: unknown): boolean | undefined {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return undefined;
}

/** The marker `request()` returns for a 2xx whose body was not JSON. */
function isBareText(body: unknown): body is { text: string } {
  return typeof body === "object" && body !== null && Object.keys(body).length === 1 && typeof (body as { text?: unknown }).text === "string";
}

function defined(object: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

/** Decode one slow-heartbeat document. Tolerates missing fields; rejects non-objects. */
export function parseHeartbeat(body: unknown): ThinginoHeartbeat {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ThinginoError("The heartbeat was not a JSON object", "protocol");
  }
  const raw = body as Record<string, unknown>;
  const mode = raw.daynight_mode;
  return defined({
    uptimeSeconds: typeof raw.uptime === "number" ? raw.uptime : undefined,
    dayNightMode: mode === "day" || mode === "night" ? mode : undefined,
    dayNightAuto: flag(raw.daynight_enabled),
    irCut: flag(raw.ircut_state),
    ir850: flag(raw.ir850_state),
    ir940: flag(raw.ir940_state),
    whiteLight: flag(raw.white_state),
    monochrome: flag(raw.color_mode),
    privacy: flag(raw.privacy_enabled),
    microphone: flag(raw.mic_enabled),
    speaker: flag(raw.spk_enabled),
    motionDetection: flag(raw.motion_enabled),
    recordingMain: flag(raw.rec_ch0),
    recordingSub: flag(raw.rec_ch1),
    raw,
  }) as unknown as ThinginoHeartbeat;
}

export class ThinginoWebApi {
  readonly host: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: ThinginoFetch;
  private readonly streamerPort: number;

  constructor(options: ThinginoWebApiOptions) {
    const host = options.host.trim();
    if (!/^[A-Za-z0-9.-]+$/u.test(host) || !isSafeCameraUri(`http://${host}/`)) {
      throw new ThinginoError("Thingino host must be a private LAN address", "invalid_host");
    }
    if (!options.apiKey) throw new ThinginoError("Thingino web API key is required", "unauthorized");
    this.host = host;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.streamerPort = options.streamerPort ?? 8080;
  }

  /** One snapshot of every switch the UI shows. */
  async heartbeat(): Promise<ThinginoHeartbeat> {
    const body = await this.request(`http://${this.host}/x/json-heartbeat-slow.cgi?token=${encodeURIComponent(this.apiKey)}`, { method: "GET" });
    if (isBareText(body)) throw new ThinginoError(`${this.host} returned a non-JSON heartbeat`, "protocol");
    return parseHeartbeat(body);
  }

  /** Flip one imaging switch. `auto` enables automatic day/night; `color` true means black-and-white (prudynt's ISP mode 1). */
  async setSwitch(command: ThinginoImpSwitch, on: boolean): Promise<void> {
    await this.imp(command, on ? 1 : 0);
  }

  /** Force day or night mode (also clears automatic switching on the camera side). */
  async setDayNight(mode: ThinginoDayNightMode): Promise<void> {
    await this.imp("daynight", mode);
  }

  private async imp(cmd: string, val: number | string): Promise<void> {
    const body = await this.request(`http://${this.host}/x/json-imp.cgi?token=${encodeURIComponent(this.apiKey)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cmd, val }),
    });
    // The CGI answers `{"code":200,"result":"success"}`; a 2xx with an empty
    // or non-JSON body (seen once for `daynight`) is still an accepted command.
    const result = typeof body === "object" && body !== null ? body as { result?: unknown; code?: unknown } : undefined;
    if (result && result.result !== undefined && result.result !== "success" && result.code !== 200) {
      throw new ThinginoError(`json-imp ${cmd} was not accepted: ${JSON.stringify(body).slice(0, 200)}`, "protocol");
    }
  }

  /** prudynt config: `{ privacy: { enabled: true } }` writes, `{ privacy: { enabled: null } }` reads. Returns the echoed document. */
  async streamerConfig(patch: Record<string, Record<string, unknown>>): Promise<Record<string, unknown>> {
    const body = await this.request(`http://${this.host}:${this.streamerPort}/api/v1/config`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-API-Key": this.apiKey },
      body: JSON.stringify(patch),
    });
    if (typeof body !== "object" || body === null || Array.isArray(body) || isBareText(body)) throw new ThinginoError("prudynt did not return a JSON object", "protocol");
    return body as Record<string, unknown>;
  }

  setPrivacy(enabled: boolean): Promise<Record<string, unknown>> {
    return this.streamerConfig({ privacy: { enabled } });
  }

  setAudio(device: "microphone" | "speaker", enabled: boolean): Promise<Record<string, unknown>> {
    return this.streamerConfig({ audio: { [device === "microphone" ? "mic_enabled" : "spk_enabled"]: enabled } });
  }

  setMotionDetection(enabled: boolean): Promise<Record<string, unknown>> {
    return this.streamerConfig({ motion: { enabled } });
  }

  private async request(url: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ThinginoError(`${this.host} did not answer: ${detail}`, "unreachable");
    }
    if (response.status === 401 || response.status === 403) {
      throw new ThinginoError(`${this.host} rejected the web API key`, "unauthorized");
    }
    const text = await response.text();
    if (!response.ok) throw new ThinginoError(`${this.host} answered HTTP ${response.status}: ${text.slice(0, 200)}`, "protocol");
    if (!text.trim()) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // Shell-script CGIs occasionally answer 200 with a bare word; callers that need JSON check the shape.
      return { text };
    }
  }
}
