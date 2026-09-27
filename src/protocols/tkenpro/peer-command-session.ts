import {
  decodeStunMessage,
  encodeIceBindingRequest,
  encodeIceBindingSuccess,
  STUN_BINDING_REQUEST,
  STUN_BINDING_SUCCESS,
  STUN_MAGIC_COOKIE,
  type IceBindingRequestOptions,
  type ParsedStunMessage,
} from "./ice.ts";
import {
  MeariKcpTunnel,
  type MeariKcpTunnelOptions,
  type MeariTunnelEvent,
} from "./kcp-tunnel.ts";
import {
  decodeMsgSvrFrame,
  encodeMeariLanConnectFrame,
  MSGSVR_MAGIC,
  type MsgSvrFrame,
} from "./msgsvr.ts";
import {
  buildMeariCommonHttpRequest,
  decodeVvpCommandFrame,
  encodeVvpCommandFrame,
  parseMeariHttpResponse,
  VVP_COMMAND_RESPONSE,
  VVP_WIRE_MAGIC,
  type MeariCommonRequest,
  type ParsedMeariHttpResponse,
  type ParsedVvpCommandFrame,
  type VvpCommandAuth,
} from "./p2p-command.ts";

export interface MeariPeerCommandSessionOptions extends VvpCommandAuth {
  readonly send?: (datagram: Buffer) => void;
  readonly initialRequestSequence?: number;
  readonly autoAcknowledge?: boolean;
  readonly receiveWindow?: number;
  readonly maximumSegmentSize?: number;
  readonly now?: () => number;
  readonly sessionId1?: number;
  readonly sessionId2?: number;
}

export interface MeariPeerRequest {
  readonly sequence: number;
  readonly request: MeariCommonRequest;
  readonly http: Buffer;
  readonly frame: Buffer;
  readonly datagrams: readonly Buffer[];
}

export interface MeariPeerCommandResponse {
  readonly requestSequence: number;
  readonly request: MeariCommonRequest;
  readonly frame: ParsedVvpCommandFrame;
  readonly http: ParsedMeariHttpResponse;
}

export type MeariPeerSessionEvent =
  | {
    readonly type: "ice-check";
    readonly request: ParsedStunMessage;
    readonly response: Buffer;
  }
  | { readonly type: "ice-ready"; readonly response: ParsedStunMessage }
  | { readonly type: "signaling"; readonly frame: MsgSvrFrame }
  | { readonly type: "command-response"; readonly response: MeariPeerCommandResponse }
  | { readonly type: "unmatched-command"; readonly frame: ParsedVvpCommandFrame }
  | { readonly type: "transport"; readonly event: MeariTunnelEvent };

