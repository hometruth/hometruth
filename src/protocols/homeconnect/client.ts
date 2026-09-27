import { randomBytes, createHash } from "node:crypto";
import { hostname } from "node:os";
import { isSafeCameraUri } from "../../camera-media";
import { HomeConnectCodec } from "./codec";

export interface HomeConnectMessage {
  sID: number; msgID: number; resource: string; version: number;
  action: string; data?: Record<string, unknown>[]; code?: number;
}
export interface HomeConnectSnapshot {
  values: Map<number, unknown>;
  descriptions: Map<number, Record<string, unknown>>;
  observedAt: string;
}
export interface HomeConnectTransport {
  read(): Promise<HomeConnectSnapshot>;
  set(uid: number, value: number | boolean): Promise<void>;
  close(): void;
}
export function controlAvailable(snapshot: HomeConnectSnapshot, uid: number): boolean {
  if (![0x020c, 0x0235].includes(uid) || snapshot.values.get(0x020b) !== true) return false;
  // The NITP060UC profile declares both settings and their setting-list parent readWrite.
  for (const id of [uid, 0x0103]) {
    const description = snapshot.descriptions.get(id);
    if (description?.available === false) return false;
    if (description?.access !== undefined && String(description.access).toLowerCase() !== "readwrite") return false;
  }
  return true;
}
export class HomeConnectResponseError extends Error {
  constructor(readonly code: number, readonly resource: string) { super(`Home Connect rejected ${resource} (code ${code})`); }
}

/** The appliance evicts a session when another client announces the same ID.
 * Keep installations distinct, but keep an installation's ID across releases.
 * The launcher runs in the private installation directory, never the source tree.
 */
export function homeConnectApplicationId(deviceId: string, host: string, installationDirectory: string): string {
  return createHash("sha256").update(JSON.stringify([host, installationDirectory, deviceId])).digest("hex").slice(0, 24);
}

/** A lazy LAN client: reads establish a session; disconnects fail pending commands.
 * No cloud access, listeners, background reconnect loop, or automatic command replay.
 */
export class HomeConnectClient implements HomeConnectTransport {
  private readonly applicationId: string;
  private ws: WebSocket | undefined;
  private codec?: HomeConnectCodec;
  private session = 0;
  private nextId = 0;
  private versions = new Map<string, number>();
  private values = new Map<number, unknown>();
  private descriptions = new Map<number, Record<string, unknown>>();
  private connecting: Promise<void> | undefined;
  private reading: Promise<HomeConnectSnapshot> | undefined;
  private disposed = false;
  private ready = false;
  private lastRead = 0;
  private observedAt = "";
  private writing: Promise<void> = Promise.resolve();
  private init: { resolve: (message: HomeConnectMessage) => void; reject: (error: Error) => void } | undefined;
  private pending = new Map<number, { resource: string; resolve: (message: HomeConnectMessage) => void; reject: (error: Error) => void }>();

  constructor(private readonly options: { host: string; key: string; iv: string; id: string; timeoutMs?: number; socketFactory?: (url: string) => WebSocket }) {
    if (!/^[A-Za-z0-9.-]+$/u.test(options.host) || !isSafeCameraUri(`http://${options.host}/`)) throw new Error("Home Connect host must be a private LAN address");
    new HomeConnectCodec(options.key, options.iv);
    this.applicationId = homeConnectApplicationId(options.id, hostname(), process.cwd());
  }

  private get timeout(): number { return this.options.timeoutMs ?? 5000; }

  async read(): Promise<HomeConnectSnapshot> {
    if (this.ready && Date.now() - this.lastRead < 1000) return this.snapshot();
    this.reading ??= this.refresh().finally(() => { this.reading = undefined; });
    return this.reading;
  }

  private async refresh(): Promise<HomeConnectSnapshot> {
    await this.connect();
    try {
      await this.request("/ro/allDescriptionChanges");
      await this.request("/ro/allMandatoryValues");
      this.lastRead = Date.now();
      this.observedAt = new Date().toISOString();
      return this.snapshot();
    } catch (error) { this.disconnect(error instanceof Error ? error : new Error("Home Connect read failed")); throw error; }
  }

  private snapshot(): HomeConnectSnapshot {
    return { values: new Map(this.values), descriptions: new Map(this.descriptions), observedAt: this.observedAt };
  }

  async set(uid: number, value: number | boolean): Promise<void> {
    // Deliberately limited to the two non-cooking controls implemented by this model.
    if (!(uid === 0x020c && typeof value === "boolean")
      && !(uid === 0x0235 && typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 5940)) throw new Error("Unsupported Home Connect control or value");
    const operation = this.writing.then(async () => {
      const snapshot = await this.read();
      if (!controlAvailable(snapshot, uid)) throw new Error("Cooktop currently does not allow this control");
      try {
        await this.request("/ro/values", "POST", [{ uid, value }]);
        await this.reading;
        this.lastRead = 0;
        const observed = (await this.read()).values.get(uid);
        // The running kitchen timer can tick between its write and readback.
        const confirmed = observed === value || (uid === 0x0235 && typeof value === "number" && typeof observed === "number" && observed <= value && observed >= Math.max(0, value - 2));
        if (!confirmed) throw new Error("Cooktop has not confirmed the requested setting");
      } catch (error) { this.disconnect(error instanceof Error ? error : new Error("Home Connect write failed")); throw error; }
    });
    this.writing = operation.catch(() => {});
    return operation;
  }

