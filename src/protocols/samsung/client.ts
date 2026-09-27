/**
 * A connection to one Samsung Tizen set: the REST device-info read that needs
 * no pairing, and the two token-authenticated WebSocket channels.
 *
 * Channels are opened lazily and kept open — the set drops an idle socket
 * itself, and a reopen costs one round trip rather than another on-screen
 * prompt once a token is held. `onToken` fires the first time the set issues
 * one, which is the only moment it is ever offered.
 */
import {
  ART_CHANNEL,
  CHANNEL_CONNECT,
  CHANNEL_READY,
  CHANNEL_UNAUTHORIZED,
  REMOTE_CHANNEL,
  artRequestCommand,
  channelUrl,
  deviceInfoUrl,
  applicationUrl,
  launchAppCommand,
  parseArtPayload,
  parseDeviceInfo,
  parseFrame,
  remoteKeyCommand,
  tokenOf,
  type ArtPayload,
  type RemoteKeyCommand,
  type TizenDeviceInfo,
  type TizenFrame,
} from "./messages";

export type SamsungErrorCode = "unreachable" | "unauthorized" | "timeout" | "protocol" | "refused";

export class SamsungError extends Error {
  constructor(message: string, readonly code: SamsungErrorCode) {
    super(message);
    this.name = "SamsungError";
  }
}

