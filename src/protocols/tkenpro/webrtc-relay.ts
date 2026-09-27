import { createServer, type Server, type Socket } from "node:net";
import {
  decodeMsgSvrFrame,
  encodeMsgSvrFrame,
  MSGSVR_COMMANDS,
  MSGSVR_METHODS,
  MSGSVR_NODES,
  splitMsgSvrFrames,
  type MsgSvrFrame,
} from "./msgsvr.ts";

const WEBRTC_RELAY_TYPE = 0xd1;
const WEBRTC_RELAY_PAYLOAD_BYTES = 16;
const WEBRTC_RELAY_TAG_BYTES = 10;
const CONNECT_FLAGS = new Set([0x82, 0x84]);

export interface MeariWebRtcRelayConnect {
  readonly tag: string;
  readonly flags: Buffer;
  readonly frame: MsgSvrFrame;
}

export interface MeariLocalWebRtcRelayServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly allowSourceAddress: (address: string) => boolean;
  readonly onConnect?: (connection: MeariWebRtcRelayConnect) => void;
}

function normalizedAddress(value: string | undefined): string {
  return (value ?? "").replace(/^::ffff:/u, "");
}

function assertPort(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new RangeError("WebRTC relay port must be between 0 and 65535");
  }
}

function writeSocket(socket: Socket, bytes: Uint8Array): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    socket.write(bytes, (error?: Error | null) => error ? reject(error) : resolve());
  });
}

/** Decode the 16-byte native camera-to-WebRTC-server connection ticket. */
export function decodeMeariWebRtcRelayConnect(frame: MsgSvrFrame): MeariWebRtcRelayConnect {
  if (
    frame.node !== MSGSVR_NODES.CAMERA
    || frame.method !== MSGSVR_METHODS.DIRECT
    || frame.command !== MSGSVR_COMMANDS.WEBRTC
    || frame.type !== WEBRTC_RELAY_TYPE
    || frame.encrypted
    || frame.payloadBytes.byteLength !== WEBRTC_RELAY_PAYLOAD_BYTES
  ) {
    throw new Error("Invalid Meari WebRTC relay connection frame");
  }
  const tag = frame.payloadBytes.subarray(0, WEBRTC_RELAY_TAG_BYTES).toString("ascii");
  const flags = Buffer.from(frame.payloadBytes.subarray(WEBRTC_RELAY_TAG_BYTES));
  if (!/^[0-9a-f]{10}$/u.test(tag) || !CONNECT_FLAGS.has(flags[0] ?? -1)) {
    throw new Error("Invalid Meari WebRTC relay connection ticket");
  }
  return { tag, flags, frame };
}

/** Recreate the cloud relay's fixed acceptance frame for an authorized ticket. */
export function encodeMeariWebRtcRelayAccepted(tag: string): Buffer {
  if (!/^[0-9a-f]{10}$/u.test(tag)) {
    throw new TypeError("WebRTC relay tag must be ten lowercase hexadecimal characters");
  }
  return encodeMsgSvrFrame({
    node: MSGSVR_NODES.WEBRTC_SERVER,
    method: MSGSVR_METHODS.DIRECT,
    command: MSGSVR_COMMANDS.WEBRTC,
    type: WEBRTC_RELAY_TYPE,
    payload: Buffer.concat([
      Buffer.from(tag, "ascii"),
      Buffer.from([0x04, 0x01, 0x00, 0x00, 0x00, 0x00]),
    ]),
    encrypted: false,
  });
}

/**
 * Minimal camera-facing WebRTC broker. The native peer stack checks a short
 * TCP ticket before starting ICE, even when the selected media path is direct
 * LAN UDP. Only pre-authorized camera addresses and active one-time tags are
 * accepted.
 */
export class MeariLocalWebRtcRelayServer {
  readonly server: Server;
  private readonly activeTags = new Set<string>();
  private readonly sockets = new Set<Socket>();
  private boundPort = 0;
  private acceptedConnections = 0;

  constructor(readonly options: MeariLocalWebRtcRelayServerOptions) {
    assertPort(options.port ?? 9_371);
    this.server = createServer((socket) => this.accept(socket));
  }

  get port(): number {
    return this.boundPort;
  }

  get acceptedConnectionCount(): number {
    return this.acceptedConnections;
  }

  authorizeTag(tag: string): () => void {
    if (!/^[0-9a-f]{10}$/u.test(tag)) {
      throw new TypeError("WebRTC relay tag must be ten lowercase hexadecimal characters");
    }
    this.activeTags.add(tag);
    return () => this.activeTags.delete(tag);
  }

  private accept(socket: Socket): void {
    const source = normalizedAddress(socket.remoteAddress);
    if (!this.options.allowSourceAddress(source)) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      try {
        const split = splitMsgSvrFrames(Buffer.concat([buffer, chunk]));
        buffer = split.remainder;
        for (const bytes of split.frames) {
          const connection = decodeMeariWebRtcRelayConnect(decodeMsgSvrFrame(bytes));
          if (!this.activeTags.has(connection.tag)) {
            socket.destroy();
            return;
          }
          this.acceptedConnections += 1;
          this.options.onConnect?.(connection);
          void writeSocket(socket, encodeMeariWebRtcRelayAccepted(connection.tag))
            .catch(() => socket.destroy());
        }
      } catch {
        socket.destroy();
      }
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => this.sockets.delete(socket));
  }

  async start(): Promise<number> {
    if (this.server.listening) return this.boundPort;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.server.once("error", onError);
      this.server.listen({
        host: this.options.host ?? "127.0.0.1",
        port: this.options.port ?? 9_371,
      }, () => {
        this.server.off("error", onError);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("WebRTC relay did not expose a TCP port");
    this.boundPort = address.port;
    return this.boundPort;
  }

  async stop(): Promise<void> {
    this.activeTags.clear();
    for (const socket of this.sockets) socket.destroy();
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve());
    });
  }
}
