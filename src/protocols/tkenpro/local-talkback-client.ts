import { randomBytes } from "node:crypto";
import { createSocket, type RemoteInfo, type Socket } from "node:dgram";
import type { MeariLocalCameraAuthorization } from "./local-cloud-auth.ts";
import type { MeariLocalCloudRuntime } from "./local-cloud-runtime.ts";
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
  meariPeerCandidates,
  selectMeariPeerCandidate,
} from "./local-peer-client.ts";
import {
  decodeVvpCommandFrame,
  parseMeariHttpResponse,
  VVP_COMMAND_RESPONSE,
} from "./p2p-command.ts";

/** VVP command frames begin with the wire magic 0x56565099 ("VVP\x99"). */
function looksLikeVvpFrame(payload: Buffer): boolean {
  return payload.byteLength >= 4 && payload.readUInt32BE(0) === 0x5656_5099;
}
import {
  encodeVvpStreamControlFrame,
  VVP_STREAM_AUTO_ID,
  VVP_STREAM_START_LIVE,
  VVP_STREAM_START_VOICE,
  VVP_STREAM_STOP_LIVE,
  VVP_STREAM_STOP_VOICE,
  VVP_STREAM_VOICE_CHANNEL,
} from "./vvp-stream.ts";
import {
  encodeVvpFactory10VoicePacket,
  VVP_FACTORY10_VOICE_BITRATE,
  VVP_FACTORY10_VOICE_MAX_SAMPLES,
  VVP_FACTORY10_VOICE_SAMPLE_RATE,
  VVP_VOICE_MODE,
} from "./vvp-voice.ts";

/**
 * Codec token for the POST /devices/voicetalk speaker open. CloudEdge's native
 * writer defaults the audio type to A_G711U (G.711 µ-law); the exact JSON token
 * the firmware expects was not fully resolved from the binary, so this is
 * overridable while we confirm audible rendering. Common Meari values are
 * "g711u"/"G711U"/"pcm_mulaw".
 */
function resolveVoicetalkCodec(): string {
  const override = process.env.HOMETRUTH_VOICETALK_CODEC?.trim();
  return override && override.length > 0 ? override : "g711u";
}
import type { ParsedVvpMediaFrame } from "./vvp-media.ts";
import {
  decodeXtsMediaFrame,
  isXtsMediaMessage,
  XTS_MEDIA_TYPE_INFO,
  xtsMediaType,
} from "./xts-media.ts";
import {
  deriveXtsTransportKey,
  encryptXtsTransportMessage,
  resolveXtsTransportKeySource,
} from "./xts-transport-crypto.ts";

export interface MeariLocalTalkbackStartOptions {
  /** Complete offer/answer and candidate signaling within this period. */
  readonly signalingTimeoutMs?: number;
  /** Complete ICE, KCP, live-session, and voice startup within this period. */
  readonly transportTimeoutMs?: number;
}

export interface MeariLocalTalkbackClientOptions {
  readonly runtime: MeariLocalCloudRuntime;
  readonly uuid: string;
  /** Live-stream ID used to establish the authenticated camera context. */
  readonly streamId?: number;
  /** Device capability byte copied into START_LIVE byte 57. */
  readonly streamFlag?: number;
  /** Device mode flags copied into START_LIVE byte 58. */
  readonly streamReserve?: number;
  readonly onEvent?: (event: MeariLocalTalkbackEvent) => void;
  /** Receives complete raw camera media messages for protocol diagnostics. */
  readonly onRawMedia?: (message: Buffer) => void;
}

export type MeariLocalTalkbackEvent =
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
  | { readonly type: "voicetalk-open-sent" }
  | { readonly type: "voicetalk-response"; readonly status: number; readonly bodyText: string }
  | {
    readonly type: "transport";
    readonly event: string;
    readonly sequence?: number;
    readonly payloadBytes?: number;
  }
  | {
    readonly type: "control-sent";
    readonly command: "start-live" | "start-voice" | "stop-voice" | "stop-live";
    readonly controlSequence: number;
    readonly kcpSequence: number;
  }
  | { readonly type: "voice-response"; readonly status: number; readonly payloadBytes: number }
  | { readonly type: "ready"; readonly mode: number }
  | {
    readonly type: "media";
    readonly frame: ParsedVvpMediaFrame;
    readonly payload: Buffer;
  }
  | { readonly type: "media-error"; readonly message: string }
  | { readonly type: "voice-sent"; readonly sequence: number; readonly samples: number }
  | { readonly type: "stopped" };

