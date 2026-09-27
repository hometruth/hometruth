import { createSocket, type RemoteInfo, type Socket } from "node:dgram";
import {
  decodeMsgSvrFrame,
  encodeMsgSvrFrame,
  MSGSVR_COMMANDS,
  MSGSVR_METHODS,
  MSGSVR_NODES,
} from "./msgsvr.ts";

type UnknownRecord = Record<string, unknown>;

export interface MeariLocalRootContact {
  readonly advertisedHost: string;
  readonly signalingPort: number;
  readonly dnsPort?: number;
  readonly nestedDnsPort?: number;
  readonly domain?: string;
  readonly dnsDomain?: string;
  readonly responseKind?: "combined" | "root" | "parent";
}

export interface MeariLocalRootDiscoveryServerOptions extends MeariLocalRootContact {
  readonly host?: string;
  readonly port?: number;
  /** Keep the responder scoped to the camera VLAN/address. */
  readonly allowSourceAddress: (address: string) => boolean;
  readonly onQuery?: () => void;
}

function assertPort(name: string, value: number, allowZero = false): void {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(value) || value < minimum || value > 65_535) {
    throw new RangeError(`${name} must be between ${minimum} and 65535`);
  }
}

function requireRecord(value: unknown, name: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} is not an object`);
  }
  return value as UnknownRecord;
}

/** Build the DNS/root response that directs firmware to the local MsgSvr. */
export function buildMeariLocalRootDiscoveryResponse(
  request: Uint8Array,
  contact: MeariLocalRootContact,
): Buffer {
  if (!contact.advertisedHost.trim()) throw new TypeError("advertisedHost is required");
  assertPort("signalingPort", contact.signalingPort);
  assertPort("dnsPort", contact.dnsPort ?? 18_661);
  assertPort("nestedDnsPort", contact.nestedDnsPort ?? 9_255);
  const frame = decodeMsgSvrFrame(request);
  const body = requireRecord(frame.payload, "root discovery request");
  if (frame.command !== MSGSVR_COMMANDS.STATUS || body.action !== "conf") {
    throw new Error("Unexpected root discovery request");
  }
  const domain = contact.domain ?? "hometruth.local";
  const dnsDomain = contact.dnsDomain ?? domain;
  const shared = {
    action: "conf",
    ...(typeof body.uuid === "string" ? { uuid: body.uuid } : {}),
  };
  if (contact.responseKind === "root") {
    return encodeMsgSvrFrame({
      node: MSGSVR_NODES.DNS_SERVER,
      method: MSGSVR_METHODS.ROUTED,
      command: MSGSVR_COMMANDS.STATUS,
      payload: {
        ...shared,
        dnssvr: {
          node: "dnssvr",
          domain: dnsDomain,
          transport: "udp",
          type: "binary",
          ip: contact.advertisedHost,
          port: contact.nestedDnsPort ?? 9_255,
        },
        dnssvr_host: dnsDomain,
      },
    });
  }
  if (contact.responseKind === "parent") {
    return encodeMsgSvrFrame({
      node: MSGSVR_NODES.DNS_SERVER,
      method: MSGSVR_METHODS.ROUTED,
      command: MSGSVR_COMMANDS.STATUS,
      payload: {
        ...shared,
        contact: {
          node: "natsvr",
          domain,
          transport: "tcp",
          type: "binary",
          ip: contact.advertisedHost,
          port: contact.signalingPort,
        },
        host: domain,
        dns: {
          ip: contact.advertisedHost,
          port: contact.dnsPort ?? 18_661,
        },
      },
    });
  }
  return encodeMsgSvrFrame({
    node: MSGSVR_NODES.DNS_SERVER,
    method: MSGSVR_METHODS.ROUTED,
    command: MSGSVR_COMMANDS.STATUS,
    payload: {
      ...shared,
      contact: {
        node: "pssvr",
        domain,
        transport: "tcp",
        type: "binary",
        ip: contact.advertisedHost,
        port: contact.signalingPort,
      },
      host: domain,
      dns: {
        ip: contact.advertisedHost,
        port: contact.dnsPort ?? 18_661,
      },
      dnssvr: {
        node: "dnssvr",
        domain,
        transport: "udp",
        type: "binary",
        ip: contact.advertisedHost,
        port: contact.nestedDnsPort ?? 9_255,
      },
      dnssvr_host: domain,
    },
  });
}

/** UDP root/DNS endpoint the camera contacts once the LAN DNS override points the vendor hostname here. */
export class MeariLocalRootDiscoveryServer {
  readonly options: MeariLocalRootDiscoveryServerOptions;
  readonly socket: Socket;
  private boundPort = 0;
  private started = false;

  constructor(options: MeariLocalRootDiscoveryServerOptions) {
    if (!options.advertisedHost.trim()) throw new TypeError("advertisedHost is required");
    if (typeof options.allowSourceAddress !== "function") {
      throw new TypeError("allowSourceAddress is required");
    }
    assertPort("port", options.port ?? 9_253, true);
    assertPort("signalingPort", options.signalingPort);
    this.options = options;
    this.socket = createSocket("udp4");
    this.socket.on("message", (message, source) => this.handle(message, source));
  }

  get port(): number {
    return this.boundPort;
  }

  async start(): Promise<number> {
    if (this.started) return this.boundPort;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.socket.once("error", onError);
      this.socket.bind(this.options.port ?? 9_253, this.options.host ?? "0.0.0.0", () => {
        this.socket.off("error", onError);
        resolve();
      });
    });
    const address = this.socket.address();
    this.boundPort = address.port;
    this.started = true;
    return this.boundPort;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await new Promise<void>((resolve) => this.socket.close(() => resolve()));
  }

  private handle(message: Buffer, source: RemoteInfo): void {
    if (!this.options.allowSourceAddress(source.address)) return;
    try {
      const response = buildMeariLocalRootDiscoveryResponse(message, this.options);
      this.socket.send(response, source.port, source.address);
      this.options.onQuery?.();
    } catch {
      // Ignore malformed or unrelated UDP traffic on the discovery port.
    }
  }
}
