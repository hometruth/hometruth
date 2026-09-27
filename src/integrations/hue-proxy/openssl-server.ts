import type { Subprocess } from "bun";

/** Where a Homebrew/system OpenSSL 3 with PSK + DTLS lives; macOS's own is LibreSSL and lacks PSK. */
export function opensslBinary(): string {
  const prefix = process.env.OPENSSL_PREFIX;
  const candidates = [
    ...(prefix ? [`${prefix}/bin/openssl`] : []),
    "/opt/homebrew/opt/openssl@3/bin/openssl", "/opt/homebrew/opt/openssl/bin/openssl",
    "/usr/local/opt/openssl@3/bin/openssl", "/usr/local/opt/openssl/bin/openssl",
  ];
  for (const path of candidates) if (Bun.file(path).size > 0) return path;
  return "openssl";
}

const MAGIC = Buffer.from("HueStream");
const CIPHERS = "PSK-AES128-GCM-SHA256:PSK-AES128-CCM8:PSK-AES128-CCM:@SECLEVEL=0";

/**
 * The TV-facing side of the Entertainment relay, run as `openssl s_server`
 * exactly as diyHue does — not a hand-written DTLS server. A Hue client (a
 * TV's Hue Sync) completes the DTLS-PSK handshake and then streams HueStream
 * frames; stock OpenSSL is the implementation those clients are known to talk
 * to, so the receiver being genuine OpenSSL removes any custom-DTLS behaviour a
 * client might refuse. The decrypted stream arrives on stdout; frames are split
 * on the `HueStream` magic that begins each one and handed on whole.
 */
export class OpensslHueReceiver {
  private readonly process: Subprocess<"pipe", "pipe", "pipe">;
  private stopped = false;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private connectedResolve!: () => void;
  private connectedReject!: (error: Error) => void;
  readonly ready = new Promise<void>((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
  readonly connected = new Promise<void>((resolve, reject) => { this.connectedResolve = resolve; this.connectedReject = reject; });
  readonly finished: Promise<void>;
  cipher: string | undefined;

  constructor(options: { binary?: string; host: string; port: number; identity: string; key: string; frame: (frame: Buffer) => void; closed: (reason?: string) => void }) {
    if (!/^[a-f\d]{32}$/iu.test(options.key) || !options.identity || options.identity.length > 256 || /[\r\n\0]/u.test(options.identity)) throw new Error("Invalid DTLS credentials");
    this.ready.catch(() => undefined); this.connected.catch(() => undefined);
    // -psk takes the clientkey as hex (OpenSSL hex-decodes it); -psk_identity is the hint sent to the client; -listen does the DTLS cookie exchange.
    const proc = Bun.spawn([
      options.binary ?? opensslBinary(), "s_server", "-4", "-dtls1_2", "-listen",
      "-cipher", CIPHERS, "-psk", options.key, "-psk_identity", options.identity,
      "-nocert", "-accept", `${options.host}:${options.port}`,
    ], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    this.process = proc;
    // s_server binds its socket during startup; treat the process being alive briefly as "listening",
    // so the client's first ClientHello (which can arrive the instant the start call returns) is answered.
    const settle = setTimeout(() => { if (!proc.killed) this.readyResolve(); }, 250);
    settle.unref?.();
    // The banner and handshake notes go to stderr; the negotiated cipher line is worth keeping.
    const drainErrors = (async () => {
      let tail = "";
      try {
        const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          tail = (tail + text).slice(-512);
          const cipher = /CIPHER is (\S+)/u.exec(tail)?.[1];
          if (cipher) this.cipher = cipher;
        }
      } catch { /* torn down */ }
      return tail.trim().split("\n").filter(Boolean).pop();
    })();

    this.finished = (async () => {
      try {
        const reader = proc.stdout.getReader();
        let buffer = Buffer.alloc(0);
        let sawMagic = false;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) { if (sawMagic && buffer.length > MAGIC.length && buffer.indexOf(MAGIC) === 0) options.frame(Buffer.from(buffer)); break; }
          buffer = Buffer.concat([buffer, Buffer.from(value)]);
          if (buffer.length > 1 << 20) buffer = buffer.subarray(-(1 << 16));
          // Everything before the first magic is the s_server banner; discard it.
          let start = buffer.indexOf(MAGIC);
          if (start < 0) continue;
          if (!sawMagic) { sawMagic = true; this.readyResolve(); this.connectedResolve(); if (start > 0) buffer = buffer.subarray(start); start = 0; }
          // Each frame begins with the magic; the next magic marks the end of the one before it.
          for (let next = buffer.indexOf(MAGIC, start + MAGIC.length); next >= 0; next = buffer.indexOf(MAGIC, start + MAGIC.length)) {
            options.frame(Buffer.from(buffer.subarray(start, next)));
            start = next;
          }
          buffer = buffer.subarray(start);
        }
      } finally {
        proc.kill();
        await proc.exited;
        const stage = await drainErrors;
        const error = new Error("Entertainment receiver closed");
        this.readyReject(error); this.connectedReject(error);
        if (!this.stopped) options.closed(stage);
      }
    })();
    this.finished.catch(() => undefined);
  }

  /** Frames from the real bridge back to the client. Entertainment is one-way, so nothing is written; kept for interface parity. */
  send(_frame: Uint8Array): void {}

  async stop(): Promise<void> {
    this.stopped = true;
    this.process.kill();
    await this.finished.catch(() => undefined);
  }
}
