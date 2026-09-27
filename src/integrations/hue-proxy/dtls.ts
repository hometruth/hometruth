import type { Subprocess } from "bun";

export class DtlsEndpoint {
  private process: Subprocess<"pipe", "pipe", "pipe">;
  private stopped = false;
  private readyResolve!: () => void;
  private connectedResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private connectedReject!: (error: Error) => void;
  readonly ready = new Promise<void>((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
  readonly connected = new Promise<void>((resolve, reject) => { this.connectedResolve = resolve; this.connectedReject = reject; });
  readonly finished: Promise<void>;
  /** The DTLS cipher the peer negotiated, once connected. */
  cipher: string | undefined;
  constructor(options: { helperPath: string; mode: "server" | "client"; host: string; port: number; identity: string; key: string; frame: (frame: Buffer) => void; closed: (reason?: string) => void }) {
    if (!/^[a-f\d]{32}$/iu.test(options.key) || !options.identity || options.identity.length > 256 || /[\r\n\0]/u.test(options.identity)) throw new Error("Invalid DTLS credentials");
    this.ready.catch(() => undefined); this.connected.catch(() => undefined);
    const subprocess = Bun.spawn([options.helperPath, options.mode, options.host, String(options.port)], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    this.process = subprocess;
    this.process.stdin.write(`${options.identity}\n${options.key}\n`);
    this.process.stdin.flush();
    // Helper errors are fixed stage names; never forward external payloads.
    const drainErrors = new Response(this.process.stderr).text();
    this.finished = (async () => {
      try {
        const reader = subprocess.stdout.getReader();
        let pending = "";
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            pending += decoder.decode(value, { stream: true });
            if (pending.length > 262144) throw new Error("DTLS helper output exceeds limit");
            let index: number;
            while ((index = pending.indexOf("\n")) !== -1) {
              const message = JSON.parse(pending.slice(0, index)); pending = pending.slice(index + 1);
              if (message.type === "ready") this.readyResolve();
              if (message.type === "connected") { if (typeof message.cipher === "string") this.cipher = message.cipher; this.connectedResolve(); }
              if (message.type === "frame" && typeof message.hex === "string") options.frame(Buffer.from(message.hex, "hex"));
            }
          }
        } finally { reader.releaseLock(); }
      } finally {
        subprocess.kill();
        await subprocess.exited;
        // The helper's last line is a fixed stage name (never an external payload); it says how far the handshake got.
        const stage = (await drainErrors).trim().split("\n").filter(Boolean).pop();
        const error = new Error("DTLS endpoint closed; check port availability, pairing key and bridge connectivity");
        this.readyReject(error); this.connectedReject(error);
        if (!this.stopped) options.closed(stage);
      }
    })();
    this.finished.catch(() => undefined);
  }
  send(frame: Uint8Array): void {
    if (this.stopped) return;
    if (!frame.length || frame.length > 16384) throw new Error("DTLS record exceeds limit");
    const packet = Buffer.alloc(4 + frame.length);
    packet.writeUInt32BE(frame.length); packet.set(frame, 4);
    this.process.stdin.write(packet);
    this.process.stdin.flush();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.process.kill();
    await this.finished.catch(() => undefined);
  }
}