interface NegotiatedTalkbackPeer {
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

function assertByte(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new RangeError(`${name} must be between 0 and 255`);
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

function voiceMode(payload: Buffer): number | undefined {
  if (payload.byteLength < 18 || payload[16] !== 0xfa) return undefined;
  const legacyMode = payload.readUInt8(17);
  if (legacyMode > 0) return legacyMode;
  if (payload.byteLength >= 24) {
    const modernMode = payload.readUInt32LE(20);
    if (modernMode > 0 && modernMode <= 0xff) return modernMode;
  }
  return undefined;
}

/** Some native startVoice sessions return an eight-byte IVA result whose first
 * word is the device result code. Keep this separate from KCP ACKs when it is
 * present; other firmware sessions use delivery acknowledgement only. */
function voiceStartResponseStatus(payload: Buffer): number | undefined {
  return payload.byteLength === 8 ? payload.readInt32LE(0) : undefined;
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
 * Authenticated, cloud-free CloudEdge-compatible push-to-talk session.
 *
 * The camera expects talkback to be opened on an already initialized
 * factory-10 CameraPlayer session. This client reproduces that native order:
 * ICE, KCP handshake, START_LIVE, START_VOICE on logical channel 3, and
 * factory-10 XTS/PCMU voice messages on the media transport. The START
 * controls use IVA; the audio packets themselves are not IVA-wrapped.
 */
export class MeariLocalTalkbackClient {
  readonly runtime: MeariLocalCloudRuntime;
  readonly uuid: string;

  private readonly onEvent: ((event: MeariLocalTalkbackEvent) => void) | undefined;
  private readonly onRawMedia: ((message: Buffer) => void) | undefined;
  private readonly streamId: number;
  private readonly streamFlag: number;
  private readonly streamReserve: number;
  private closed = false;
  private starting: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  private preparedSocket: Socket | undefined;
  private socket: Socket | undefined;
  private peer: MeariPeerCommandSession | undefined;
  private target: PeerTarget | undefined;
  private replyTarget: PeerTarget | undefined;
  private transportTarget: PeerTarget | undefined;
  private negotiated: NegotiatedTalkbackPeer | undefined;
  private releaseTag: (() => void) | undefined;
  private releaseTurnCredential: (() => void) | undefined;
  private messageHandler: ((datagram: Buffer, source: RemoteInfo) => void) | undefined;
  private errorHandler: ((error: Error) => void) | undefined;
  private punchTimer: ReturnType<typeof setInterval> | undefined;
  private iceTimer: ReturnType<typeof setInterval> | undefined;
  private retransmitTimer: ReturnType<typeof setInterval> | undefined;
  private sessionStartTimer: ReturnType<typeof setTimeout> | undefined;
  private voiceStartTimer: ReturnType<typeof setTimeout> | undefined;
  private startupTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
  private readyReject: ((error: Error) => void) | undefined;
  private cameraIceCheckObserved = false;
  private clientIceReadyObserved = false;
  private cameraIcePort: number | undefined;
  private sessionStarted = false;
  private liveControlSent = false;
  private voiceControlSent = false;
  private voicetalkOpenSent = false;
  private voicetalkOpenPending: (() => void) | undefined;
  private voicetalkFallbackTimer: ReturnType<typeof setTimeout> | undefined;
  private voiceStartAccelerated = false;
  private ready = false;
  private controlSequence = 0;
  private voiceSequence = 0;
  private voiceKcpSequence: number | undefined;
  private xtsTransportKey: Buffer | undefined;
  private mode = VVP_VOICE_MODE;
  private voiceSendTail: Promise<void> = Promise.resolve();
  private voiceGeneration = 0;

  constructor(options: MeariLocalTalkbackClientOptions) {
    if (!options.uuid.trim()) throw new TypeError("uuid is required");
    this.runtime = options.runtime;
    this.uuid = options.uuid;
    this.onEvent = options.onEvent;
    this.onRawMedia = options.onRawMedia;
    this.streamId = options.streamId ?? VVP_STREAM_AUTO_ID;
    this.streamFlag = options.streamFlag ?? 0;
    this.streamReserve = options.streamReserve ?? 0;
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

  get isActive(): boolean {
    return this.ready;
  }

  get negotiatedMode(): number | undefined {
    return this.ready ? this.mode : undefined;
  }

  /** Bind the camera-facing UDP endpoint before peer negotiation starts. */
  async prepare(): Promise<void> {
    if (this.closed) throw new Error("Local talkback client is closed");
    if (!this.preparedSocket) this.preparedSocket = await bindUdp(this.runtime.advertisedHost);
  }

  async start(options: MeariLocalTalkbackStartOptions = {}): Promise<void> {
    if (this.closed) throw new Error("Local talkback client is closed");
    if (this.ready) return;
    if (this.starting) return await this.starting;
    if (this.stopping) await this.stopping;

    const operation = this.open(options);
    this.starting = operation;
    try {
      await operation;
    } finally {
      if (this.starting === operation) this.starting = undefined;
    }
  }

  /** Encode and transmit signed 8 kHz mono PCM through the factory-10 XTS path. */
  sendPcm(pcm: Int16Array): Promise<void> {
    if (pcm.length === 0) return Promise.resolve();
    if (pcm.length > 8_000) throw new RangeError("A talkback write cannot exceed one second of audio");
    const generation = this.voiceGeneration;
    const operation = this.voiceSendTail.then(async () => {
      const peer = this.peer;
      const protocolVersion = this.negotiated?.authorization.peer?.protocolVersion;
      if (!this.ready || !peer || protocolVersion === undefined || generation !== this.voiceGeneration) {
        throw new Error("Local talkback is not active");
      }
      for (let offset = 0; offset < pcm.length; offset += VVP_FACTORY10_VOICE_MAX_SAMPLES) {
        if (!this.ready || this.peer !== peer || generation !== this.voiceGeneration) {
          throw new Error("Local talkback stopped while sending microphone audio");
        }
        const part = pcm.subarray(offset, offset + VVP_FACTORY10_VOICE_MAX_SAMPLES);
        const sequence = this.voiceSequence;
        this.voiceSequence = (this.voiceSequence + 1) >>> 0;
        const message = encodeVvpFactory10VoicePacket({
          sequence,
          pcm: part,
          protocolVersion,
          channel: VVP_STREAM_VOICE_CHANNEL,
        });
        peer.tunnel.sendMessage(
          this.xtsTransportKey
            ? encryptXtsTransportMessage(message, this.xtsTransportKey)
            : message,
        );
        this.onEvent?.({ type: "voice-sent", sequence, samples: part.length });
        // Native UtilRecord produces one 320-sample/40 ms block at a time.
        // Preserve that cadence so the camera's decoder is not flooded by a
        // browser or API client that submits a larger buffer in one request.
        await delay(40);
      }
    });
    this.voiceSendTail = operation.catch(() => {});
    return operation;
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

  private async open(options: MeariLocalTalkbackStartOptions): Promise<void> {
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
      await this.startTransport(transportTimeoutMs);
    } catch (error) {
      await this.cleanupConnection();
      throw error;
    }
  }

  private async startTransport(timeoutMs: number): Promise<void> {
    const socket = this.socket;
    const negotiated = this.negotiated;
    const target = this.target;
    const peerAuth = negotiated?.authorization.peer;
    if (!socket || !negotiated || !target || !peerAuth) {
      throw new Error("Local talkback negotiation is incomplete");
    }

    let settled = false;
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    this.readyReject = (error) => {
      if (settled) return;
      settled = true;
      rejectReady(error);
    };
    const fail = (error: Error): void => this.readyReject?.(error);
    const markReady = (mode = this.mode): void => {
      if (settled) return;
      settled = true;
      this.ready = true;
      this.mode = mode;
      this.stopIceTimers();
      if (this.startupTimeoutTimer) clearTimeout(this.startupTimeoutTimer);
      this.startupTimeoutTimer = undefined;
      this.readyReject = undefined;
      this.onEvent?.({ type: "ready", mode });
      resolveReady();
    };

    const peer = new MeariPeerCommandSession({
      hostKey: peerAuth.hostKey,
      protocolVersion: peerAuth.protocolVersion,
      licenceId: peerAuth.licenceId,
      send: (datagram) => {
        const destination = this.replyTarget ?? this.target;
        if (!destination) return fail(new Error("Local talkback lost its peer target"));
        socket.send(datagram, destination.port, destination.ip, (error) => {
          if (error) fail(error);
        });
      },
    });
    this.peer = peer;
    this.xtsTransportKey = deriveXtsTransportKey(resolveXtsTransportKeySource());

    const sendControl = (
      command: number,
      name: "start-live" | "start-voice" | "stop-voice" | "stop-live",
    ): number => {
      const controlSequence = this.controlSequence;
      this.controlSequence = (this.controlSequence + 1) >>> 0;
      const voice = command === VVP_STREAM_START_VOICE;
      const live = command === VVP_STREAM_START_LIVE || command === VVP_STREAM_STOP_LIVE;
      const datagrams = peer.tunnel.sendIvaData(encodeVvpStreamControlFrame({
        hostKey: peerAuth.hostKey,
        licenceId: peerAuth.licenceId,
        sequence: controlSequence,
        command,
        channel: voice ? VVP_STREAM_VOICE_CHANNEL : 0,
        streamId: live ? this.streamId : 0,
        streamFlag: live ? this.streamFlag : 0,
        reserve: live ? this.streamReserve : 0,
      }));
      const kcpSequence = datagrams.at(-1)?.readUInt32LE(12) ?? 0;
      this.onEvent?.({ type: "control-sent", command: name, controlSequence, kcpSequence });
      return kcpSequence;
    };
    const sendVoiceControl = (): void => {
      if (this.voiceControlSent || !this.sessionStarted) return;
      this.voiceControlSent = true;
      this.voiceKcpSequence = sendControl(VVP_STREAM_START_VOICE, "start-voice");
    };
    const scheduleVoiceControl = (milliseconds: number): void => {
      if (this.voiceControlSent || this.voiceStartTimer) return;
      this.voiceStartTimer = setTimeout(() => {
        this.voiceStartTimer = undefined;
        try {
          sendVoiceControl();
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      }, milliseconds);
    };
    // Native CloudEdge opens the camera's speaker device with a
    // POST /devices/voicetalk BEFORE it streams any audio (see
    // libmrplayer FUN_0030efd4 building "videoid/samplerate/bitrate/
    // channels/codec"). Without this the firmware's ppsdev_voicetalk_open
    // is never called, so the decoder is not initialised and every XTS
    // audio frame is dropped — which is why byte-perfect frames stayed
    // silent. The audio params match our 8 kHz mono G.711 µ-law writer.
    const sendVoicetalkOpen = (): void => {
      if (this.voicetalkOpenSent) return;
      this.voicetalkOpenSent = true;
      try {
        this.onEvent?.({ type: "voicetalk-open-sent" });
        peer.sendCommonRequest({
          action: "POST",
          deviceurl: "/devices/voicetalk",
          videoid: this.streamId,
          samplerate: VVP_FACTORY10_VOICE_SAMPLE_RATE,
          bitrate: VVP_FACTORY10_VOICE_BITRATE,
          channels: 1,
          codec: resolveVoicetalkCodec(),
        });
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const beginSession = (): void => {
      if (this.sessionStarted || settled) return;
      this.sessionStarted = true;
      this.stopIceTimers();
      this.onEvent?.({ type: "transport-started" });
      peer.sendLanConnect(negotiated.sessionPrefix);
      peer.start();
      this.liveControlSent = true;
      sendControl(VVP_STREAM_START_LIVE, "start-live");
      // The native app opens /devices/voicetalk from an already-running
      // CameraPlayer with live video FLOWING (its videoid/params come from the
      // active stream). Sending it before the stream is up returned HTTP 500,
      // so defer the speaker-open until the first media frame arrives (see the
      // media handler). Fall back to a timer if no media is seen.
      this.voicetalkOpenPending = sendVoicetalkOpen;
      if (this.voicetalkFallbackTimer) clearTimeout(this.voicetalkFallbackTimer);
      this.voicetalkFallbackTimer = setTimeout(() => {
        this.voicetalkFallbackTimer = undefined;
        this.voicetalkOpenPending = undefined;
        sendVoicetalkOpen();
      }, 900);
      // Native talkback is opened from an already-running CameraPlayer. Give
      // START_LIVE a brief head start, with ACK/data paths able to accelerate it.
      scheduleVoiceControl(700);
    };
    const maybeBeginSession = (): void => {
      if (
        this.sessionStarted
        || this.sessionStartTimer
        || !this.cameraIceCheckObserved
        || !this.clientIceReadyObserved
        || settled
      ) return;
      this.sessionStartTimer = setTimeout(() => {
        this.sessionStartTimer = undefined;
        try {
          beginSession();
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      }, 750);
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
          } else if (event.type === "transport") {
            const transport = event.event;
            // Surface the camera's reply to POST /devices/voicetalk so we can
            // tell whether the speaker device opened (200) or was rejected.
            if (this.voicetalkOpenSent && transport.type === "data" && looksLikeVvpFrame(transport.payload)) {
              try {
                const frame = decodeVvpCommandFrame(transport.payload);
                if (frame.command === VVP_COMMAND_RESPONSE) {
                  const http = parseMeariHttpResponse(frame.payload);
                  this.onEvent?.({ type: "voicetalk-response", status: http.status, bodyText: http.bodyText.slice(0, 200) });
                }
              } catch { /* Not a command response; ignore. */ }
            }
            if (this.voiceControlSent && transport.type === "data") {
              const status = voiceStartResponseStatus(transport.payload);
              if (status !== undefined) {
                this.onEvent?.({
                  type: "voice-response",
                  status,
                  payloadBytes: transport.payload.byteLength,
                });
                if (status !== 0) {
                  fail(new Error(`Camera rejected local talkback (status ${status})`));
                  continue;
                }
                markReady();
                continue;
              }
            }
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
              ...((transport.type === "data" || transport.type === "raw")
                ? { payloadBytes: transport.payload.byteLength }
                : {}),
            });
            if (this.liveControlSent && !this.voiceControlSent && !this.voiceStartAccelerated && (
              transport.type === "handshake"
              || transport.type === "data"
              || transport.type === "raw"
              || (transport.type === "ack" && transport.sequence >= 1)
            )) {
              // Pull the START_VOICE head start in to 120 ms once the camera is
              // talking to us — but only once. Live media arrives every ~40 ms,
              // so re-arming the timer on every datagram starved it forever and
              // START_VOICE was never sent (talkback timed out with voice=false).
              this.voiceStartAccelerated = true;
              if (this.voiceStartTimer) clearTimeout(this.voiceStartTimer);
              this.voiceStartTimer = undefined;
              scheduleVoiceControl(120);
            }
            if (transport.type === "raw") {
              if (isXtsMediaMessage(transport.payload)) this.onRawMedia?.(transport.payload);
              const reportedMode = voiceMode(transport.payload);
              if (reportedMode !== undefined) {
                this.mode = reportedMode;
                if (this.voiceControlSent) markReady(reportedMode);
              }
              if (
                isXtsMediaMessage(transport.payload)
                && xtsMediaType(transport.payload) !== XTS_MEDIA_TYPE_INFO
              ) {
                try {
                  // XTS media layout is a separate native-session flag, not
                  // the advertised VVP command protocol version.
                  const frame = decodeXtsMediaFrame(transport.payload);
                  this.onEvent?.({ type: "media", frame, payload: frame.payload });
                  // Live media is now flowing — the CameraPlayer is running, so
                  // open the speaker device now (native precondition for
                  // /devices/voicetalk to succeed rather than return 500).
                  if (this.voicetalkOpenPending) {
                    const open = this.voicetalkOpenPending;
                    this.voicetalkOpenPending = undefined;
                    if (this.voicetalkFallbackTimer) { clearTimeout(this.voicetalkFallbackTimer); this.voicetalkFallbackTimer = undefined; }
                    open();
                  }
                } catch (error) {
                  this.onEvent?.({
                    type: "media-error",
                    message: error instanceof Error ? error.message : String(error),
                  });
                }
              }
            }
            if (
              this.voiceControlSent
              && transport.type === "ack"
              && this.voiceKcpSequence !== undefined
              && transport.sequence >= this.voiceKcpSequence
            ) markReady();
            // Native sessions with the response-wait flag clear expose only
            // successful KCP delivery as the voice-start result.
            if (this.voiceControlSent && peer.tunnel.unacknowledgedSendCount === 0) markReady();
          }
        }
        while (peer.tunnel.pollMessage()) {
          // Events above contain the same data; do not retain a duplicate media queue.
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
      `Local talkback timed out (camera ICE=${this.cameraIceCheckObserved}; client ICE=${this.clientIceReadyObserved}; live=${this.liveControlSent}; voice=${this.voiceControlSent})`,
    )), timeoutMs);
    sendPunch();
    sendIce();
    await readyPromise;
  }

  private stopIceTimers(): void {
    if (this.punchTimer) clearInterval(this.punchTimer);
    if (this.iceTimer) clearInterval(this.iceTimer);
    if (this.sessionStartTimer) clearTimeout(this.sessionStartTimer);
    this.punchTimer = undefined;
    this.iceTimer = undefined;
    this.sessionStartTimer = undefined;
  }

  private async finish(): Promise<void> {
    this.voiceGeneration += 1;
    const hadConnection = Boolean(this.starting || this.peer || this.socket);
    if (this.starting) {
      try {
        await this.starting;
      } catch {
        await this.cleanupConnection();
        return;
      }
    }
    const peer = this.peer;
    const peerAuth = this.negotiated?.authorization.peer;
    if (peer && peerAuth && this.sessionStarted) {
      const sendControl = (
        command: number,
        name: "stop-voice" | "stop-live",
        streamId: number,
      ): void => {
        const controlSequence = this.controlSequence;
        this.controlSequence = (this.controlSequence + 1) >>> 0;
        const datagrams = peer.tunnel.sendIvaData(encodeVvpStreamControlFrame({
          hostKey: peerAuth.hostKey,
          licenceId: peerAuth.licenceId,
          sequence: controlSequence,
          command,
          channel: 0,
          streamId,
          streamFlag: streamId ? this.streamFlag : 0,
          reserve: streamId ? this.streamReserve : 0,
        }));
        this.onEvent?.({
          type: "control-sent",
          command: name,
          controlSequence,
          kcpSequence: datagrams.at(-1)?.readUInt32LE(12) ?? 0,
        });
      };
      try {
        if (this.voiceControlSent) sendControl(VVP_STREAM_STOP_VOICE, "stop-voice", 0);
        await delay(80);
        if (this.liveControlSent) sendControl(VVP_STREAM_STOP_LIVE, "stop-live", this.streamId);
        const deadline = Date.now() + 650;
        while (peer.tunnel.unacknowledgedSendCount > 0 && Date.now() < deadline) {
          await delay(25);
        }
      } catch {
        // Socket cleanup below still terminates the bounded local session.
      }
    }
    await this.cleanupConnection();
    if (hadConnection) this.onEvent?.({ type: "stopped" });
  }

  private async cleanupConnection(): Promise<void> {
    this.readyReject?.(new Error("Local talkback stopped during startup"));
    this.readyReject = undefined;
    this.stopIceTimers();
    if (this.voiceStartTimer) clearTimeout(this.voiceStartTimer);
    if (this.startupTimeoutTimer) clearTimeout(this.startupTimeoutTimer);
    if (this.retransmitTimer) clearInterval(this.retransmitTimer);
    this.voiceStartTimer = undefined;
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
    this.liveControlSent = false;
    this.voiceControlSent = false;
    this.voiceStartAccelerated = false;
    this.voicetalkOpenSent = false;
    this.voicetalkOpenPending = undefined;
    if (this.voicetalkFallbackTimer) { clearTimeout(this.voicetalkFallbackTimer); this.voicetalkFallbackTimer = undefined; }
    this.ready = false;
    this.controlSequence = 0;
    this.voiceSequence = 0;
    this.voiceKcpSequence = undefined;
    this.xtsTransportKey = undefined;
    this.mode = VVP_VOICE_MODE;
    this.voiceSendTail = Promise.resolve();
  }
}
