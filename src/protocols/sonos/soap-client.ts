/**
 * Dependency-free client for Sonos's local UPnP/SOAP control API. Unlike
 * ONVIF, this is unauthenticated plain HTTP on port 1400 — no WS-Security,
 * no HTTP auth challenge, no endpoint discovery beyond a fixed set of
 * per-service control paths every Sonos player exposes.
 */
import { isSafeCameraUri } from "../../camera-media";

const AVT_SERVICE = "urn:schemas-upnp-org:service:AVTransport:1";
const RC_SERVICE = "urn:schemas-upnp-org:service:RenderingControl:1";
const ZGT_SERVICE = "urn:schemas-upnp-org:service:ZoneGroupTopology:1";
const AVT_CONTROL_PATH = "/MediaRenderer/AVTransport/Control";
const RC_CONTROL_PATH = "/MediaRenderer/RenderingControl/Control";
const ZGT_CONTROL_PATH = "/ZoneGroupTopology/Control";
const DEFAULT_PORT = 1400;
const MAX_TIMEOUT_MS = 30_000;

export type SonosFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface SonosSoapClientConfig {
  readonly host: string;
  readonly port?: number;
  readonly timeoutMs?: number;
  readonly fetch?: SonosFetch;
}

export type SonosSoapErrorCode = "invalid_host" | "unreachable" | "fault";

export class SonosSoapError extends Error {
  constructor(message: string, readonly code: SonosSoapErrorCode) {
    super(message);
    this.name = "SonosSoapError";
  }
}

export interface SonosTransportInfo {
  readonly state: string;
  readonly status: string;
}

export interface SonosPositionInfo {
  readonly track: number;
  readonly duration: string;
  readonly relTime: string;
  readonly uri?: string;
  readonly metadataXml?: string;
}

export interface SonosMediaInfo {
  readonly currentUri?: string;
  readonly currentUriMetadataXml?: string;
}

export interface SonosZoneGroupMember {
  readonly uuid: string;
  readonly host?: string;
}

