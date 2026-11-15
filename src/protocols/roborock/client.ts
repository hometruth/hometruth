/**
 * One local session with a Roborock vacuum over TCP 58867: connect, hello,
 * then serialized JSON-RPC calls, with pings while the session is held and
 * an idle close. A failed or timed-out exchange drops the session; the next
 * call opens a fresh one. Every byte goes through an injectable transport.
 */
import {
  ROBOROCK_LOCAL_PORT,
  RoborockCodecError,
  RoborockFrameReader,
  RoborockProtocol,
  decodeMessage,
  decodeRpcResponse,
  encodeMessage,
  encodeRpcRequest,
  type RoborockMessage,
} from "./codec";

export type RoborockErrorCode = "unreachable" | "timeout" | "protocol" | "rejected";

export class RoborockError extends Error {
  constructor(message: string, readonly code: RoborockErrorCode, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RoborockError";
  }
}

export interface RoborockSocket {
  write(bytes: Uint8Array): void;
  close(): void;
}

export interface RoborockSocketHandlers {
  data(chunk: Uint8Array): void;
  /** The peer closed or the socket failed. */
  closed(error?: Error): void;
}

/** Open a TCP connection; resolves once connected. A fake in tests. */
export type RoborockConnect = (target: { host: string; port: number }, handlers: RoborockSocketHandlers) => Promise<RoborockSocket>;

export const bunRoborockConnect: RoborockConnect = async ({ host, port }, handlers) => {
  const socket = await Bun.connect({
    hostname: host,
    port,
    socket: {
      data(_socket, chunk) { handlers.data(chunk); },
      close() { handlers.closed(); },
      error(_socket, error) { handlers.closed(error); },
      end() { handlers.closed(); },
    },
  });
  return {
    write(bytes) { socket.write(bytes); },
    close() { socket.end(); },
  };
};

export interface RoborockClientOptions {
  readonly host: string;
  readonly localKey: string;
  readonly port?: number;
  /** Per exchange (connect, hello, one RPC, one ping). */
  readonly timeoutMs?: number;
  /** Close the session after this long without an RPC. */
  readonly idleMs?: number;
  /** Ping interval while the session is held. */
  readonly pingMs?: number;
  readonly connect?: RoborockConnect;
  /** Wall clock in milliseconds; frames carry unix seconds. */
  readonly now?: () => number;
  /** Uniform integer in [min, max]. */
  readonly randomInt?: (min: number, max: number) => number;
}

interface Waiter {
  readonly accepts: (message: RoborockMessage) => boolean;
  readonly resolve: (message: RoborockMessage) => void;
  readonly reject: (error: Error) => void;
}

interface Session {
  readonly socket: RoborockSocket;
  readonly reader: RoborockFrameReader;
  waiter: Waiter | undefined;
  closed: boolean;
}

const DEFAULT_TIMEOUT_MS = 4_000;
const DEFAULT_IDLE_MS = 60_000;
const DEFAULT_PING_MS = 10_000;
const RPC_ID_MIN = 10_000;
const RPC_ID_MAX = 32_767;

