import { createHash } from "node:crypto";
import type { FrigateStillsConfig } from "./still-labeler";

export interface DogFrameLabels { dog: boolean; imageHash: string }
export interface DogFrameLabeler {
  label(jpeg: Uint8Array, signal: AbortSignal): Promise<DogFrameLabels>;
  close?(): void;
}
export function parseDogFrameLabels(value: unknown, jpeg: Uint8Array): DogFrameLabels {
  if (!value || typeof value !== "object" || !("dog" in value) || typeof value.dog !== "boolean"
    || !("imageHash" in value) || value.imageHash !== createHash("sha256").update(jpeg).digest("hex")
    || Object.keys(value).some(key => key !== "dog" && key !== "imageHash")) {
    throw new Error("Invalid dog detection response");
  }
  return { dog: value.dog, imageHash: value.imageHash as string };
}

interface FrameProcess {
  stdin: { write(bytes: Uint8Array): number | Promise<number>; flush(): number | Promise<number> };
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}
type Session = { child: FrameProcess; closed: boolean; pending?: {
  jpeg: Uint8Array; resolve(labels: DogFrameLabels): void; reject(error: Error): void;
} };

function launchFrameProcess(config: FrigateStillsConfig): FrameProcess {
  return Bun.spawn(["ssh", "-F", config.sshConfigPath, "-o", "BatchMode=yes", "-o", "ConnectTimeout=5",
    "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=1", config.sshHost,
    `sudo -n docker exec -i ${config.container} python3 /config/hometruth/frame_label.py`],
  { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
}

/** One pipe to the Frigate host while watching: length-prefixed JPEGs in, bounded JSON lines out. */
export class FrigateFrameLabeler implements DogFrameLabeler {
  private session: Session | undefined;
  constructor(config: FrigateStillsConfig, private readonly launch: () => FrameProcess = () => launchFrameProcess(config)) {}

  async label(jpeg: Uint8Array, signal: AbortSignal): Promise<DogFrameLabels> {
    signal.throwIfAborted();
    if (!jpeg.length || jpeg.length > 8 * 1024 * 1024) throw new Error("Invalid camera frame size");
    if (this.session?.pending) throw new Error("A Frigate frame check is already running");
    const session = this.session ??= this.open();
    const reply = Promise.withResolvers<DogFrameLabels>();
    session.pending = { jpeg, resolve: reply.resolve, reject: reply.reject };
    const abort = () => this.closeSession(session, new Error("Frigate frame check cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => this.closeSession(session, new Error("Frigate frame detection timed out")), 5000);
    void (async () => {
      const header = Buffer.alloc(4); header.writeUInt32BE(jpeg.length);
      await session.child.stdin.write(header);
      await session.child.stdin.write(jpeg);
      // A write failure must reject the reply too; never leave an unhandled rejection.
      await session.child.stdin.flush();
    })().catch(() => this.closeSession(session));
    try { return await reply.promise; }
    finally { clearTimeout(timeout); signal.removeEventListener("abort", abort); }
  }

  private open(): Session {
    const session: Session = { child: this.launch(), closed: false };
    void this.read(session);
    void session.child.exited.then(() => this.closeSession(session));
    return session;
  }
  private async read(session: Session) {
    const reader = session.child.stdout.getReader();
    let bytes = Buffer.alloc(0);
    try {
      while (!session.closed) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes = Buffer.concat([bytes, chunk.value]);
        if (bytes.length > 65_536) throw Error("Invalid frame response size");
        const newline = bytes.indexOf(10);
        if (newline < 0) continue;
        const pending = session.pending;
        if (!pending || newline !== bytes.length - 1) throw Error("Unexpected frame response");
        const labels = parseDogFrameLabels(JSON.parse(bytes.subarray(0, newline).toString("utf8")), pending.jpeg);
        delete session.pending;
        bytes = Buffer.alloc(0);
        pending.resolve(labels);
      }
    } catch { /* Responses and SSH diagnostics must not leak private connection information. */ }
    finally { this.closeSession(session); await reader.cancel().catch(() => undefined); }
  }
  private closeSession(session: Session, error = new Error("The Frigate frame detector is unavailable")) {
    if (session.closed) return;
    session.closed = true;
    if (this.session === session) this.session = undefined;
    session.pending?.reject(error);
    delete session.pending;
    try { session.child.kill(); } catch { /* Already exited. */ }
  }
  close() { if (this.session) this.closeSession(this.session); }
}