export type SocketFactory = (url: string) => WebSocket;
export type SamsungFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface SamsungClientOptions {
  host: string;
  /** The name the set shows in its pairing prompt. */
  name?: string;
  token?: string;
  timeoutMs?: number;
  /** Called the first time the set issues a token, so it can be persisted. */
  onToken?: (token: string) => void;
  socketFactory?: SocketFactory;
  fetch?: SamsungFetch;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_NAME = "HomeTruth";

/**
 * Bun's WebSocket takes TLS options, which the DOM signature TypeScript
 * resolves to does not describe — hence the one cast here.
 *
 * A Tizen set presents its own self-signed certificate on 8002 and there is
 * nothing to verify it against, so the connection does not try. What travels
 * over it is key presses on the LAN, not secrets.
 */
type TlsWebSocket = new (url: string, options: { tls: { rejectUnauthorized: boolean } }) => WebSocket;

function openSocket(url: string): WebSocket {
  return new (WebSocket as unknown as TlsWebSocket)(url, { tls: { rejectUnauthorized: false } });
}

interface Channel {
  socket: WebSocket;
  ready: Promise<void>;
}

export class SamsungTizenClient {
  readonly host: string;
  private readonly name: string;
  private readonly timeoutMs: number;
  private readonly onToken: ((token: string) => void) | undefined;
  private readonly socketFactory: SocketFactory;
  private readonly fetchImpl: SamsungFetch;
  private readonly channels = new Map<string, Channel>();
  private readonly artWaiters = new Set<(payload: ArtPayload) => void>();
  private token: string | undefined;
  private closed = false;

  constructor(options: SamsungClientOptions) {
    this.host = options.host.trim();
    this.name = options.name ?? DEFAULT_NAME;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.onToken = options.onToken;
    this.socketFactory = options.socketFactory ?? openSocket;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /** The pairing token in hand, once the set has issued one. */
  get pairingToken(): string | undefined {
    return this.token;
  }

  /**
   * `GET /api/v2/` on the unauthenticated port. This is the only read the set
   * offers, and the only call that works before pairing.
   */
  async deviceInfo(): Promise<TizenDeviceInfo> {
    let response: Response;
    try {
      response = await this.fetchImpl(deviceInfoUrl(this.host), { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      throw new SamsungError(`Television at ${this.host} is unreachable: ${error instanceof Error ? error.message : String(error)}`, "unreachable");
    }
    if (!response.ok) throw new SamsungError(`Television answered HTTP ${response.status}`, "protocol");
    const info = parseDeviceInfo(await response.json().catch(() => undefined));
    if (!info) throw new SamsungError("Television returned no device information", "protocol");
    return info;
  }

  /**
   * Open the remote channel and nothing else. On an unpaired set this is what
   * puts the prompt on screen, so it is the deliberate half of pairing.
   */
  async openRemoteChannel(): Promise<void> {
    await this.channel(REMOTE_CHANNEL);
  }

  /** Send one key press on the remote channel. `key` is a Tizen key name. */
  async sendKey(key: string, command: RemoteKeyCommand = "Click"): Promise<void> {
    const channel = await this.channel(REMOTE_CHANNEL);
    channel.socket.send(remoteKeyCommand(key, command));
  }

  /** Hold a key down for `holdMs` — how a Frame is asked to power all the way off. */
  async holdKey(key: string, holdMs: number): Promise<void> {
    await this.sendKey(key, "Press");
    await new Promise((resolve) => setTimeout(resolve, holdMs));
    await this.sendKey(key, "Release");
  }

  async launchApp(appId: string): Promise<void> {
    const channel = await this.channel(REMOTE_CHANNEL);
    channel.socket.send(launchAppCommand(appId));
  }

  /**
   * One art-app request, resolved by the `d2d_service_message` carrying the
   * same id. A set that is not a Frame refuses the channel outright.
   */
  async artRequest(request: string, params: Record<string, unknown> = {}): Promise<ArtPayload> {
    const channel = await this.channel(ART_CHANNEL);
    const requestId = crypto.randomUUID();
    return await new Promise<ArtPayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.artWaiters.delete(waiter);
        reject(new SamsungError(`Television did not answer the ${request} art request`, "timeout"));
      }, this.timeoutMs);
      const waiter = (payload: ArtPayload) => {
        if (payload.id !== requestId) return;
        this.artWaiters.delete(waiter);
        clearTimeout(timer);
        if (payload.event === "error") {
          reject(new SamsungError(`Television refused the ${request} art request${payload.errorCode ? ` (${payload.errorCode})` : ""}`, "refused"));
          return;
        }
        resolve(payload);
      };
      this.artWaiters.add(waiter);
      try {
        channel.socket.send(artRequestCommand(request, requestId, params));
      } catch (error) {
        this.artWaiters.delete(waiter);
        clearTimeout(timer);
        reject(new SamsungError(`Could not send the ${request} art request: ${error instanceof Error ? error.message : String(error)}`, "protocol"));
      }
    });
  }

  /** Ask the REST port to start an installed app; the WS launch needs the set already awake. */
  async restLaunchApp(appId: string): Promise<void> {
    const response = await this.fetchImpl(applicationUrl(this.host, appId), { method: "POST", signal: AbortSignal.timeout(this.timeoutMs) })
      .catch((error: unknown) => {
        throw new SamsungError(`Television at ${this.host} is unreachable: ${error instanceof Error ? error.message : String(error)}`, "unreachable");
      });
    if (!response.ok) throw new SamsungError(`Television answered HTTP ${response.status} launching ${appId}`, "protocol");
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const channel of this.channels.values()) {
      try {
        channel.socket.close();
      } catch {
        // A socket already closed by the set needs nothing.
      }
    }
    this.channels.clear();
    this.artWaiters.clear();
  }

  /** An open, connected channel, opening one if this is the first call. */
  private async channel(name: string): Promise<Channel> {
    if (this.closed) throw new SamsungError("This television client is closed", "protocol");
    const existing = this.channels.get(name);
    if (existing && existing.socket.readyState === WebSocket.OPEN) return existing;
    if (existing && existing.socket.readyState === WebSocket.CONNECTING) {
      await existing.ready;
      return existing;
    }
    const channel = this.open(name);
    this.channels.set(name, channel);
    try {
      await channel.ready;
    } catch (error) {
      this.channels.delete(name);
      throw error;
    }
    return channel;
  }

  private open(name: string): Channel {
    const url = channelUrl({ host: this.host, channel: name, name: this.name, ...(this.token ? { token: this.token } : {}) });
    const socket = this.socketFactory(url);
    // The art channel only accepts requests once it says it is ready; the
    // remote channel is usable as soon as it is connected.
    const readyEvent = name === ART_CHANNEL ? CHANNEL_READY : CHANNEL_CONNECT;
    const ready = new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      /** The one gate: whichever of the timeout, the handshake, or a close comes first decides. */
      const settle = (error?: SamsungError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      timer = setTimeout(() => {
        settle(new SamsungError(`Television at ${this.host} did not open the ${name} channel`, "timeout"));
        try {
          socket.close();
        } catch {
          // Nothing to do for a socket that never opened.
        }
      }, this.timeoutMs);
      socket.onmessage = (event: MessageEvent) => {
        const frame = parseFrame(typeof event.data === "string" ? event.data : "");
        if (!frame) return;
        this.receive(frame);
        if (frame.event === CHANNEL_UNAUTHORIZED) {
          settle(new SamsungError("Television refused HomeTruth. Accept the prompt on the screen and try again.", "unauthorized"));
          return;
        }
        if (frame.event === readyEvent) settle();
      };
      socket.onerror = () => settle(new SamsungError(`Television at ${this.host} refused the ${name} channel`, "unreachable"));
      socket.onclose = () => {
        this.channels.delete(name);
        settle(new SamsungError(`Television at ${this.host} closed the ${name} channel`, "unreachable"));
      };
    });
    return { socket, ready };
  }

  private receive(frame: TizenFrame): void {
    const token = tokenOf(frame);
    if (token && token !== this.token) {
      this.token = token;
      this.onToken?.(token);
    }
    const payload = parseArtPayload(frame);
    if (!payload) return;
    for (const waiter of [...this.artWaiters]) waiter(payload);
  }
}
