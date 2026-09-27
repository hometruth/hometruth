/**
 * What `ht` knows about an install it has never seen before.
 *
 * Nothing here is a list of devices, capabilities or controls: those come from
 * the install, every time. An id names a device, a group or a service; the
 * install says which, what it is made of, and what may be done to it. The
 * value a control takes is read from the action document the capability
 * publishes — `setBrightness` says `0–100 percent` because the light said so,
 * not because this file knows what a light is.
 */
import { HttpError, UsageError, type Client } from "./client.ts";
import { controlCommand } from "./commands";
import { isElementKey, type ElementKind } from "../tags/identity";
import type { GraphNode } from "../graph/types";
export type { ElementKind } from "../tags/identity";

/** One thing that may be done to an element, as the install describes it. */
export interface Control {
  /** The control id sent to the install. */
  readonly id: string;
  /** The name you type. */
  readonly name: string;
  /** The capability that owns it, when one does. */
  readonly owner?: string;
  /** What its value must be, read from the action document; absent when the document does not bound one. */
  readonly value?: string;
  /** The action asks to be confirmed, so invoking it needs `--confirm`. */
  readonly confirm: boolean;
  /** What it has left standing, for an action whose effect lasts. */
  readonly until?: string;
}

/** A readable line of an element's current state: a label and a value. */
export interface Reading {
  readonly label: string;
  readonly value: string;
}

/** One section of an element's state: a capability, a group's shared properties, a service's detail. */
export interface Section {
  readonly title: string;
  readonly status?: string;
  readonly readings: readonly Reading[];
}

export interface Element {
  readonly page?: string;
  readonly kind: ElementKind;
  readonly id: string;
  readonly name: string;
  /** Availability as the install spells it: online, offline, degraded, unknown. */
  readonly status: string;
  /** What it is, in one phrase: the model title, "group of 4", the service title. */
  readonly what: string;
  /** Sub-heading facts: manufacturer, connection, room, member count. */
  readonly facts: readonly string[];
  readonly sections: readonly Section[];
  readonly controls: readonly Control[];
  /** The state-graph node to subscribe to, when the install publishes one. */
  readonly node?: string;
  /** Exactly what the install answered, for `--json`. */
  readonly body: unknown;
}

interface DeviceDetail {
  readonly page?: string;
  readonly id: string;
  readonly name: string;
  readonly room?: string;
  readonly model: {
    readonly title: string;
    readonly manufacturer?: string;
    readonly capabilities: readonly string[];
    readonly connectionTypes?: readonly string[];
    readonly sensors?: readonly { readonly name: string }[];
  };
  readonly config?: Record<string, unknown>;
  readonly controls?: readonly string[];
  readonly enabled: boolean;
  readonly object: {
    readonly status?: string;
    readonly capabilities?: Record<string, { readonly state?: Record<string, unknown>; readonly actions?: Record<string, unknown> }>;
    readonly sensors?: readonly { readonly name: string; readonly state?: Record<string, unknown> }[];
  };
}

interface GroupDetail {
  readonly page?: string;
  readonly id: string;
  readonly name: string;
  readonly room?: string;
  readonly availability: string;
  readonly members: readonly { readonly id: string; readonly name: string; readonly availability: string }[];
  readonly properties: readonly { readonly id: string; readonly status: string; readonly value?: unknown }[];
  readonly actions: readonly { readonly id: string; readonly control: string; readonly input: string; readonly bounds: Record<string, unknown>; readonly confirmation: boolean }[];
  readonly criteria?: unknown;
}

interface ServiceRow {
  readonly page?: string;
  readonly id: string;
  readonly title: string;
  readonly availability: string;
  readonly detail: string;
  readonly actions?: readonly { readonly id: string; readonly until?: string }[];
}

/**
 * Which of the install's element kinds this id names. Asked in the order the
 * ids are most likely to be used, and each miss is a cheap 404; an install
 * with none of them says so once, rather than three times.
 */
