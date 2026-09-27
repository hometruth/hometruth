/**
 * HomeTruth's own embedded MQTT broker (Aedes over TCP), for devices whose
 * only local push signal is MQTT publish — the Wyze Cam v3's Motion Guard
 * (`/sbin/motion` → `send2mqtt`) is the first consumer.
 *
 * No cloud, no external broker to stand up: the device is pointed at this
 * process's own address and port, and whichever product needs a topic
 * subscribes here. One broker per process, like the TKENPRO local cloud
 * emulator; devices never talk MQTT to each other, only publish/subscribe
 * through this hub.
 *
 * A `Service` (`src/models/service.ts`): it has a status and an event log,
 * inspectable from the services list, separately from any one device.
 *
 * `aedes`'s own `.d.ts` (as of 1.1.2) still documents the pre-1.0 API
 * (`new Aedes()`); the runtime requires the async factory below. Verified
 * directly against the installed package's source, not the shipped types.
 * The client/publish/disconnect events used here are likewise confirmed
 * against `node_modules/aedes/aedes.js` and `lib/handlers/connect.js`, not
 * just the (stale) `.d.ts`. One thing the `.d.ts` gets wrong outright: there
 * is no broker-level event for a rejected connection — a client that fails
 * `authenticate` never reaches `registerClient`, so it never gets a `client`
 * event, and there is no `clientError`/`connectionError` emit anywhere in
 * this version's source despite the types declaring them. A rejection is
 * logged from inside `authenticate` itself instead.
 */
import { Aedes } from "aedes";
import { createServer, type ServerFactory } from "aedes-server-factory";
import type { Server as NetServer } from "node:net";
import { EventLog, type EventFilter, type ServiceEvent, type ServiceEventListener } from "../../models/event-log";
import { Service, type ServiceStatus } from "../../models/service";

export interface MqttBrokerOptions {
  readonly port?: number;
  readonly hostname?: string;
  /** Rejects a connecting device whose username/password do not match, when set. */
  readonly credentials?: { readonly username: string; readonly password: string };
  /** How many recent events to keep; default 200. */
  readonly eventLogCapacity?: number;
}

export type MqttMessageHandler = (topic: string, payload: Buffer) => void;

export interface MqttBroker extends Pick<Service, "id" | "title" | "status" | "events" | "subjects" | "subscribe"> {
  readonly port: number;
  readonly hostname: string;
  /** Call `handler` for every message published to `topic` (exact match only; no wildcards). */
  onMessage(topic: string, handler: MqttMessageHandler): () => void;
  /** Publish from HomeTruth itself (a vendor interceptor relaying a device's event), to every subscriber of `topic`. */
  publish(topic: string, payload: string | Buffer): Promise<void>;
  /** Mirror one normalized HomeTruth event onto the site-wide event bus and into this service's unified log. */
  publishEvent(event: ServiceEvent): Promise<void>;
  stop(): Promise<void>;
}

/** Stable MQTT topic for a normalized HomeTruth event. Each payload is the complete `ServiceEvent` JSON object. */
export function homeTruthEventTopic(event: Pick<ServiceEvent, "subject" | "type">): string {
  const subject = encodeURIComponent(event.subject ?? "_site");
  return `hometruth/events/${subject}/${encodeURIComponent(event.type)}`;
}

// `aedes`'s bundled types predate `Aedes.createBroker`; narrow only what this module uses.
interface AedesClient {
  id: string;
}
interface AedesBroker {
  handle: ServerFactory extends (broker: infer B, ...rest: never[]) => unknown ? B : never;
  readonly connectedClients: number;
  on(event: "publish", listener: (packet: { topic: string; payload: Buffer }, client: AedesClient | null) => void): void;
  on(event: "client", listener: (client: AedesClient) => void): void;
  on(event: "clientDisconnect", listener: (client: AedesClient) => void): void;
  authenticate?: (client: AedesClient, username: string | undefined, password: Buffer | undefined, done: (error: Error | null, success: boolean | null) => void) => void;
  publish(packet: { topic: string; payload: Buffer; qos: 0 | 1 | 2; retain: boolean; cmd: "publish"; dup: false }, callback: (error?: Error) => void): void;
  close(callback?: () => void): void;
}

class MqttBrokerService extends Service implements MqttBroker {
  private stopped = false;
  private stopping: Promise<void> | undefined;

