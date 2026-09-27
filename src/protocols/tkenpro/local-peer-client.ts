import { randomBytes } from "node:crypto";
import { createSocket, type RemoteInfo, type Socket } from "node:dgram";
import type { MeariLocalCameraAuthorization } from "./local-cloud-auth.ts";
import type { MeariLocalCloudRuntime } from "./local-cloud-runtime.ts";
import {
  MeariPeerCommandSession,
  type MeariPeerCommandResponse,
} from "./peer-command-session.ts";
import type { MeariCommonRequest } from "./p2p-command.ts";
import type { MeariRouteContact } from "./msgsvr.ts";
import {
  buildMeariOffer,
  createMeariSignalingSessionId,
  parseMeariSdp,
  type MeariIceCandidate,
  type MeariLanOffer,
  type ParsedMeariSdp,
} from "./signaling.ts";
import {
  encodeVvpStreamControlFrame,
  VVP_STREAM_AUTO_ID,
} from "./vvp-stream.ts";

type UnknownRecord = Record<string, unknown>;

export interface MeariLocalPeerRequestOptions {
  /** Complete offer/answer and candidate signaling within this period. */
  readonly signalingTimeoutMs?: number;
  /** Complete ICE, KCP setup, and the common command within this period. */
  readonly commandTimeoutMs?: number;
}

export interface MeariLocalPeerClientOptions {
  readonly runtime: MeariLocalCloudRuntime;
  readonly uuid: string;
  /** Live-stream ID used to establish the authenticated command context. */
  readonly streamId?: number;
  /** Device capability byte copied into START_LIVE byte 57. */
  readonly streamFlag?: number;
  /** Device mode flags copied into START_LIVE byte 58. */
  readonly streamReserve?: number;
  /** Diagnostic override for the logical WebRTC route presented to firmware. */
  readonly webRtcContact?: MeariRouteContact;
  /** Diagnostic public-shaped relay address; the direct host candidate remains local. */
  readonly offerRelayIp?: string;
  /** Diagnostic public-shaped server-reflexive address. */
  readonly offerMappedIp?: string;
  readonly onEvent?: (event: MeariLocalPeerEvent) => void;
}

export type MeariLocalPeerEvent =
  | {
    readonly type: "signaling-answer";
    readonly candidateTypes: readonly string[];
    readonly selectedType: string;
    readonly selectedAuthorizedAddress: boolean;
  }
  | { readonly type: "candidate-complete" }
  | { readonly type: "camera-ice-ready"; readonly matchesSignaledCandidate: boolean }
  | {
    readonly type: "client-ice-ready";
    readonly matchesCameraCheck: boolean;
    readonly matchesSignaledCandidate: boolean;
  }
  | { readonly type: "transport-started" }
  | { readonly type: "transport"; readonly event: string; readonly sequence?: number }
  | {
    readonly type: "request-sent";
    readonly transport: "direct" | "relay";
    readonly kcpSequence: number;
    readonly unacknowledged: number;
    readonly payloadLength: number;
  }
  | { readonly type: "response"; readonly status: number };

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function assertTimeout(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 120_000) {
    throw new RangeError(`${name} must be between 1 and 120000 milliseconds`);
  }
}

function assertByte(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new RangeError(`${name} must be between 0 and 255`);
  }
}

function normalizedAddress(value: string): string {
  return value.replace(/^::ffff:/u, "");
}

function sameTarget(
  left: { readonly ip: string; readonly port: number },
  right: { readonly ip: string; readonly port: number },
): boolean {
  return left.ip === right.ip && left.port === right.port;
}

function isMeariTransportDatagram(datagram: Buffer): boolean {
  return (
    (datagram.byteLength >= 4 && datagram.readUInt32LE(0) === 0x0000_000c)
    || (datagram[0] === 0xff && datagram[1] === 0x01)
  );
}

