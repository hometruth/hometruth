import { randomBytes } from "node:crypto";
import { createSocket, type RemoteInfo, type Socket } from "node:dgram";
import type { MeariLocalCameraAuthorization } from "./local-cloud-auth.ts";
import type { MeariLocalCloudRuntime } from "./local-cloud-runtime.ts";
import {
  meariPeerCandidates,
  selectMeariPeerCandidate,
} from "./local-peer-client.ts";
import { MeariPeerCommandSession } from "./peer-command-session.ts";
import {
  buildMeariOffer,
  createMeariSignalingSessionId,
  parseMeariSdp,
  type MeariIceCandidate,
  type MeariLanOffer,
  type ParsedMeariSdp,
} from "./signaling.ts";
import {
  encodeVvpPlaybackPauseFrame,
  encodeVvpPlaybackResumeFrame,
  encodeVvpPlaybackSeekFrame,
  encodeVvpPlaybackStartFrame,
  encodeVvpPlaybackStopFrame,
  VVP_PLAYBACK_RESPONSE,
  VVP_PLAYBACK_RESPONSE_SIZE,
  type ParsedVvpPlaybackResponse,
} from "./vvp-playback.ts";
import {
  VvpMediaStreamFramer,
  type ParsedVvpMediaFrame,
} from "./vvp-media.ts";
import {
  decodeXtsMediaFrame,
  isXtsMediaMessage,
  XTS_MEDIA_TYPE_INFO,
  xtsMediaType,
} from "./xts-media.ts";

export interface MeariLocalPlaybackStartOptions {
  readonly signalingTimeoutMs?: number;
  readonly transportTimeoutMs?: number;
  readonly videoId?: number;
}

export interface MeariLocalPlaybackClientOptions {
  readonly runtime: MeariLocalCloudRuntime;
  readonly uuid: string;
  readonly onEvent?: (event: MeariLocalPlaybackEvent) => void;
}

export type MeariLocalPlaybackEvent =
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
    readonly type: "control-sent";
    readonly command: "start" | "stop" | "pause" | "resume" | "seek";
    readonly controlSequence: number;
    readonly kcpSequence: number;
  }
  | { readonly type: "response"; readonly response: ParsedVvpPlaybackResponse }
  | {
    readonly type: "media";
    readonly frame: ParsedVvpMediaFrame;
    readonly payload: Buffer;
  }
  | { readonly type: "media-error"; readonly message: string }
  | { readonly type: "stopped" };

interface NegotiatedPlaybackPeer {
  readonly answer: ParsedMeariSdp;
  readonly authorization: MeariLocalCameraAuthorization;
  readonly candidate: MeariIceCandidate;
  readonly offer: MeariLanOffer;
  readonly sessionPrefix: string;
}

type PeerTarget = { ip: string; port: number };

function assertTimeout(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 120_000) {
    throw new RangeError(`${name} must be between 1 and 120000 milliseconds`);
  }
}