function assertUint32(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${name} must be an unsigned 32-bit integer`);
  }
}

function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function isStunDatagram(datagram: Buffer): boolean {
  return (
    datagram.byteLength >= 20 &&
    ((datagram[0] ?? 0) & 0xc0) === 0 &&
    datagram.readUInt32BE(4) === STUN_MAGIC_COOKIE
  );
}

function isVvpFrame(payload: Buffer): boolean {
  return payload.byteLength >= 4 && payload.readUInt32BE(0) === VVP_WIRE_MAGIC;
}

/**
 * Compose Meari's LAN punch, ICE, KCP/IVA, VVP, and common-command layers.
 *
 * The class deliberately owns no socket or timer. Callers can use one UDP
 * socket for a negotiated host candidate, feed received datagrams into
 * processDatagram(), and schedule retransmission according to their runtime.
 */
export class MeariPeerCommandSession {
  readonly tunnel: MeariKcpTunnel;

  private readonly sendDatagram: (datagram: Buffer) => void;
  private readonly auth: VvpCommandAuth;
  private readonly autoAcknowledge: boolean;
  private nextRequestSequence: number;
  private started = false;
  private readonly pending = new Map<number, MeariCommonRequest>();

  constructor(options: MeariPeerCommandSessionOptions) {
    if (!options.hostKey) throw new TypeError("hostKey is required");
    this.sendDatagram = options.send ?? (() => undefined);
    this.auth = {
      hostKey: options.hostKey,
      ...(options.protocolVersion === undefined ? {} : { protocolVersion: options.protocolVersion }),
      ...(options.licenceId === undefined ? {} : { licenceId: options.licenceId }),
      ...(options.fullHostKey === undefined ? {} : { fullHostKey: options.fullHostKey }),
      ...(options.username === undefined ? {} : { username: options.username }),
    };
    this.autoAcknowledge = options.autoAcknowledge ?? true;
    this.nextRequestSequence = options.initialRequestSequence ?? 0;
    assertUint32("initialRequestSequence", this.nextRequestSequence);
    const tunnelOptions: MeariKcpTunnelOptions = {
      send: this.sendDatagram,
      ...(options.receiveWindow === undefined ? {} : { receiveWindow: options.receiveWindow }),
      ...(options.maximumSegmentSize === undefined
        ? {}
        : { maximumSegmentSize: options.maximumSegmentSize }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.sessionId1 === undefined ? {} : { sessionId1: options.sessionId1 }),
      ...(options.sessionId2 === undefined ? {} : { sessionId2: options.sessionId2 }),
    };
    this.tunnel = new MeariKcpTunnel(tunnelOptions);
  }

  get isStarted(): boolean {
    return this.started;
  }

  get pendingRequestCount(): number {
    return this.pending.size;
  }

  /** Send the plaintext MsgSvr punch to a negotiated camera host candidate. */
  sendLanConnect(sessionPrefix: string): Buffer {
    const frame = encodeMeariLanConnectFrame(sessionPrefix);
    this.sendDatagram(frame);
    return frame;
  }

  /** Initiate the authenticated app-to-camera ICE connectivity check. */
  sendIceCheck(options: IceBindingRequestOptions): Buffer {
    const request = encodeIceBindingRequest(options);
    this.sendDatagram(request);
    return request;
  }

  /** Send the native IVA handshake at KCP sequence zero exactly once. */
  start(): readonly Buffer[] {
    if (this.started) return [];
    this.started = true;
    return this.tunnel.sendHandshake();
  }

  /**
   * Serialize and send one authenticated camera-loopback operation.
   * CloudEdge advances request sequence numbers by one; the paired response
   * echoes the same sequence on the wire.
   */
  sendCommonRequest(request: MeariCommonRequest): MeariPeerRequest {
    this.start();
    const sequence = this.nextRequestSequence;
    this.nextRequestSequence = (this.nextRequestSequence + 1) >>> 0;
    const http = buildMeariCommonHttpRequest(request, {
      hostKey: this.auth.hostKey,
      ...(this.auth.username === undefined ? {} : { username: this.auth.username }),
    });
    const frame = encodeVvpCommandFrame(http, { ...this.auth, sequence });
    this.pending.set(sequence, request);
    const datagrams = this.tunnel.sendIvaData(frame);
    return { sequence, request, http, frame, datagrams };
  }

  retransmitUnacknowledged(): readonly Buffer[] {
    return this.tunnel.retransmitUnacknowledged();
  }

  flushAcks(): readonly Buffer[] {
    return this.tunnel.flushAcks();
  }

  private processCommand(payload: Buffer): MeariPeerSessionEvent | undefined {
    if (!isVvpFrame(payload)) return undefined;
    const frame = decodeVvpCommandFrame(payload);
    if (frame.command !== VVP_COMMAND_RESPONSE) {
      return { type: "unmatched-command", frame };
    }
    // Modern cameras echo the request sequence in the paired 0x8001 reply.
    const requestSequence = frame.sequence;
    const request = this.pending.get(requestSequence);
    if (!request) return { type: "unmatched-command", frame };
    const response: MeariPeerCommandResponse = {
      requestSequence,
      request,
      frame: decodeVvpCommandFrame(payload, requestSequence),
      http: parseMeariHttpResponse(frame.payload),
    };
    this.pending.delete(requestSequence);
    return { type: "command-response", response };
  }

  /** Process one UDP payload from the current camera candidate. */
  processDatagram(bytes: Uint8Array): readonly MeariPeerSessionEvent[] {
    const datagram = asBuffer(bytes);
    if (isStunDatagram(datagram)) {
      const message = decodeStunMessage(datagram);
      if (message.type === STUN_BINDING_REQUEST) {
        const response = encodeIceBindingSuccess(message.transactionId);
        this.sendDatagram(response);
        return [{ type: "ice-check", request: message, response }];
      }
      if (message.type === STUN_BINDING_SUCCESS) {
        return [{ type: "ice-ready", response: message }];
      }
      return [];
    }

    if (datagram[0] === MSGSVR_MAGIC) {
      return [{ type: "signaling", frame: decodeMsgSvrFrame(datagram) }];
    }

    const tunnelEvents = this.tunnel.processDatagram(datagram);
    const events: MeariPeerSessionEvent[] = [];
    for (const event of tunnelEvents) {
      if (event.type === "data" || event.type === "raw") {
        const command = this.processCommand(event.payload);
        if (command) events.push(command);
      }
      events.push({ type: "transport", event });
    }
    if (this.autoAcknowledge) this.tunnel.flushAcks();
    return events;
  }
}
