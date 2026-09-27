/** HomeTruth's shared, inventory-driven client. Works in Bun, Node and browsers. */
export interface InventoryElement {
  uuid: string;
  key: string;
  id: string;
  name: string;
  kind: string;
  side: "instance" | "schema" | "tag";
  page: string;
  deviceId?: string;
}

export interface MethodArgument {
  name: string;
  type: string;
  required: boolean;
  in: "body" | "path" | "query";
  fixed?: unknown;
}

export interface MethodDefinition {
  name: string;
  description: string;
  arguments: MethodArgument[];
  returns: string;
  positional?: string;
  transport: { method: string; path: string; media: string; body: "none" | "object" | "value" };
}

export interface ElementDescription extends InventoryElement {
  properties: { path: string; type: string; required: boolean; description?: string }[];
  methods: Omit<MethodDefinition, "transport">[];
}

export interface ElementContract {
  element: InventoryElement;
  properties: ElementDescription["properties"];
  methods: MethodDefinition[];
}

/** Additional methods and namespaces are discovered from the connected install. */
export type RemoteMethod = ((...arguments_: unknown[]) => Promise<unknown>) & { readonly [name: string]: RemoteMethod };
export type Element<Read = unknown> = {
  describe(): Promise<ElementDescription>;
  read(): Promise<Read>;
} & { readonly [name: string]: RemoteMethod };

export interface ControlOptions { confirmed?: boolean }
export interface DeviceState {
  id: string;
  name: string;
  enabled: boolean;
  controls: string[];
  object: { status: string; capabilities: Record<string, { state: Record<string, unknown>; actions: Record<string, unknown> }> };
}

/** The public snapshot returned when reading a binary switch. */
export interface BinarySwitchDocument {
  id: string;
  state: {
    availability: "online" | "offline" | "degraded" | "unknown";
    value?: "on" | "off";
    observedAt?: string;
  };
  actions: { turnOn: Record<string, never>; turnOff: Record<string, never>; toggle: Record<string, never>; getState: Record<string, never> };
}

/** Common controls have native TypeScript signatures; describe() lists those this device supports. */
export type Device = Element<DeviceState | BinarySwitchDocument> & {
  enabled(): Promise<boolean>;
  enable(): Promise<boolean>;
  disable(): Promise<boolean>;
  on(options?: ControlOptions): Promise<DeviceState>;
  off(options?: ControlOptions): Promise<DeviceState>;
  toggle(options?: ControlOptions): Promise<DeviceState>;
  state(): Promise<DeviceState | BinarySwitchDocument["state"]>;
  brightness(percent: number, options?: ControlOptions): Promise<DeviceState>;
  colorTemperature(kelvin: number, options?: ControlOptions): Promise<DeviceState>;
  color(hex: string, options?: ControlOptions): Promise<DeviceState>;
  privacy(enabled: boolean, options?: ControlOptions): Promise<DeviceState>;
  volume(percent: number, options?: ControlOptions): Promise<DeviceState>;
  mute(enabled: boolean, options?: ControlOptions): Promise<DeviceState>;
};

export type Transport = (url: string, init: RequestInit) => Promise<unknown>;
export interface ConnectOptions { token?: string; signal?: AbortSignal }
interface Connection {
  request: Transport;
  inventory: readonly InventoryElement[];
  devices: Readonly<Record<string, Device>>;
  elements: Readonly<Record<string, Element>>;
  contracts: Map<string, Promise<ElementContract>>;
}

export class HomeTruth {
  #connection: Connection | undefined;
  #epoch = 0;
  constructor(private readonly options: { transport?: Transport; fetch?: typeof fetch } = {}) {}

  get inventory(): readonly InventoryElement[] { return this.connected().inventory; }
  get devices(): Readonly<Record<string, Device>> { return this.connected().devices; }
  get elements(): Readonly<Record<string, Element>> { return this.connected().elements; }