export async function resolve(api: Client, id: string): Promise<Element> {
  if (isElementKey(id)) {
    const graph = await api.get(`/api/graph/${encodeURIComponent(id)}`) as { nodes: { node: GraphNode }[] };
    const node = graph.nodes.find(entry => entry.node.id === id)?.node;
    if (!node) throw new UsageError(`No element called "${id}"`);
    return { kind: node.kind, id, name: node.name, page: node.page || `/elements/${id}`, status: "", what: node.context, facts: [], sections: [], controls: [], body: node, ...(node.stateNode ? { node: node.stateNode } : {}) };
  }
  const device = await optional<DeviceDetail>(api.get(`/api/devices/${encodeURIComponent(id)}`));
  if (device) return deviceElement(device);
  const group = await optional<GroupDetail>(api.get(`/api/device-groups/${encodeURIComponent(id)}`));
  if (group) return groupElement(group);
  const services = await api.get("/api/services") as { services?: readonly ServiceRow[] };
  const service = (services.services ?? []).find((candidate) => candidate.id === id);
  if (service) return serviceElement(service);
  const tagged = await optional<{ tag: { id: string; name: string; value: string }; page: string }>(api.get(`/api/tags/${encodeURIComponent(id)}`));
  if (tagged) return { kind: "tag", id, name: [tagged.tag.name, tagged.tag.value].filter(Boolean).join(": "), page: tagged.page, status: "", what: "", facts: [], sections: [], controls: [], body: tagged };
  throw new UsageError(`Nothing here is called "${id}". Run "ht ls" for the devices, "ht ls group" or "ht ls service"`);
}

/**
 * The same reading, applied to a body already in hand. A control returns the
 * element it acted on, so its new state is printed from that answer rather
 * than asked for a second time.
 */
export function elementFrom(body: unknown, kind: "device" | "group"): Element | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  try {
    return kind === "group" ? groupElement(body as GroupDetail) : deviceElement(body as DeviceDetail);
  } catch {
    return undefined;
  }
}

async function optional<T>(request: Promise<unknown>): Promise<T | undefined> {
  try {
    return await request as T;
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return undefined;
    throw error;
  }
}

/** Where a control on this element is invoked, and what the install expects in the body. */
export function invoke(api: Client, element: Element, control: string, value: unknown, confirm: boolean): Promise<unknown> {
  if (element.kind === "service") {
    return api.post(`/api/services/${encodeURIComponent(element.id)}/actions/${encodeURIComponent(control)}`, {});
  }
  const base = element.kind === "group" ? "/api/device-groups" : "/api/devices";
  return api.post(`${base}/${encodeURIComponent(element.id)}/controls/${encodeURIComponent(control)}`, {
    ...(value !== undefined ? { value } : {}),
    ...(confirm ? { confirmed: true } : {}),
  });
}

function deviceElement(detail: DeviceDetail): Element {
  const capabilities = detail.object.capabilities ?? {};
  const sections: Section[] = Object.entries(capabilities).map(([kind, document]) => ({
    title: kind,
    ...(typeof document.state?.availability === "string" ? { status: document.state.availability } : {}),
    readings: readingsOf(document.state ?? {}),
  }));
  for (const sensor of detail.object.sensors ?? []) {
    sections.push({
      title: `${sensor.name} sensor`,
      ...(typeof sensor.state?.availability === "string" ? { status: sensor.state.availability } : {}),
      readings: readingsOf(sensor.state ?? {}),
    });
  }
  const facts = [
    ...(detail.model.manufacturer ? [detail.model.manufacturer] : []),
    ...detail.model.capabilities,
    ...(detail.model.connectionTypes ?? []),
    ...(detail.enabled ? [] : ["disabled"]),
  ];
  return {
    kind: "device",
    ...(detail.page ? { page: detail.page } : {}),
    id: detail.id,
    name: detail.name,
    status: detail.object.status ?? "unknown",
    what: detail.model.title,
    facts: [...facts, ...(detail.room ? [detail.room] : []), ...configFacts(detail.config)],
    sections,
    controls: (detail.controls ?? []).map((name) => describeControl(name, capabilities)),
    node: `device/${detail.id}`,
    body: detail,
  };
}

function groupElement(detail: GroupDetail): Element {
  const shared = detail.properties.map((property): Reading => ({
    label: property.id,
    value: property.status === "shared" ? show(property.value) : property.status,
  }));
  return {
    kind: "group",
    ...(detail.page ? { page: detail.page } : {}),
    id: detail.id,
    name: detail.name,
    status: detail.availability,
    what: `${detail.criteria ? "automatic group" : "group"} of ${detail.members.length}`,
    facts: detail.room ? [detail.room] : [],
    sections: [
      ...(shared.length ? [{ title: "shared", readings: shared }] : []),
      { title: "members", readings: detail.members.map((member) => ({ label: member.id, value: `${member.name} · ${member.availability}` })) },
    ],
    controls: detail.actions.map((action): Control => ({
      id: action.id,
      name: controlCommand(action.id),
      confirm: action.confirmation,
      ...(boundsText(action.bounds) ? { value: boundsText(action.bounds)! } : action.input === "none" ? {} : { value: action.input }),
    })),
    node: `group/${detail.id}`,
    body: detail,
  };
}