export class RoborockLocalClient {
  readonly host: string;
  readonly port: number;
  private readonly localKey: string;
  private readonly timeoutMs: number;
  private readonly idleMs: number;
  private readonly pingMs: number;
  private readonly connectImpl: RoborockConnect;
  private readonly now: () => number;
  private readonly randomInt: (min: number, max: number) => number;
  private session: Session | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private nextId: number;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: RoborockClientOptions) {
    this.host = options.host;
    this.port = options.port ?? ROBOROCK_LOCAL_PORT;
    this.localKey = options.localKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.pingMs = options.pingMs ?? DEFAULT_PING_MS;
    this.connectImpl = options.connect ?? bunRoborockConnect;
    this.now = options.now ?? Date.now;
    this.randomInt = options.randomInt ?? ((min, max) => min + Math.floor(Math.random() * (max - min + 1)));
    this.nextId = this.randomInt(RPC_ID_MIN, RPC_ID_MAX);
  }

  /** One JSON-RPC call; calls run one at a time, in order. Resolves with `result`. */
  rpc(method: string, params: unknown = []): Promise<unknown> {
    return this.serialize(async () => {
      const session = await this.open();
      const id = this.takeId();
      const timestamp = this.seconds();
      const reply = await this.exchange(session, {
        seq: this.randomInt(1, 0x7fffffff),
        random: this.randomInt(10_000, 99_999),
        timestamp,
        protocol: RoborockProtocol.generalRequest,
        payload: encodeRpcRequest({ id, method, params }, timestamp),
      }, (message) => this.rpcReply(message)?.id === id, `${method} reply`);
      this.touch();
      const response = this.rpcReply(reply)!;
      if (response.error) {
        throw new RoborockError(`Vacuum rejected ${method}${response.error.message ? `: ${response.error.message}` : ""}${response.error.code !== undefined ? ` (${response.error.code})` : ""}`, "rejected");
      }
      return response.result;
    });
  }

  /** Close the session now; a later call reconnects. */
  close(): void {
    this.drop(new RoborockError("Session closed", "unreachable"));
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async open(): Promise<Session> {
    if (this.session && !this.session.closed) return this.session;
    const reader = new RoborockFrameReader();
    let session: Session | undefined;
    const handlers: RoborockSocketHandlers = {
      data: (chunk) => { if (session) this.receive(session, chunk); },
      closed: (error) => {
        if (!session || session.closed) return;
        this.drop(new RoborockError(`Vacuum at ${this.host} closed the connection${error ? `: ${error.message}` : ""}`, "unreachable", { cause: error }), session);
      },
    };
    let socket: RoborockSocket;
    try {
      socket = await withTimeout(this.connectImpl({ host: this.host, port: this.port }, handlers), this.timeoutMs, () => new RoborockError(`Vacuum at ${this.host}:${this.port} did not accept a connection in time`, "timeout"), (late) => late.close());
    } catch (error) {
      if (error instanceof RoborockError) throw error;
      throw new RoborockError(`Vacuum at ${this.host}:${this.port} is unreachable: ${error instanceof Error ? error.message : String(error)}`, "unreachable", { cause: error });
    }
    session = { socket, reader, waiter: undefined, closed: false };
    this.session = session;
    try {
      await this.exchange(session, {
        seq: 1,
        random: this.randomInt(10_000, 99_999),
        timestamp: this.seconds(),
        protocol: RoborockProtocol.helloRequest,
      }, (message) => message.protocol === RoborockProtocol.helloResponse, "hello reply");
    } catch (error) {
      this.drop(error instanceof Error ? error : new Error(String(error)), session);
      throw error;
    }
    this.startPing(session);
    this.touch();
    return session;
  }

  private exchange(session: Session, message: RoborockMessage, accepts: (message: RoborockMessage) => boolean, what: string): Promise<RoborockMessage> {
    if (session.closed) return Promise.reject(new RoborockError(`Vacuum at ${this.host} is not connected`, "unreachable"));
    return new Promise<RoborockMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new RoborockError(`Vacuum at ${this.host} sent no ${what} in ${this.timeoutMs} ms`, "timeout");
        session.waiter = undefined;
        reject(error);
        // A late reply could be mistaken for the next one; start clean.
        this.drop(error, session);
      }, this.timeoutMs);
      session.waiter = {
        accepts,
        resolve: (reply) => { clearTimeout(timer); session.waiter = undefined; resolve(reply); },
        reject: (error) => { clearTimeout(timer); session.waiter = undefined; reject(error); },
      };
      try {
        session.socket.write(encodeMessage(message, this.localKey));
      } catch (error) {
        session.waiter.reject(new RoborockError(`Could not write to the vacuum at ${this.host}`, "unreachable", { cause: error }));
      }
    });
  }

  private receive(session: Session, chunk: Uint8Array): void {
    let frames: Buffer[];
    try { frames = session.reader.push(chunk); }
    catch (error) { this.drop(error as Error, session); return; }
    for (const frame of frames) {
      let message: RoborockMessage;
      try { message = decodeMessage(frame, this.localKey); }
      catch (error) {
        // A frame we cannot decode means a wrong key or a corrupt stream; neither recovers in-session.
        this.drop(new RoborockError((error as Error).message, "protocol", { cause: error }), session);
        return;
      }
      const waiter = session.waiter;
      if (!waiter) continue;
      let matches = false;
      try { matches = waiter.accepts(message); }
      catch (error) { waiter.reject(new RoborockError((error as Error).message, "protocol", { cause: error })); continue; }
      if (matches) waiter.resolve(message);
    }
  }

  private rpcReply(message: RoborockMessage) {
    if (message.protocol !== RoborockProtocol.generalRequest && message.protocol !== RoborockProtocol.generalResponse) return undefined;
    if (!message.payload) return undefined;
    try { return decodeRpcResponse(message.payload); }
    catch (error) {
      if (error instanceof RoborockCodecError) throw error;
      throw new RoborockCodecError(String(error));
    }
  }

  private startPing(session: Session): void {
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (session.closed || session.waiter) return;
      void this.serialize(async () => {
        if (session.closed || this.session !== session) return;
        await this.exchange(session, {
          seq: this.randomInt(1, 0x7fffffff),
          random: this.randomInt(10_000, 99_999),
          timestamp: this.seconds(),
          protocol: RoborockProtocol.pingRequest,
        }, (message) => message.protocol === RoborockProtocol.pingResponse, "ping reply");
      }).catch(() => undefined);
    }, this.pingMs);
    (this.pingTimer as { unref?: () => void }).unref?.();
  }

  private touch(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), this.idleMs);
    (this.idleTimer as { unref?: () => void }).unref?.();
  }

  private drop(error: Error, session = this.session): void {
    if (!session || session.closed) return;
    session.closed = true;
    if (this.session === session) {
      this.session = undefined;
      clearInterval(this.pingTimer);
      clearTimeout(this.idleTimer);
    }
    session.waiter?.reject(error instanceof RoborockError ? error : new RoborockError(error.message, "protocol", { cause: error }));
    try { session.socket.close(); } catch { /* already closed */ }
  }

  private takeId(): number {
    const id = this.nextId;
    this.nextId = id >= RPC_ID_MAX ? RPC_ID_MIN : id + 1;
    return id;
  }

  private seconds(): number {
    return Math.floor(this.now() / 1000) >>> 0;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, timeout: () => Error, onLate: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => { done = true; reject(timeout()); }, ms);
    promise.then(
      (value) => { if (done) { onLate(value); return; } done = true; clearTimeout(timer); resolve(value); },
      (error: unknown) => { if (done) return; done = true; clearTimeout(timer); reject(error); },
    );
  });
}