export interface SonosZoneGroup {
  readonly coordinatorUuid: string;
  readonly members: readonly SonosZoneGroupMember[];
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function tagValue(xml: string, localName: string): string | undefined {
  const escaped = localName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${escaped}\\s*>`, "iu").exec(xml);
  if (match === null) return undefined;
  const value = decodeXml((match[1] ?? "").trim());
  return value || undefined;
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A minimal, unauthenticated UPnP/SOAP client for one Sonos player's local control API. */
export class SonosSoapClient {
  readonly host: string;
  private readonly port: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: SonosFetch;

  constructor(config: SonosSoapClientConfig) {
    const host = config.host.trim();
    const port = config.port ?? DEFAULT_PORT;
    if (!/^[A-Za-z0-9.-]+$/u.test(host) || !isSafeCameraUri(`http://${host}:${port}/`)) {
      throw new SonosSoapError("Sonos speaker host must be a private LAN address", "invalid_host");
    }
    this.host = host;
    this.port = port;
    this.timeoutMs = Math.max(100, Math.min(MAX_TIMEOUT_MS, Math.floor(config.timeoutMs ?? 5_000)));
    this.fetchImpl = config.fetch ?? fetch;
  }

  async play(): Promise<void> {
    await this.soapRequest(AVT_CONTROL_PATH, AVT_SERVICE, "Play", "<InstanceID>0</InstanceID><Speed>1</Speed>");
  }

  async pause(): Promise<void> {
    await this.soapRequest(AVT_CONTROL_PATH, AVT_SERVICE, "Pause", "<InstanceID>0</InstanceID>");
  }

  async stop(): Promise<void> {
    await this.soapRequest(AVT_CONTROL_PATH, AVT_SERVICE, "Stop", "<InstanceID>0</InstanceID>");
  }

  async setAvTransportUri(uri: string, metadataXml = ""): Promise<void> {
    await this.soapRequest(
      AVT_CONTROL_PATH,
      AVT_SERVICE,
      "SetAVTransportURI",
      `<InstanceID>0</InstanceID><CurrentURI>${escapeXml(uri)}</CurrentURI><CurrentURIMetaData>${escapeXml(metadataXml)}</CurrentURIMetaData>`,
    );
  }

  async becomeCoordinatorOfStandaloneGroup(): Promise<void> {
    await this.soapRequest(AVT_CONTROL_PATH, AVT_SERVICE, "BecomeCoordinatorOfStandaloneGroup", "<InstanceID>0</InstanceID>");
  }

  async getTransportInfo(): Promise<SonosTransportInfo> {
    const xml = await this.soapRequest(AVT_CONTROL_PATH, AVT_SERVICE, "GetTransportInfo", "<InstanceID>0</InstanceID>");
    return {
      state: tagValue(xml, "CurrentTransportState") ?? "unknown",
      status: tagValue(xml, "CurrentTransportStatus") ?? "unknown",
    };
  }

  async getPositionInfo(): Promise<SonosPositionInfo> {
    const xml = await this.soapRequest(AVT_CONTROL_PATH, AVT_SERVICE, "GetPositionInfo", "<InstanceID>0</InstanceID>");
    const track = Number(tagValue(xml, "Track") ?? "0");
    const uri = tagValue(xml, "TrackURI");
    const metadataXml = tagValue(xml, "TrackMetaData");
    return {
      track: Number.isFinite(track) ? track : 0,
      duration: tagValue(xml, "TrackDuration") ?? "0:00:00",
      relTime: tagValue(xml, "RelTime") ?? "0:00:00",
      ...(uri ? { uri } : {}),
      ...(metadataXml ? { metadataXml } : {}),
    };
  }

  async getMediaInfo(): Promise<SonosMediaInfo> {
    const xml = await this.soapRequest(AVT_CONTROL_PATH, AVT_SERVICE, "GetMediaInfo", "<InstanceID>0</InstanceID>");
    const currentUri = tagValue(xml, "CurrentURI");
    const currentUriMetadataXml = tagValue(xml, "CurrentURIMetaData");
    return {
      ...(currentUri ? { currentUri } : {}),
      ...(currentUriMetadataXml ? { currentUriMetadataXml } : {}),
    };
  }

  async getVolume(channel: "Master" = "Master"): Promise<number> {
    const xml = await this.soapRequest(RC_CONTROL_PATH, RC_SERVICE, "GetVolume", `<InstanceID>0</InstanceID><Channel>${channel}</Channel>`);
    const value = Number(tagValue(xml, "CurrentVolume") ?? "0");
    return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
  }

  async setVolume(percent: number, channel: "Master" = "Master"): Promise<void> {
    const bounded = Math.max(0, Math.min(100, Math.round(percent)));
    await this.soapRequest(RC_CONTROL_PATH, RC_SERVICE, "SetVolume", `<InstanceID>0</InstanceID><Channel>${channel}</Channel><DesiredVolume>${bounded}</DesiredVolume>`);
  }

  async getMute(channel: "Master" = "Master"): Promise<boolean> {
    const xml = await this.soapRequest(RC_CONTROL_PATH, RC_SERVICE, "GetMute", `<InstanceID>0</InstanceID><Channel>${channel}</Channel>`);
    return tagValue(xml, "CurrentMute") === "1";
  }

  async setMute(muted: boolean, channel: "Master" = "Master"): Promise<void> {
    await this.soapRequest(RC_CONTROL_PATH, RC_SERVICE, "SetMute", `<InstanceID>0</InstanceID><Channel>${channel}</Channel><DesiredMute>${muted ? "1" : "0"}</DesiredMute>`);
  }

  /** Full group topology as this speaker's zone controller knows it. */
  async getZoneGroupState(): Promise<readonly SonosZoneGroup[]> {
    const xml = await this.soapRequest(ZGT_CONTROL_PATH, ZGT_SERVICE, "GetZoneGroupState", "");
    const stateXml = decodeXml(tagValue(xml, "ZoneGroupState") ?? "");
    const groups: SonosZoneGroup[] = [];
    for (const groupMatch of stateXml.matchAll(/<ZoneGroup\b([^>]*)>([\s\S]*?)<\/ZoneGroup>/giu)) {
      const attributes = groupMatch[1] ?? "";
      const body = groupMatch[2] ?? "";
      const coordinatorUuid = /Coordinator="([^"]*)"/u.exec(attributes)?.[1];
      if (!coordinatorUuid) continue;
      // A member's opening tag (self-closing or not) always carries its own
      // UUID/Location; a home-theater setup additionally nests each surround
      // and subwoofer as a <Satellite .../> inside the coordinator's
      // (non-self-closing) <ZoneGroupMember>...</ZoneGroupMember>, so both
      // tag names are scanned across the whole group body.
      const members: SonosZoneGroupMember[] = [];
      for (const memberMatch of body.matchAll(/<(?:ZoneGroupMember|Satellite)\b([^>]*?)\/?>/giu)) {
        const memberAttributes = memberMatch[1] ?? "";
        const uuid = /UUID="([^"]*)"/u.exec(memberAttributes)?.[1];
        if (!uuid) continue;
        const location = /Location="([^"]*)"/u.exec(memberAttributes)?.[1];
        const host = location ? safeUrlHost(decodeXml(location)) : undefined;
        members.push({ uuid, ...(host ? { host } : {}) });
      }
      groups.push({ coordinatorUuid, members });
    }
    return groups;
  }

  /** This speaker's own Sonos UUID (`RINCON_...`), read from its device description. */
  async getSpeakerUuid(): Promise<string> {
    const url = `http://${this.host}:${this.port}/xml/device_description.xml`;
    const text = await this.get(url);
    const udn = tagValue(text, "UDN");
    const uuid = udn?.replace(/^uuid:/iu, "");
    if (!uuid) throw new SonosSoapError(`Sonos device description at ${this.host} had no UDN`, "fault");
    return uuid;
  }

  private async get(url: string): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      throw new SonosSoapError(`Sonos speaker at ${this.host} is unreachable: ${detail(error)}`, "unreachable");
    }
    if (!response.ok) {
      throw new SonosSoapError(`Sonos device description request failed with HTTP ${response.status}`, "fault");
    }
    return await response.text();
  }

  private async soapRequest(controlPath: string, service: string, action: string, argsXml: string): Promise<string> {
    const url = `http://${this.host}:${this.port}${controlPath}`;
    const body = `<?xml version="1.0" encoding="utf-8"?>\n<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${service}">${argsXml}</u:${action}></s:Body></s:Envelope>`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": 'text/xml; charset="utf-8"',
          SOAPACTION: `"${service}#${action}"`,
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new SonosSoapError(`Sonos speaker at ${this.host} is unreachable: ${detail(error)}`, "unreachable");
    }

    const text = await response.text();
    if (!response.ok) {
      const fault = tagValue(text, "errorDescription") ?? tagValue(text, "faultstring");
      throw new SonosSoapError(`Sonos ${action} failed with HTTP ${response.status}${fault ? `: ${fault}` : ""}`, "fault");
    }
    return text;
  }
}

function safeUrlHost(value: string): string | undefined {
  try {
    return new URL(value).hostname;
  } catch {
    return undefined;
  }
}