  private async connect(): Promise<void> {
    if (this.disposed) throw new Error("Home Connect client is closed");
    if (this.ready) return;
    this.connecting ??= this.open().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private async open(): Promise<void> {
    this.codec = new HomeConnectCodec(this.options.key, this.options.iv);
    this.values.clear(); this.descriptions.clear(); this.versions.clear();
    const ws = this.options.socketFactory?.(`ws://${this.options.host}:80/homeconnect`) ?? new WebSocket(`ws://${this.options.host}:80/homeconnect`);
    this.ws = ws; ws.binaryType = "arraybuffer";
    const initial = new Promise<HomeConnectMessage>((resolve, reject) => { this.init = { resolve, reject }; });
    const timer = setTimeout(() => this.disconnect(new Error("Home Connect handshake timed out")), this.timeout);
    ws.onmessage = (event) => {
      if (ws !== this.ws) return;
      try {
        if (!(event.data instanceof ArrayBuffer)) throw new Error("Expected an encrypted Home Connect frame");
        this.receive(JSON.parse(this.codec!.decrypt(new Uint8Array(event.data))));
      } catch (error) { this.disconnect(error instanceof Error ? error : new Error("Invalid Home Connect message")); }
    };
    ws.onerror = () => { if (ws === this.ws) this.disconnect(new Error("Home Connect LAN connection failed")); };
    ws.onclose = () => { if (ws === this.ws) this.disconnect(new Error("Home Connect LAN connection closed")); };
    try {
      const first = await initial;
      clearTimeout(timer); this.init = undefined;
      const seed = first.data?.[0]?.edMsgID;
      if (!Number.isInteger(seed) || !Number.isInteger(first.sID)) throw new Error("Invalid Home Connect session identity");
      this.session = first.sID; this.nextId = seed as number;
      this.send({ ...first, action: "RESPONSE", data: [{ deviceType: first.version === 1 ? 2 : "Application", deviceName: "HomeTruth", deviceID: this.applicationId }] });
      const services = await this.request("/ci/services");
      for (const service of services.data ?? []) if (typeof service.service === "string" && typeof service.version === "number") this.versions.set(service.service, service.version);
      if ((this.versions.get("ci") ?? 1) < 3) {
        await this.request("/ci/authentication", "GET", [{ nonce: randomBytes(32).toString("base64url") }]);
        await this.request("/ci/info").catch((error) => { if (!(error instanceof HomeConnectResponseError)) throw error; });
      }
      if (this.versions.has("iz")) await this.request("/iz/info");
      if (this.versions.get("ei") === 2) this.send(this.message("/ei/deviceReady", "NOTIFY"));
      this.ready = true;
    } catch (error) { this.disconnect(error instanceof Error ? error : new Error("Home Connect handshake failed")); throw error; }
    finally { clearTimeout(timer); }
  }

  private receive(message: HomeConnectMessage): void {
    if (!message || !Number.isInteger(message.msgID) || typeof message.resource !== "string" || (message.data !== undefined && !Array.isArray(message.data))) throw new Error("Invalid Home Connect response");
    if (this.init && message.resource === "/ei/initialValues" && message.action === "POST") { this.init.resolve(message); return; }
    if (message.sID !== this.session) throw new Error("Home Connect session mismatch");
    if (!message.code) {
      if (["/ro/allMandatoryValues", "/ro/values"].includes(message.resource)) {
        if (message.resource === "/ro/allMandatoryValues") this.values.clear();
        for (const row of message.data ?? []) if (Number.isInteger(row.uid) && "value" in row) this.values.set(row.uid as number, row.value);
        this.observedAt = new Date().toISOString();
      }
      if (["/ro/allDescriptionChanges", "/ro/descriptionChange"].includes(message.resource)) {
        if (message.resource === "/ro/allDescriptionChanges") this.descriptions.clear();
        for (const row of message.data ?? []) if (Number.isInteger(row.uid)) this.descriptions.set(row.uid as number, { ...this.descriptions.get(row.uid as number), ...row });
      }
    }
    if (message.action === "RESPONSE") {
      const waiter = this.pending.get(message.msgID);
      if (waiter && waiter.resource === message.resource) {
        this.pending.delete(message.msgID);
        if (message.code) waiter.reject(new HomeConnectResponseError(message.code, message.resource));
        else waiter.resolve(message);
      }
    }
  }

  private message(resource: string, action = "GET", data?: Record<string, unknown>[]): HomeConnectMessage {
    return { sID: this.session, msgID: this.nextId++, resource, version: this.versions.get(resource.slice(1, 3)) ?? 1, action, ...(data ? { data } : {}) };
  }
  private send(message: HomeConnectMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("Home Connect is disconnected");
    this.ws.send(Uint8Array.from(this.codec!.encrypt(JSON.stringify(message))));
  }
  private async request(resource: string, action = "GET", data?: Record<string, unknown>[]): Promise<HomeConnectMessage> {
    const message = this.message(resource, action, data);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<HomeConnectMessage>((resolve, reject) => {
        this.pending.set(message.msgID, { resource, resolve, reject });
        timer = setTimeout(() => reject(new Error(`Home Connect timed out reading ${resource}`)), this.timeout);
        this.send(message);
      });
    } finally { clearTimeout(timer); this.pending.delete(message.msgID); }
  }

  private disconnect(error: Error): void {
    this.ready = false; this.lastRead = 0;
    const ws = this.ws; this.ws = undefined;
    this.init?.reject(error); this.init = undefined;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    ws?.close();
  }
  close(): void { this.disposed = true; this.disconnect(new Error("Home Connect client closed")); }
}