/** Collect the SDP and optional top-level candidate forms emitted by camera firmware. */
export function meariPeerCandidates(value: Readonly<UnknownRecord>): MeariIceCandidate[] {
  const candidates: MeariIceCandidate[] = [];
  const sdp = text(value.sdp);
  if (sdp) candidates.push(...parseMeariSdp(sdp).candidates);
  if (isRecord(value.candidate)) {
    const ip = text(value.candidate.ip);
    const port = Number(value.candidate.port);
    if (ip && Number.isInteger(port) && port > 0 && port <= 65_535) {
      candidates.push({ ip, port, type: text(value.candidate.type) || "relay" });
    }
  }
  const unique: MeariIceCandidate[] = [];
  for (const candidate of candidates) {
    const existing = unique.findIndex((other) => (
      other.ip === candidate.ip && other.port === candidate.port
    ));
    if (existing < 0) unique.push(candidate);
    else if (candidate.type === "host" && unique[existing]?.type !== "host") unique[existing] = candidate;
  }
  return unique;
}

/** Prefer an explicitly requested local relay, then the authenticated camera's LAN candidate. */
export function selectMeariPeerCandidate(
  candidates: readonly MeariIceCandidate[],
  authorizedAddress?: string,
  preferredRelay?: { readonly ip: string; readonly port: number },
): MeariIceCandidate | undefined {
  return candidates.find((candidate) => (
    candidate.ip === preferredRelay?.ip && candidate.port === preferredRelay.port
  ))
    ?? candidates.find((candidate) => (
      candidate.type === "host" && candidate.ip === authorizedAddress
    ))
    ?? candidates.find((candidate) => candidate.type === "host")
    ?? candidates[0];
}

async function bindUdp(host: string): Promise<Socket> {
  const socket = createSocket("udp4");
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, host, () => {
      socket.off("error", reject);
      resolve();
    });
  });
  return socket;
}