  /** Connect once. No device is polled or controlled while loading the inventory. */
  async connect(url: string, options: ConnectOptions = {}): Promise<this> {
    const base = new URL(url);
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) throw new Error("Use an HTTP(S) HomeTruth URL; pass a token in the options");
    const epoch = ++this.#epoch;
    this.#connection = undefined;
    const send = this.options.transport ?? (async (url, init) => {
      const response = await (this.options.fetch ?? fetch)(url, init);
      const type = response.headers.get("content-type") ?? "";
      if (!response.ok) {
        const result = await response.json().catch(() => undefined) as { error?: { message?: string } } | undefined;
        throw new Error(result?.error?.message ?? `HomeTruth answered ${response.status}`);
      }
      if (type.includes("event-stream") || type.startsWith("multipart/")) return response.body;
      if (response.status === 204) return undefined;
      return type.includes("json") ? response.json() : type.startsWith("text/") ? response.text() : response.blob();
    });
    const request: Transport = (path, init) => {
      const target = new URL(path, base);
      if (target.origin !== base.origin || !target.pathname.startsWith("/api/")) throw new Error("The method must belong to the connected HomeTruth install");
      return send(target.href, { ...init, credentials: "same-origin", ...(options.signal ? { signal: options.signal } : {}), headers: {
        ...init.headers, ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      } });
    };
    const result = await request("/api/inventory", { method: "GET" }) as { elements: InventoryElement[] };
    if (epoch !== this.#epoch) throw new Error("This connection was superseded by another connect() call");
    const connection: Connection = { request, inventory: result.elements, devices: {}, elements: {}, contracts: new Map() };
    const elements = Object.create(null) as Record<string, Element>;
    const devices = Object.create(null) as Record<string, Device>;
    const names = new Map<string, string[]>();
    for (const entry of result.elements) {
      const handle = this.handle(connection, entry);
      elements[entry.uuid] = handle;
      if (entry.deviceId) devices[entry.deviceId] = handle as Device;
      for (const name of new Set([entry.id, entry.key])) {
        // The reserved site name never resolves to a similarly named device.
        if (name === "root" && entry.kind !== "site") continue;
        const ids = names.get(name) ?? []; ids.push(entry.uuid); names.set(name, ids);
      }
    }
    connection.elements = new Proxy(elements, { get(target, key: string | symbol) {
      if (typeof key !== "string" || key === "then") return undefined;
      if (Object.hasOwn(target, key)) return target[key];
      const ids = names.get(key);
      if (!ids) throw new Error(`No element named "${key}". Inspect ht.inventory for available IDs`);
      if (ids.length !== 1) throw new Error(`Element ID "${key}" is ambiguous; use its UUID from ht.inventory`);
      return target[ids[0]!];
    } });
    connection.devices = new Proxy(devices, { get(target, key: string | symbol) {
      if (typeof key !== "string" || key === "then") return undefined;
      if (!Object.hasOwn(target, key)) throw new Error(`No device named "${key}". Inspect ht.inventory for available IDs`);
      return target[key];
    } });
    this.#connection = connection;
    return this;
  }

  private connected(): Connection {
    if (!this.#connection) throw new Error("Await ht.connect(url) before using the inventory");
    return this.#connection;
  }

  private handle(connection: Connection, entry: InventoryElement): Element {
    const contract = (): Promise<ElementContract> => {
      if (this.connected() !== connection) throw new Error("This handle belongs to a previous connection; look it up again in ht.elements");
      let result = connection.contracts.get(entry.uuid);
      if (!result) {
        result = connection.request(`/api/inventory/${encodeURIComponent(entry.uuid)}`, { method: "GET" }) as Promise<ElementContract>;
        connection.contracts.set(entry.uuid, result);
        result.catch(() => { connection.contracts.delete(entry.uuid); });
      }
      return result;
    };
    const member = (path: string): RemoteMethod => new Proxy(async (...args: unknown[]) => {
      const definition = await contract();
      if (path === "describe") return { ...definition.element, properties: definition.properties,
        methods: definition.methods.map(({ transport: _transport, ...method }) => method) } satisfies ElementDescription;
      const method = definition.methods.find(method => method.name === path);
      if (!method) throw new Error(`${entry.name} has no method ${path}(). Use describe() to see its methods`);
      return invoke(connection.request, method, args);
    }, { get(_target, name: string | symbol) {
      if (typeof name !== "string" || name === "then") return undefined;
      return member(path ? `${path}.${name}` : name);
    } }) as RemoteMethod;
    return new Proxy(Object.create(null), { get(_target, name: string | symbol) {
      if (typeof name !== "string" || name === "then") return undefined;
      return member(name);
    } }) as Element;
  }
}

function invoke(request: Transport, method: MethodDefinition, args: unknown[]): Promise<unknown> {
  const optionsIndex = method.positional ? 1 : 0;
  if (args.length > optionsIndex + 1) throw new Error(`${method.name}() received too many arguments`);
  const options = args[optionsIndex] ?? {};
  if (typeof options !== "object" || options === null || Array.isArray(options)) throw new Error(`${method.name}() options must be an object`);
  const values = options as Record<string, unknown>;
  const allowed = new Set(method.arguments.filter(arg => arg.fixed === undefined && !(arg.in === "body" && arg.name === method.positional)).map(arg => arg.name));
  for (const key of Object.keys(values)) if (!allowed.has(key)) throw new Error(`Unknown option ${key} for ${method.name}()`);
  let path = method.transport.path;
  const query = new URLSearchParams();
  const body: Record<string, unknown> = {};
  let valueBody: unknown;
  for (const argument of method.arguments) {
    const value = argument.fixed ?? (argument.in === "body" && argument.name === method.positional ? args[0] : values[argument.name]);
    if (value === undefined) {
      if (argument.required) throw new Error(`${method.name}() requires ${argument.name}`);
      continue;
    }
    if (argument.in === "path") path = path.replaceAll(`{${argument.name}}`, encodeURIComponent(String(value)));
    else if (argument.in === "query") query.set(argument.name, String(value));
    else if (method.transport.body === "value") valueBody = value;
    else body[argument.name] = value;
  }
  if (/\{[^}]+\}/.test(path)) throw new Error(`${method.name}() is missing an argument`);
  if (query.size) path += `?${query}`;
  const value = method.transport.body === "object" ? body : valueBody;
  return request(path, { method: method.transport.method, headers: { "content-type": method.transport.media },
    ...(method.transport.body === "none" ? {} : { body: method.transport.media === "application/json" ? JSON.stringify(value) : String(value) }),
  });
}

const ht = new HomeTruth();
export default ht;