function serviceElement(service: ServiceRow): Element {
  return {
    kind: "service",
    ...(service.page ? { page: service.page } : {}),
    id: service.id,
    name: service.title,
    status: service.availability,
    // A service is only ever itself; the kind already says so.
    what: "",
    facts: [],
    sections: [{ title: "detail", readings: service.detail.split("; ").map((part, index) => ({ label: index === 0 ? "status" : "", value: part })) }],
    controls: (service.actions ?? []).map((action): Control => ({
      id: action.id,
      name: controlCommand(action.id),
      confirm: false,
      ...(action.until ? { until: action.until } : {}),
    })),
    body: service,
  };
}

/**
 * A control as the capability that owns it describes it. The name is the one
 * the install accepts (`pan.left`, `infraredBlaster.send`); its action
 * document is found by walking the same path, once the capability qualifier
 * is taken off the front.
 */
function describeControl(name: string, capabilities: Record<string, { readonly actions?: Record<string, unknown> }>): Control {
  for (const [kind, document] of Object.entries(capabilities)) {
    const path = name.startsWith(`${kind}.`) ? name.slice(kind.length + 1) : name;
    const action = at(document.actions, path.split("."));
    if (action === undefined) continue;
    const bounds = boundsText(action);
    return {
      id: name,
      name: controlCommand(name),
      owner: kind,
      confirm: isRecord(action) && action.confirmation === "confirm",
      ...(bounds ? { value: bounds } : {}),
    };
  }
  // A control the capability accepts but does not advertise (a light's
  // getState). It works; the document simply says nothing about it.
  const owner = Object.keys(capabilities).find((kind) => name.startsWith(`${kind}.`));
  return { id: name, name: controlCommand(name), confirm: false, ...(owner ? { owner } : {}) };
}

function at(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const step of path) {
    if (!isRecord(current)) return undefined;
    current = current[step];
  }
  return current;
}

/**
 * What an action's own document says its value must be. The pairs are read by
 * shape, not by name: any `minimum…`/`maximum…` or `min…`/`max…` with the same
 * tail is a range, an array is a set of choices, and anything left is printed
 * as it stands. A capability that adds a new bound gets a useful line here
 * with no change to this file.
 */
export function boundsText(action: unknown): string | undefined {
  if (!isRecord(action)) return undefined;
  const parts: string[] = [];
  const used = new Set<string>(["confirmation"]);
  for (const [key, value] of Object.entries(action)) {
    const low = /^min(?:imum)?(.+)$/u.exec(key);
    if (!low) continue;
    const tail = low[1]!;
    const high = Object.keys(action).find((candidate) => new RegExp(`^max(?:imum)?${escape(tail)}$`, "u").test(candidate));
    if (!high) continue;
    used.add(key);
    used.add(high);
    parts.push(`${show(value)}–${show(action[high])} ${words(tail)}`);
  }
  for (const [key, value] of Object.entries(action)) {
    if (used.has(key)) continue;
    if (Array.isArray(value)) parts.push(`${words(key)} ${value.map(show).join(", ")}`);
    else parts.push(`${words(key)} ${show(value)}`);
  }
  return parts.length ? parts.join(", ") : undefined;
}

function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** `maximumTransitionMs` → `transition ms`; the tail of a bound read as words. */
function words(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").toLowerCase();
}

/**
 * A capability's state as lines. `availability` is the section's own heading,
 * and the provenance keys go last: what the thing *is* doing is the answer,
 * when it was last seen doing it is the footnote.
 */
const PROVENANCE = ["stateSource", "commandedAt", "observedAt"];
function readingsOf(state: Record<string, unknown>): Reading[] {
  const rank = (key: string) => { const index = PROVENANCE.indexOf(key); return index < 0 ? -1 : index; };
  return Object.entries(state)
    .filter(([key]) => key !== "availability")
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([key, value]) => ({ label: key, value: show(value) }));
}

/** A device's config, flattened to the short facts worth a heading line. */
function configFacts(config: Record<string, unknown> | undefined): string[] {
  return Object.entries(config ?? {})
    .filter(([, value]) => value !== undefined && typeof value !== "object")
    .map(([key, value]) => `${key} ${show(value)}`);
}

export function show(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