async function closeUdp(socket: Socket): Promise<void> {
  await new Promise<void>((resolve) => {
    try {
      socket.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

interface NegotiatedPeer {
  readonly answer: ParsedMeariSdp;
  readonly authorization: MeariLocalCameraAuthorization;
  readonly candidate: MeariIceCandidate;
  readonly offer: MeariLanOffer;
  readonly relayConnectionsBefore: number;
  readonly sessionPrefix: string;
  readonly turnCameraChannelDataBefore: number;
  readonly turnChannelBindingsBefore: number;
  readonly turnPeerChannelDataBefore: number;
  readonly turnPeerDataIndicationsBefore: number;
  readonly turnAllocationsBefore: number;
  readonly turnPermissionsBefore: number;
  readonly turnRelayedPacketsBefore: number;
  readonly turnUnmatchedPeerPacketsBefore: number;
}

/**
 * Authenticated, cloud-free common-command client for one locally registered camera.
 *
 * Each operation performs the camera's exact WebRTC-server signaling exchange,
 * selects its authenticated direct LAN candidate while satisfying the firmware's
 * parallel TURN setup, and then carries one HTTP-like operation over the native
 * ICE + KCP + IVA + VVP stack. Operations are serialized because this firmware
 * supports only one negotiation session reliably at a time.
 */
export class MeariLocalPeerClient {
  readonly runtime: MeariLocalCloudRuntime;
  readonly uuid: string;
  private closed = false;
  private tail: Promise<void> = Promise.resolve();
  private readonly onEvent: ((event: MeariLocalPeerEvent) => void) | undefined;
  private readonly streamId: number;
  private readonly streamFlag: number;
  private readonly streamReserve: number;
  private readonly webRtcContact: MeariRouteContact | undefined;
  private readonly offerRelayIp: string | undefined;
  private readonly offerMappedIp: string | undefined;
  private preparedSocket: Socket | undefined;

  constructor(options: MeariLocalPeerClientOptions) {
    if (!options.uuid.trim()) throw new TypeError("uuid is required");
    this.runtime = options.runtime;
    this.uuid = options.uuid;
    this.onEvent = options.onEvent;
    this.streamId = options.streamId ?? VVP_STREAM_AUTO_ID;
    this.streamFlag = options.streamFlag ?? 0;
    this.streamReserve = options.streamReserve ?? 0;
    this.webRtcContact = options.webRtcContact;
    this.offerRelayIp = options.offerRelayIp;
    this.offerMappedIp = options.offerMappedIp;
    assertByte("streamId", this.streamId);
    assertByte("streamFlag", this.streamFlag);
    assertByte("streamReserve", this.streamReserve);
  }

  get authorization(): MeariLocalCameraAuthorization | undefined {
    return this.runtime.authorization.devices.find((device) => device.uuid === this.uuid);
  }

  get available(): boolean {
    return Boolean(
      this.authorization?.peer
      && this.authorization.sourceAddress
      && this.runtime.emulator.connectedDeviceUuids.includes(this.uuid),
    );
  }

  /** Bind the camera-facing UDP endpoint before the camera begins peer negotiation. */
  async prepare(): Promise<void> {
    if (this.closed) throw new Error("Local peer client is closed");
    if (!this.preparedSocket) this.preparedSocket = await bindUdp(this.runtime.advertisedHost);
  }

  request(
    request: MeariCommonRequest,
    options: MeariLocalPeerRequestOptions = {},
  ): Promise<MeariPeerCommandResponse> {
    if (this.closed) return Promise.reject(new Error("Local peer client is closed"));
    const operation = this.tail.then(() => this.performRequest(request, options));
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
    if (this.preparedSocket) {
      const socket = this.preparedSocket;
      this.preparedSocket = undefined;
      await closeUdp(socket);
    }
  }

  private requireAuthorization(): MeariLocalCameraAuthorization {
    const authorization = this.authorization;
    if (!authorization?.peer) {
      throw new Error("Local peer metadata has not been bootstrapped for this camera");
    }
    if (!authorization.sourceAddress) {
      throw new Error("Local peer authorization omitted the camera source address");
    }
    if (!this.runtime.emulator.connectedDeviceUuids.includes(this.uuid)) {
      throw new Error("Camera is not connected to local control");
    }
    return authorization;
  }

  private async performRequest(
    request: MeariCommonRequest,
    options: MeariLocalPeerRequestOptions,
  ): Promise<MeariPeerCommandResponse> {
    const signalingTimeoutMs = options.signalingTimeoutMs ?? 15_000;
    const commandTimeoutMs = options.commandTimeoutMs ?? 15_000;
    assertTimeout("signalingTimeoutMs", signalingTimeoutMs);
    assertTimeout("commandTimeoutMs", commandTimeoutMs);
    const authorization = this.requireAuthorization();
    const socket = this.preparedSocket ?? await bindUdp(this.runtime.advertisedHost);
    this.preparedSocket = undefined;
    const caller = authorization.peer?.clientUuid ?? randomBytes(8).toString("hex");
    const signalingSessionId = createMeariSignalingSessionId();
    const sessionPrefix = randomBytes(4).toString("hex");
    const tag = `${sessionPrefix}01`;
    const relayConnectionsBefore = this.runtime.relay.acceptedConnectionCount;
    const turnCameraChannelDataBefore = this.runtime.turn.cameraChannelDataPacketCount;
    const turnChannelBindingsBefore = this.runtime.turn.channelBindingCount;
    const turnAllocationsBefore = this.runtime.turn.allocationCount;
    const turnPermissionsBefore = this.runtime.turn.permissionCount;
    const turnPeerChannelDataBefore = this.runtime.turn.peerChannelDataPacketCount;
    const turnPeerDataIndicationsBefore = this.runtime.turn.peerDataIndicationPacketCount;
    const turnRelayedPacketsBefore = this.runtime.turn.relayedPacketCount;
    const turnUnmatchedPeerPacketsBefore = this.runtime.turn.unmatchedPeerPacketCount;
    const releaseTag = this.runtime.relay.authorizeTag(tag);
    // Keep the two-minute ephemeral credential window from the captured flow.
    const turnCredential = this.runtime.turn.issueCredential();
    const webRtcContact = this.webRtcContact ?? {
      node: "webrtcsvr",
      domain: "webrtcsvr.us",
      transport: "tcp",
      type: "binary",
      ip: this.runtime.advertisedHost,
      port: this.runtime.relay.port,
    } as const;
    try {
      const address = socket.address();
      if (typeof address === "string") throw new Error("Local UDP socket did not expose a port");
      const offer = buildMeariOffer({
        localIp: this.runtime.advertisedHost,
        localPort: address.port,
        relayIp: this.offerRelayIp ?? this.runtime.advertisedHost,
        // This is the peer endpoint the camera's TURN allocation relays to,
        // not the TURN control socket itself. Advertising the TURN port here
        // creates a self-loop inside a single-host local deployment.
        relayPort: address.port,
        mappedIp: this.offerMappedIp ?? this.runtime.advertisedHost,
        mappedPort: address.port,
      });
      const answerMessage = await this.runtime.emulator.requestRouted(this.uuid, {
        cmd: "offer",
        sid: signalingSessionId,
        caller,
        callee: this.uuid,
        channel: 0,
        stream_type: 1,
        sdp: offer.sdp,
        coturn_host: "turnusil05.mearicloud.com",
        coturn_ip: this.runtime.advertisedHost,
        coturn_port: this.runtime.turn.port,
        username: turnCredential.username,
        pwd: turnCredential.password,
        tag,
      }, {
        from: webRtcContact,
        timeoutMs: signalingTimeoutMs,
      });
      const answer = parseMeariSdp(text(answerMessage.sdp));
      if (!answer.usernameFragment || !answer.password) {
        throw new Error("Camera answer omitted ICE credentials");
      }
      const candidates = meariPeerCandidates(answerMessage);
      const candidate = selectMeariPeerCandidate(
        candidates,
        authorization.sourceAddress,
      );
      if (!candidate) throw new Error("Camera answer omitted a usable peer candidate");
      this.onEvent?.({
        type: "signaling-answer",
        candidateTypes: candidates.map((item) => item.type),
        selectedType: candidate.type,
        selectedAuthorizedAddress: candidate.ip === authorization.sourceAddress,
      });
      await this.runtime.emulator.requestRouted(this.uuid, {
        cmd: "candidate",
        sid: signalingSessionId,
        caller,
        callee: this.uuid,
        candidate: { cmd: "nego", state: "completed", mode: 1 },
      }, {
        from: webRtcContact,
        timeoutMs: Math.min(signalingTimeoutMs, 8_000),
      });
      this.onEvent?.({ type: "candidate-complete" });
      return await this.requestOnNegotiatedSocket(socket, request, {
        answer,
        authorization,
        candidate,
        offer,
        relayConnectionsBefore,
        sessionPrefix,
        turnCameraChannelDataBefore,
        turnChannelBindingsBefore,
        turnAllocationsBefore,
        turnPeerChannelDataBefore,
        turnPeerDataIndicationsBefore,
        turnPermissionsBefore,
        turnRelayedPacketsBefore,
        turnUnmatchedPeerPacketsBefore,
      }, commandTimeoutMs);
    } finally {
      turnCredential.release();
      releaseTag();
      await closeUdp(socket);
    }
  }

  private async requestOnNegotiatedSocket(
    socket: Socket,
    request: MeariCommonRequest,
    negotiated: NegotiatedPeer,
    timeoutMs: number,
  ): Promise<MeariPeerCommandResponse> {
    const peerAuth = negotiated.authorization.peer;
    if (!peerAuth) throw new Error("Local peer metadata has not been bootstrapped");
    let target = { ip: negotiated.candidate.ip, port: negotiated.candidate.port };
    let replyTarget: { ip: string; port: number } | undefined;
    let transportTarget: { ip: string; port: number } | undefined;
    let cameraIceCheckObserved = false;
    let clientIceReadyObserved = false;
    let cameraIcePort: number | undefined;
    let sessionStarted = false;
    let streamControlSent = false;
    let requestSent = false;
    let settled = false;
    let punchTimer: ReturnType<typeof setInterval> | undefined;
    let iceTimer: ReturnType<typeof setInterval> | undefined;
    let sessionStartTimer: ReturnType<typeof setTimeout> | undefined;
    let requestStartTimer: ReturnType<typeof setTimeout> | undefined;
    let lastSendError: Error | undefined;
    let resolveResponse!: (response: MeariPeerCommandResponse) => void;
    let rejectResponse!: (error: Error) => void;
    const response = new Promise<MeariPeerCommandResponse>((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    const fail = (error: Error): void => {
      lastSendError = error;
      if (settled) return;
      settled = true;
      rejectResponse(error);
    };
    const peer = new MeariPeerCommandSession({
      hostKey: peerAuth.hostKey,
      protocolVersion: peerAuth.protocolVersion,
      licenceId: peerAuth.licenceId,
      initialRequestSequence: 1,
      send: (datagram) => {
        const destination = replyTarget ?? target;
        socket.send(datagram, destination.port, destination.ip, (error) => {
          if (error) fail(error);
        });
      },
    });

    const sendRequest = (): void => {
      if (requestSent || settled) return;
      requestSent = true;
      try {
        const destination = replyTarget ?? target;
        const sent = peer.sendCommonRequest(request);
        const first = sent.datagrams[0];
        this.onEvent?.({
          type: "request-sent",
          transport: sameTarget(destination, {
            ip: this.runtime.advertisedHost,
            port: this.runtime.turn.port,
          }) ? "relay" : "direct",
          kcpSequence: first?.readUInt32LE(12) ?? 0,
          unacknowledged: first?.readUInt32LE(16) ?? 0,
          payloadLength: first?.readUInt32LE(20) ?? 0,
        });
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const sendStreamControl = (): void => {
      if (streamControlSent || settled) return;
      streamControlSent = true;
      peer.tunnel.sendIvaData(encodeVvpStreamControlFrame({
        hostKey: peerAuth.hostKey,
        licenceId: peerAuth.licenceId,
        sequence: 0,
        streamId: this.streamId,
        streamFlag: this.streamFlag,
        reserve: this.streamReserve,
      }));
      // The captured app waits for the camera's IVA handshake before placing
      // the common request at KCP SN 2. Keep a generous compatibility fallback
      // for firmware that acknowledges startup but omits that handshake.
      requestStartTimer = setTimeout(sendRequest, 4_000);
    };
    const beginSession = (): void => {
      sessionStartTimer = undefined;
      if (sessionStarted || settled) return;
      sessionStarted = true;
      if (iceTimer) clearInterval(iceTimer);
      this.onEvent?.({ type: "transport-started" });
      peer.sendLanConnect(negotiated.sessionPrefix);
      peer.start();
      // CloudEdge places the IVA handshake at KCP SN 0 and START_LIVE at SN 1
      // before waiting for the camera's compound ACK. Sending them together is
      // important: this firmware initializes the authenticated command context
      // from that two-message startup flight.
      sendStreamControl();
    };
    const startSession = (): void => {
      if (
        sessionStarted
        || sessionStartTimer
        || !cameraIceCheckObserved
        || !clientIceReadyObserved
        || settled
      ) return;
      // Captured firmware continues its nomination checks for about 620 ms.
      // Let that phase settle before introducing KCP payloads on the socket.
      sessionStartTimer = setTimeout(beginSession, 750);
    };
    const onMessage = (datagram: Buffer, source: RemoteInfo): void => {
      const sourceAddress = normalizedAddress(source.address);
      const fromLocalRelay = (
        sourceAddress === this.runtime.advertisedHost
        && source.port === this.runtime.turn.port
      );
      const fromAuthorizedCamera = sourceAddress === negotiated.authorization.sourceAddress;
      if (!fromLocalRelay && !fromAuthorizedCamera) return;
      const incomingTarget = { ip: sourceAddress, port: source.port };
      // The firmware often emits the same KCP session over both its host and
      // TURN candidates during nomination. Once one path carries transport,
      // keep the reliable byte stream on that path; feeding both copies into a
      // single KCP receive window causes false fragments and retransmit storms.
      if (
        transportTarget
        && !sameTarget(transportTarget, incomingTarget)
        && isMeariTransportDatagram(datagram)
      ) return;
      // Immediate ICE responses and transport ACKs must return over the same
      // candidate path on which their triggering datagram arrived.
      replyTarget = incomingTarget;
      try {
        const events = peer.processDatagram(datagram);
        for (const event of events) {
          if (event.type === "ice-check") {
            cameraIcePort = source.port;
            if (!cameraIceCheckObserved) this.onEvent?.({
              type: "camera-ice-ready",
              matchesSignaledCandidate: source.port === negotiated.candidate.port,
            });
            cameraIceCheckObserved = true;
          } else if (event.type === "ice-ready") {
            // This response identifies the pair that accepted our authenticated
            // USE-CANDIDATE check. Prefer it over any earlier camera-originated
            // connectivity check, which can come from a secondary ICE socket.
            if (!transportTarget) target = incomingTarget;
            if (!clientIceReadyObserved) this.onEvent?.({
              type: "client-ice-ready",
              matchesCameraCheck: source.port === cameraIcePort,
              matchesSignaledCandidate: source.port === negotiated.candidate.port,
            });
            clientIceReadyObserved = true;
          } else if (event.type === "command-response") {
            settled = true;
            this.onEvent?.({ type: "response", status: event.response.http.status });
            resolveResponse(event.response);
          } else if (event.type === "transport") {
            // A bare ACK can arrive on the host candidate immediately before
            // the camera moves the session to TURN. Pin only the path carrying
            // the camera's own handshake/data; that is the stable KCP path in
            // both the captured CloudEdge flow and this firmware's LAN flow.
            if (
              !transportTarget
              && (event.event.type === "handshake" || event.event.type === "data")
            ) transportTarget = incomingTarget;
            if (transportTarget) target = transportTarget;
            if (!sessionStarted && (
              event.event.type === "handshake" || event.event.type === "data"
            )) {
              if (sessionStartTimer) clearTimeout(sessionStartTimer);
              beginSession();
            }
            if (!sessionStarted) continue;
            if (punchTimer) clearInterval(punchTimer);
            const sequence = event.event.type === "ack" ? event.event.sequence : undefined;
            this.onEvent?.({
              type: "transport",
              event: event.event.type,
              ...(sequence === undefined ? {} : { sequence }),
            });
            if (
              event.event.type === "handshake"
              || (event.event.type === "ack" && event.event.sequence >= 0)
            ) sendStreamControl();
            if (
              event.event.type === "handshake"
              || event.event.type === "data"
            ) sendRequest();
          }
        }
        startSession();
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      } finally {
        replyTarget = undefined;
      }
    };
    const onSocketError = (error: Error): void => fail(error);
    socket.on("message", onMessage);
    socket.on("error", onSocketError);
    const tieBreaker = randomBytes(8).readBigUInt64BE();
    const sendPunch = (): void => {
      peer.sendLanConnect(negotiated.sessionPrefix);
    };
    const sendIce = (): void => {
      peer.sendIceCheck({
        localUsernameFragment: negotiated.offer.usernameFragment,
        remoteUsernameFragment: negotiated.answer.usernameFragment,
        remotePassword: negotiated.answer.password,
        tieBreaker,
      });
    };
    punchTimer = setInterval(sendPunch, 500);
    iceTimer = setInterval(sendIce, 30);
    const retransmitTimer = setInterval(() => {
      if (sessionStarted) peer.retransmitUnacknowledged();
    }, 220);
    const timeoutTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectResponse(new Error(
        `Local peer command timed out (camera ICE=${cameraIceCheckObserved}; client ICE=${clientIceReadyObserved}; TURN=${this.runtime.turn.allocationCount - negotiated.turnAllocationsBefore}; permissions=${this.runtime.turn.permissionCount - negotiated.turnPermissionsBefore}; channels=${this.runtime.turn.channelBindingCount - negotiated.turnChannelBindingsBefore}; peer ChannelData=${this.runtime.turn.peerChannelDataPacketCount - negotiated.turnPeerChannelDataBefore}; peer indications=${this.runtime.turn.peerDataIndicationPacketCount - negotiated.turnPeerDataIndicationsBefore}; camera ChannelData=${this.runtime.turn.cameraChannelDataPacketCount - negotiated.turnCameraChannelDataBefore}; relayed=${this.runtime.turn.relayedPacketCount - negotiated.turnRelayedPacketsBefore}; unmatched peer=${this.runtime.turn.unmatchedPeerPacketCount - negotiated.turnUnmatchedPeerPacketsBefore}; relay tickets=${this.runtime.relay.acceptedConnectionCount - negotiated.relayConnectionsBefore}${lastSendError ? `; ${lastSendError.message}` : ""})`,
      ));
    }, timeoutMs);
    sendPunch();
    sendIce();
    try {
      return await response;
    } finally {
      if (punchTimer) clearInterval(punchTimer);
      if (iceTimer) clearInterval(iceTimer);
      if (sessionStartTimer) clearTimeout(sessionStartTimer);
      if (requestStartTimer) clearTimeout(requestStartTimer);
      clearInterval(retransmitTimer);
      clearTimeout(timeoutTimer);
      socket.off("message", onMessage);
      socket.off("error", onSocketError);
    }
  }
}
