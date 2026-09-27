/**
 * Drives the Hue Entertainment DTLS stream for one bridge + one entertainment
 * area, shared by every `HueEntertainmentLight` device that references it
 * (see `models/device.ts`'s `SiteServices`).
 *
 * Uses an OpenSSL subprocess for DTLS-PSK transport; the host must provide
 * an OpenSSL build with the required cipher support. Its stdin carries raw
 * HueStream bytes over the negotiated channel. `-quiet` suppresses the
 * interactive banner so stdout contains only bridge responses.
 *
 * The bridge closes the DTLS listener within roughly a second of `start`ing
 * an entertainment session if no handshake arrives, so `connect()` starts
 * the CLIP session and spawns `openssl` back-to-back with no other work in
 * between.
 */
import { HueClipClient } from "./clip-client";
import { buildHueStreamFrame, HUE_ENTERTAINMENT_CIPHER, HUE_ENTERTAINMENT_PORT, type ChannelColor } from "./entertainment-protocol";

export type HueEntertainmentSessionErrorCode = "handshake_failed" | "not_connected" | "already_connected";

export class HueEntertainmentSessionError extends Error {
  constructor(message: string, readonly code: HueEntertainmentSessionErrorCode) {
    super(message);
    this.name = "HueEntertainmentSessionError";
  }
}

/** The subset of `Bun.spawn`'s result this session needs; narrow enough to fake in tests. */
export interface DtlsSubprocess {
  readonly stdin: { write(data: Uint8Array): number | Promise<number>; flush?(): void } | null;
  readonly exited: Promise<number>;
  kill(signal?: string | number): void;
}

export type DtlsSubprocessSpawner = (args: {
  host: string;
  port: number;
  cipher: string;
  pskIdentity: string;
  pskHex: string;
}) => DtlsSubprocess;

function defaultSpawner({ host, port, cipher, pskIdentity, pskHex }: Parameters<DtlsSubprocessSpawner>[0]): DtlsSubprocess {
  const subprocess = Bun.spawn(
    [
      "openssl", "s_client", "-dtls1_2", "-quiet",
      "-cipher", cipher,
      "-psk", pskHex,
      "-psk_identity", pskIdentity,
      "-connect", `${host}:${port}`,
    ],
    { stdin: "pipe", stdout: "ignore", stderr: "ignore" },
  );
  const stdin = subprocess.stdin;
  if (!stdin || typeof stdin === "number") {
    subprocess.kill();
    throw new HueEntertainmentSessionError("openssl did not accept a writable stdin", "handshake_failed");
  }
  return { stdin, exited: subprocess.exited, kill: (signal) => subprocess.kill(signal as never) };
}

export interface HueEntertainmentSessionOptions {
  readonly host: string;
  readonly applicationKey: string;
  readonly clientKeyHex: string;
  readonly areaId: string;
  /** How often to resend the last frame while idle, so the bridge's own entertainment timeout does not end the session. */
  readonly keepaliveMs?: number;
  readonly clip?: HueClipClient;
  readonly spawn?: DtlsSubprocessSpawner;
}

const DEFAULT_KEEPALIVE_MS = 5_000;
const HANDSHAKE_SETTLE_MS = 300;

/**
 * One DTLS Entertainment stream to one bridge's one entertainment area.
 * `connect()`/`disconnect()` bracket a streaming session; `setColors()`
 * sends one frame carrying every given channel's color, coalescing rapid
 * calls onto whatever the sender loop is doing (never queues more than the
 * latest frame, so a slow consumer sees an up-to-date light, not a backlog).
 */
export class HueEntertainmentSession {
  private readonly clip: HueClipClient;
  private readonly spawn: DtlsSubprocessSpawner;
  private subprocess: DtlsSubprocess | undefined;
  private sequence = 0;
  private lastFrame: Uint8Array | undefined;
  private keepaliveTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: HueEntertainmentSessionOptions) {
    this.clip = options.clip ?? new HueClipClient({ host: options.host, applicationKey: options.applicationKey });
    this.spawn = options.spawn ?? defaultSpawner;
  }

  get isConnected(): boolean {
    return this.subprocess !== undefined;
  }

  async connect(): Promise<void> {
    if (this.subprocess) throw new HueEntertainmentSessionError("Already streaming to this bridge", "already_connected");
    await this.clip.startEntertainment(this.options.areaId);
    const subprocess = this.spawn({
      host: this.options.host,
      port: HUE_ENTERTAINMENT_PORT,
      cipher: HUE_ENTERTAINMENT_CIPHER,
      pskIdentity: this.options.applicationKey,
      pskHex: this.options.clientKeyHex,
    });
    // Give the DTLS handshake a moment to complete before the first frame;
    // openssl buffers writes internally until the handshake finishes, but an
    // immediate exit (bad PSK, unreachable bridge) is easiest to catch here.
    await new Promise((resolve) => setTimeout(resolve, HANDSHAKE_SETTLE_MS));
    this.subprocess = subprocess;
    this.sequence = 0;
    this.lastFrame = undefined;
    this.keepaliveTimer = setInterval(() => {
      if (this.lastFrame) this.writeFrame(this.lastFrame);
    }, this.options.keepaliveMs ?? DEFAULT_KEEPALIVE_MS);
    void subprocess.exited.then(() => {
      if (this.subprocess === subprocess) this.teardown();
    });
  }

  /** Send one frame with the given channels' colors, immediately. */
  setColors(channels: readonly ChannelColor[]): void {
    if (!this.subprocess) throw new HueEntertainmentSessionError("Not streaming; call connect() first", "not_connected");
    this.sequence = (this.sequence + 1) & 0xFF;
    const frame = buildHueStreamFrame(this.options.areaId, this.sequence, channels);
    this.lastFrame = frame;
    this.writeFrame(frame);
  }

  private writeFrame(frame: Uint8Array): void {
    if (!this.subprocess) return;
    try {
      this.subprocess.stdin?.write(frame);
      this.subprocess.stdin?.flush?.();
    } catch {
      // A write to a dead pipe throws; `exited` will observe the process
      // ending and tear the session down. Nothing to do here but drop this frame.
    }
  }

  private teardown(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = undefined;
    this.subprocess = undefined;
  }

  async disconnect(): Promise<void> {
    const subprocess = this.subprocess;
    this.teardown();
    if (subprocess) {
      subprocess.kill();
      await subprocess.exited.catch(() => undefined);
    }
    await this.clip.stopEntertainment(this.options.areaId).catch(() => undefined);
  }
}