function assertVideoId(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError("videoId must be an unsigned 32-bit integer");
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizedAddress(value: string): string {
  return value.replace(/^::ffff:/u, "");
}

function sameTarget(left: PeerTarget, right: PeerTarget): boolean {
  return left.ip === right.ip && left.port === right.port;
}

function isMeariTransportDatagram(datagram: Buffer): boolean {
  return (
    (datagram.byteLength >= 4 && datagram.readUInt32LE(0) === 0x0000_000c)
    || (datagram[0] === 0xff && datagram[1] === 0x01)
  );
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Authenticated, cloud-free SD-card playback session for factory-10/type-9 cameras.
 *
 * The native SDK sends a KCP/IVA handshake followed by command 0x131a on the
 * reliable control channel. Playback packets then arrive over the same local
 * peer connection from the camera's logical PPCS media channel.
 */
export class MeariLocalPlaybackClient {
  readonly runtime: MeariLocalCloudRuntime;
  readonly uuid: string;

  private readonly onEvent: ((event: MeariLocalPlaybackEvent) => void) | undefined;
  private closed = false;
  private starting: Promise<ParsedVvpPlaybackResponse> | undefined;
  private stopping: Promise<void> | undefined;
  private preparedSocket: Socket | undefined;
  private socket: Socket | undefined;
  private peer: MeariPeerCommandSession | undefined;
  private target: PeerTarget | undefined;
  private replyTarget: PeerTarget | undefined;
  private transportTarget: PeerTarget | undefined;
  private negotiated: NegotiatedPlaybackPeer | undefined;
  private releaseTag: (() => void) | undefined;
  private releaseTurnCredential: (() => void) | undefined;
  private messageHandler: ((datagram: Buffer, source: RemoteInfo) => void) | undefined;
  private errorHandler: ((error: Error) => void) | undefined;
  private punchTimer: ReturnType<typeof setInterval> | undefined;
  private iceTimer: ReturnType<typeof setInterval> | undefined;
  private retransmitTimer: ReturnType<typeof setInterval> | undefined;
  private sessionStartTimer: ReturnType<typeof setTimeout> | undefined;
  private startupTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
  private responseReject: ((error: Error) => void) | undefined;
  private cameraIceCheckObserved = false;
  private clientIceReadyObserved = false;
  private cameraIcePort: number | undefined;
  private sessionStarted = false;
  private startControlSent = false;
  private active = false;
  private controlSequence = 0;
  private videoId = 0;
  private mediaFramer: VvpMediaStreamFramer | undefined;

  constructor(options: MeariLocalPlaybackClientOptions) {
    if (!options.uuid.trim()) throw new TypeError("uuid is required");
    this.runtime = options.runtime;
    this.uuid = options.uuid;
    this.onEvent = options.onEvent;
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

  get isActive(): boolean {
    return this.active;
  }

  async prepare(): Promise<void> {
    if (this.closed) throw new Error("Local playback client is closed");
    if (!this.preparedSocket) this.preparedSocket = await bindUdp(this.runtime.advertisedHost);
  }

  async start(
    timestamp: string,
    options: MeariLocalPlaybackStartOptions = {},
  ): Promise<ParsedVvpPlaybackResponse> {
    if (this.closed) throw new Error("Local playback client is closed");
    if (this.starting) return await this.starting;
    if (this.stopping) await this.stopping;
    if (this.socket) await this.stop();
    this.videoId = options.videoId ?? 0;
    assertVideoId(this.videoId);
    const operation = this.open(timestamp, options);
    this.starting = operation;
    try {
      return await operation;
    } finally {
      if (this.starting === operation) this.starting = undefined;
    }
  }

  pause(): void {
    this.sendControl("pause");
  }

  resume(): void {
    this.sendControl("resume");
  }

  seek(timestamp: string): void {
    this.sendControl("seek", timestamp);
  }

  async stop(): Promise<void> {
    if (this.stopping) return await this.stopping;
    const operation = this.finish();
    this.stopping = operation;
    try {
      await operation;
    } finally {
      if (this.stopping === operation) this.stopping = undefined;
    }
  }

  async close(): Promise<void> {
    await this.stop();
    this.closed = true;
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

  private async open(
    timestamp: string,
    options: MeariLocalPlaybackStartOptions,
  ): Promise<ParsedVvpPlaybackResponse> {
    const signalingTimeoutMs = options.signalingTimeoutMs ?? 15_000;
    const transportTimeoutMs = options.transportTimeoutMs ?? 18_000;
    assertTimeout("signalingTimeoutMs", signalingTimeoutMs);
    assertTimeout("transportTimeoutMs", transportTimeoutMs);
    const authorization = this.requireAuthorization();
    const socket = this.preparedSocket ?? await bindUdp(this.runtime.advertisedHost);
    this.preparedSocket = undefined;
    this.socket = socket;

    const caller = authorization.peer?.clientUuid ?? randomBytes(8).toString("hex");
    const signalingSessionId = createMeariSignalingSessionId();
    const sessionPrefix = randomBytes(4).toString("hex");
    const tag = `${sessionPrefix}01`;
    this.releaseTag = this.runtime.relay.authorizeTag(tag);
    const turnCredential = this.runtime.turn.issueCredential();
    this.releaseTurnCredential = turnCredential.release;
    const webRtcContact = {
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
        relayIp: this.runtime.advertisedHost,
        relayPort: address.port,
        mappedIp: this.runtime.advertisedHost,
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
        coturn_host: "usce.mearicloud.com",
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
      const candidate = selectMeariPeerCandidate(candidates, authorization.sourceAddress);
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
      this.negotiated = { answer, authorization, candidate, offer, sessionPrefix };
      this.target = { ip: candidate.ip, port: candidate.port };
      return await this.startTransport(timestamp, transportTimeoutMs);
    } catch (error) {
      await this.cleanupConnection();
      throw error;
    }
  }

  private async startTransport(
    timestamp: string,
    timeoutMs: number,
  ): Promise<ParsedVvpPlaybackResponse> {
    const socket = this.socket;
    const negotiated = this.negotiated;
    const target = this.target;
    const peerAuth = negotiated?.authorization.peer;
    if (!socket || !negotiated || !target || !peerAuth) {
      throw new Error("Local playback negotiation is incomplete");
    }

    let settled = false;
    let resolveResponse!: (response: ParsedVvpPlaybackResponse) => void;
    let rejectResponse!: (error: Error) => void;
    const responsePromise = new Promise<ParsedVvpPlaybackResponse>((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    this.responseReject = (error) => {
      if (settled) return;
      settled = true;
      rejectResponse(error);
    };
    const fail = (error: Error): void => this.responseReject?.(error);

    const peer = new MeariPeerCommandSession({
      hostKey: peerAuth.hostKey,
      protocolVersion: peerAuth.protocolVersion,
      licenceId: peerAuth.licenceId,
      send: (datagram) => {
        const destination = this.replyTarget ?? this.target;
        if (!destination) return fail(new Error("Local playback lost its peer target"));
        socket.send(datagram, destination.port, destination.ip, (error) => {
          if (error) fail(error);
        });
      },
    });
    this.peer = peer;
    this.mediaFramer = new VvpMediaStreamFramer({
      protocolVersion: peerAuth.protocolVersion,
    });

    const beginSession = (): void => {
      this.sessionStartTimer = undefined;
      if (this.sessionStarted || settled) return;
      this.sessionStarted = true;
      this.stopIceTimers();
      this.onEvent?.({ type: "transport-started" });
      peer.sendLanConnect(negotiated.sessionPrefix);
      peer.start();
      this.sendControl("start", timestamp);
    };
    const maybeBeginSession = (): void => {
      if (
        this.sessionStarted
        || this.sessionStartTimer
        || !this.cameraIceCheckObserved
        || !this.clientIceReadyObserved
        || settled
      ) return;
      this.sessionStartTimer = setTimeout(beginSession, 750);
    };

    this.messageHandler = (datagram, source) => {
      const sourceAddress = normalizedAddress(source.address);
      const fromLocalRelay = sourceAddress === this.runtime.advertisedHost
        && source.port === this.runtime.turn.port;
      const fromAuthorizedCamera = sourceAddress === negotiated.authorization.sourceAddress;
      if (!fromLocalRelay && !fromAuthorizedCamera) return;
      const incomingTarget = { ip: sourceAddress, port: source.port };
      if (
        this.transportTarget
        && !sameTarget(this.transportTarget, incomingTarget)
        && isMeariTransportDatagram(datagram)
      ) return;
      this.replyTarget = incomingTarget;
      try {
        const events = peer.processDatagram(datagram);
        for (const event of events) {
          if (event.type === "ice-check") {
            this.cameraIcePort = source.port;
            if (!this.cameraIceCheckObserved) this.onEvent?.({
              type: "camera-ice-ready",
              matchesSignaledCandidate: source.port === negotiated.candidate.port,
            });
            this.cameraIceCheckObserved = true;
          } else if (event.type === "ice-ready") {
            if (!this.transportTarget) this.target = incomingTarget;
            if (!this.clientIceReadyObserved) this.onEvent?.({
              type: "client-ice-ready",
              matchesCameraCheck: source.port === this.cameraIcePort,
              matchesSignaledCandidate: source.port === negotiated.candidate.port,
            });
            this.clientIceReadyObserved = true;
          } else if (event.type === "unmatched-command" && event.frame.command === VVP_PLAYBACK_RESPONSE) {
            if (event.frame.payloadLength !== VVP_PLAYBACK_RESPONSE_SIZE) {
              throw new Error("Camera returned a malformed playback response");
            }
            const values = [
              event.frame.payload.readInt32LE(0),
              event.frame.payload.readInt32LE(4),
              event.frame.payload.readInt32LE(8),
            ] as const;
            const response: ParsedVvpPlaybackResponse = {
              sequence: event.frame.sequence,
              values,
              result: values[1],
              payload: event.frame.payload,
            };
            this.active = response.result !== -14 && response.result !== -1;
            if (!settled) {
              settled = true;
              if (this.startupTimeoutTimer) clearTimeout(this.startupTimeoutTimer);
              this.startupTimeoutTimer = undefined;
              this.responseReject = undefined;
              this.onEvent?.({ type: "response", response });
              resolveResponse(response);
            }
          } else if (event.type === "transport") {
            const transport = event.event;
            if (
              !this.transportTarget
              && (transport.type === "handshake" || transport.type === "data" || transport.type === "raw")
            ) this.transportTarget = incomingTarget;
            if (this.transportTarget) this.target = this.transportTarget;
            if (!this.sessionStarted && (
              transport.type === "handshake" || transport.type === "data" || transport.type === "raw"
            )) {
              if (this.sessionStartTimer) clearTimeout(this.sessionStartTimer);
              this.sessionStartTimer = undefined;
              beginSession();
            }
            if (this.sessionStarted && this.punchTimer) {
              clearInterval(this.punchTimer);
              this.punchTimer = undefined;
            }
            const sequence = transport.type === "ack" ? transport.sequence : undefined;
            this.onEvent?.({
              type: "transport",
              event: transport.type,
              ...(sequence === undefined ? {} : { sequence }),
            });
            if (
              this.startControlSent
              && (transport.type === "data" || transport.type === "raw")
              && !(transport.payload.byteLength >= 4 && transport.payload.readUInt32BE(0) === 0x5656_5099)
            ) {
              try {
                if (isXtsMediaMessage(transport.payload)) {
                  if (xtsMediaType(transport.payload) !== XTS_MEDIA_TYPE_INFO) {
                    // XTS media layout is negotiated independently of the VVP
                    // command protocol version. Validate both native layouts
                    // against this complete KCP message instead of assuming
                    // protocol 6 implies a 44-byte media header.
                    const frame = decodeXtsMediaFrame(transport.payload);
                    this.onEvent?.({ type: "media", frame, payload: frame.payload });
                  }
                } else {
                  for (const frame of this.mediaFramer?.push(transport.payload) ?? []) {
                    this.onEvent?.({ type: "media", frame, payload: frame.payload });
                  }
                }
              } catch (error) {
                this.mediaFramer?.reset();
                this.onEvent?.({
                  type: "media-error",
                  message: error instanceof Error ? error.message : String(error),
                });
              }
            }
          }
        }
        while (peer.tunnel.pollMessage()) {
          // Events above already delivered each message; keep the transport queue bounded.
        }
        maybeBeginSession();
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      } finally {
        this.replyTarget = undefined;
      }
    };
    this.errorHandler = (error) => fail(error);
    socket.on("message", this.messageHandler);
    socket.on("error", this.errorHandler);

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
    this.punchTimer = setInterval(sendPunch, 500);
    this.iceTimer = setInterval(sendIce, 30);
    this.retransmitTimer = setInterval(() => {
      if (this.sessionStarted) peer.retransmitUnacknowledged();
    }, 220);
    this.startupTimeoutTimer = setTimeout(() => fail(new Error(
      `Local playback timed out (camera ICE=${this.cameraIceCheckObserved}; client ICE=${this.clientIceReadyObserved}; start=${this.startControlSent})`,
    )), timeoutMs);
    sendPunch();
    sendIce();
    return await responsePromise;
  }

  private stopIceTimers(): void {
    if (this.punchTimer) clearInterval(this.punchTimer);
    if (this.iceTimer) clearInterval(this.iceTimer);
    if (this.sessionStartTimer) clearTimeout(this.sessionStartTimer);
    this.punchTimer = undefined;
    this.iceTimer = undefined;
    this.sessionStartTimer = undefined;
  }

  private sendControl(
    command: "start" | "stop" | "pause" | "resume" | "seek",
    timestamp?: string,
  ): void {
    const peer = this.peer;
    const peerAuth = this.negotiated?.authorization.peer;
    if (!peer || !peerAuth || !this.sessionStarted) {
      throw new Error("Local playback transport is not active");
    }
    if (command !== "start" && command !== "stop" && !this.active) {
      throw new Error("Local playback is not active");
    }
    const controlSequence = this.controlSequence;
    this.controlSequence = (this.controlSequence + 1) >>> 0;
    const auth = {
      hostKey: peerAuth.hostKey,
      protocolVersion: peerAuth.protocolVersion,
      licenceId: peerAuth.licenceId,
      sequence: controlSequence,
      videoId: this.videoId,
    };
    const frame = command === "start"
      ? encodeVvpPlaybackStartFrame(timestamp ?? "", auth)
      : command === "stop"
        ? encodeVvpPlaybackStopFrame(auth)
        : command === "pause"
          ? encodeVvpPlaybackPauseFrame(auth)
          : command === "resume"
            ? encodeVvpPlaybackResumeFrame(auth)
            : encodeVvpPlaybackSeekFrame(timestamp ?? "", auth);
    const datagrams = peer.tunnel.sendIvaData(frame);
    if (command === "start") this.startControlSent = true;
    this.onEvent?.({
      type: "control-sent",
      command,
      controlSequence,
      kcpSequence: datagrams.at(-1)?.readUInt32LE(12) ?? 0,
    });
  }

  private async finish(): Promise<void> {
    const hadConnection = Boolean(this.starting || this.peer || this.socket);
    if (this.starting) {
      try {
        await this.starting;
      } catch {
        await this.cleanupConnection();
        return;
      }
    }
    if (this.peer && this.sessionStarted && this.startControlSent) {
      try {
        this.sendControl("stop");
        const deadline = Date.now() + 650;
        while (this.peer.tunnel.unacknowledgedSendCount > 0 && Date.now() < deadline) {
          await delay(25);
        }
      } catch {
        // Closing the bounded UDP session still terminates playback locally.
      }
    }
    await this.cleanupConnection();
    if (hadConnection) this.onEvent?.({ type: "stopped" });
  }

  private async cleanupConnection(): Promise<void> {
    this.responseReject?.(new Error("Local playback stopped during startup"));
    this.responseReject = undefined;
    this.stopIceTimers();
    if (this.startupTimeoutTimer) clearTimeout(this.startupTimeoutTimer);
    if (this.retransmitTimer) clearInterval(this.retransmitTimer);
    this.startupTimeoutTimer = undefined;
    this.retransmitTimer = undefined;

    const socket = this.socket;
    if (socket && this.messageHandler) socket.off("message", this.messageHandler);
    if (socket && this.errorHandler) socket.off("error", this.errorHandler);
    this.messageHandler = undefined;
    this.errorHandler = undefined;
    this.socket = undefined;
    if (socket) await closeUdp(socket);
    this.releaseTurnCredential?.();
    this.releaseTag?.();
    this.releaseTurnCredential = undefined;
    this.releaseTag = undefined;
    this.peer = undefined;
    this.target = undefined;
    this.replyTarget = undefined;
    this.transportTarget = undefined;
    this.negotiated = undefined;
    this.cameraIceCheckObserved = false;
    this.clientIceReadyObserved = false;
    this.cameraIcePort = undefined;
    this.sessionStarted = false;
    this.startControlSent = false;
    this.active = false;
    this.controlSequence = 0;
    this.videoId = 0;
    this.mediaFramer = undefined;
  }
}