  constructor(
    readonly port: number,
    readonly hostname: string,
    private readonly aedes: AedesBroker,
    private readonly server: NetServer,
    private readonly handlers: Map<string, Set<MqttMessageHandler>>,
    private readonly log: EventLog,
  ) {
    super("mqtt-broker", "MQTT broker");
    this.log.record("started", `Listening on ${hostname}:${port}`, { data: { hostname, port } });
    aedes.on("client", (client) => this.log.record("client_connected", `Client "${client.id}" connected`, { data: { clientId: client.id } }));
    aedes.on("clientDisconnect", (client) => this.log.record("client_disconnected", `Client "${client.id}" disconnected`, { data: { clientId: client.id } }));
    aedes.on("publish", (packet, client) => {
      if (!client) return; // aedes's own internal $SYS messages carry no client.
      this.log.record("message_published", `"${client.id}" published to ${packet.topic}`, { data: { clientId: client.id, topic: packet.topic, bytes: packet.payload.length } });
    });
  }

  override status(): ServiceStatus {
    return {
      availability: this.stopped ? "offline" : "online",
      detail: this.stopped
        ? "Stopped"
        : `Listening on ${this.hostname}:${this.port}, ${this.aedes.connectedClients} client${this.aedes.connectedClients === 1 ? "" : "s"} connected`,
    };
  }

  override events(limit?: number, filter?: EventFilter): readonly ServiceEvent[] {
    return this.log.recent(limit, filter);
  }

  override subjects(): readonly string[] {
    return this.log.subjects();
  }

  override subscribe(listener: ServiceEventListener, filter?: EventFilter): () => void {
    return this.log.subscribe(listener, filter);
  }

  onMessage(topic: string, handler: MqttMessageHandler): () => void {
    const set = this.handlers.get(topic) ?? new Set();
    set.add(handler);
    this.handlers.set(topic, set);
    return () => { set.delete(handler); };
  }

  async publish(topic: string, payload: string | Buffer): Promise<void> {
    const buffer = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
    await new Promise<void>((resolve, reject) => {
      this.aedes.publish({ cmd: "publish", topic, payload: buffer, qos: 0, retain: false, dup: false }, (error) => error ? reject(error) : resolve());
    });
    this.log.record("message_published", `HomeTruth published to ${topic}`, { data: { clientId: "hometruth", topic, bytes: buffer.length } });
  }

  async publishEvent(event: ServiceEvent): Promise<void> {
    // Record the event itself, rather than a generic "message published" row,
    // so the broker page is also the useful unified event-bus view. Do not
    // feed broker-originated events back through this method: callers bridge
    // every other log and deliberately exclude this service.
    const mirrored = this.log.record(event.type, event.message, {
      level: event.level,
      ...(event.subject ? { subject: event.subject } : {}),
      ...(event.data ? { data: event.data } : {}),
    });
    const payload = Buffer.from(JSON.stringify(mirrored), "utf8");
    await new Promise<void>((resolve, reject) => {
      this.aedes.publish({ cmd: "publish", topic: homeTruthEventTopic(mirrored), payload, qos: 0, retain: false, dup: false }, (error) => error ? reject(error) : resolve());
    });
  }

  override stop(): Promise<void> {
    return this.stopping ??= (async () => {
      this.stopped = true;
      this.log.record("stopped", "Broker stopped");
      // Stop accepting new connections first, then let Aedes disconnect its clients.
      // Awaiting server.close() first deadlocks on persistent clients such as Frigate.
      const serverClosed = new Promise<void>((resolve) => this.server.close(() => resolve()));
      await new Promise<void>((resolve) => this.aedes.close(() => resolve()));
      await serverClosed;
    })();
  }
}

/** Starts listening immediately; `port: 0` (the default) picks any free port, read back from the result. */
export async function startMqttBroker(options: MqttBrokerOptions = {}): Promise<MqttBroker> {
  const log = new EventLog(options.eventLogCapacity ?? 200);
  const aedes = await (Aedes as unknown as { createBroker(): Promise<AedesBroker> }).createBroker();
  if (options.credentials) {
    const { username, password } = options.credentials;
    aedes.authenticate = (client, givenUser, givenPass, done) => {
      const ok = givenUser === username && givenPass?.toString("utf8") === password;
      if (!ok) log.record("connection_rejected", `Rejected client "${client.id}": bad username or password`, { level: "warn", data: { clientId: client.id } });
      done(ok ? null : Object.assign(new Error("Bad username or password"), { returnCode: 4 }), ok);
    };
  }

  const handlers = new Map<string, Set<MqttMessageHandler>>();
  aedes.on("publish", (packet) => {
    for (const handler of handlers.get(packet.topic) ?? []) handler(packet.topic, packet.payload);
  });

  const server = createServer(aedes as never, {}) as NetServer;
  const hostname = options.hostname ?? "0.0.0.0";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, hostname, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (options.port ?? 0);

  return new MqttBrokerService(port, hostname, aedes, server, handlers, log);
}
