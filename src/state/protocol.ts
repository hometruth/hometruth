/**
 * The vocabulary the state graph, its stream, and the browser components
 * share: node ids, node records, faults, and the frames of
 * `GET /api/state/stream`. Types only plus the node-id grammar; nothing here
 * touches Bun, the DOM, or a device, so a browser module may `import type`
 * from it and a server module may import the grammar helpers.
 *
 * A node is one observable subject: `device/<id>` holds the device's
 * validated HomeTruth object document; `group/<id>` holds a group switch
 * document (`GroupSwitch`); `automation/<id>` holds an automation's own
 * on/off state as the same shape (`AutomationSwitch`) — an automation is not
 * a device, it has no host or config, just a binary switch a service
 * publishes into the graph. Components subscribe to the node they were
 * instantiated with and read `value.capabilities[kind]` themselves, so the
 * unit on the wire is exactly the unit the API and the CLI already speak.
 */
import type { Availability } from "../models/capability";
import type { MemberSnapshot } from "../models/device-group";
import type { BinarySwitch, HomeTruthObject } from "../schemas";

export type NodeKind = "device" | "group" | "automation";
export type NodeId = `${NodeKind}/${string}`;

/** A node id: the kind, a slash, then a device, group, or automation id as `schemas.ts` spells them. */
export const NODE_ID_PATTERN = /^(device|group|automation)\/([A-Za-z0-9][A-Za-z0-9._:-]{0,199})$/u;

export interface ParsedNode {
  readonly kind: NodeKind;
  /** The device, group, or automation id without the kind prefix. */
  readonly id: string;
}

export function parseNode(value: string): ParsedNode | undefined {
  const match = NODE_ID_PATTERN.exec(value);
  if (!match) return undefined;
  return { kind: match[1] as NodeKind, id: match[2]! };
}

export function isNodeId(value: unknown): value is NodeId {
  return typeof value === "string" && NODE_ID_PATTERN.test(value);
}

export const deviceNode = (deviceId: string): NodeId => `device/${deviceId}`;
export const groupNode = (groupId: string): NodeId => `group/${groupId}`;
export const automationNode = (automationId: string): NodeId => `automation/${automationId}`;

/**
 * Why a node could not be read. `unconfigured`: no such device or group in
 * the site. `timeout`: the read lost the 3 s race. `unreachable`: the read
 * threw. `invalid`: the device answered with a document that failed its
 * schema. `disabled`: the device is switched off, so the read was skipped
 * rather than attempted. The message names the problem and the fix, the way
 * the device detail route already phrases it.
 */
export type FaultCode = "unreachable" | "timeout" | "invalid" | "unconfigured" | "disabled";

export interface Fault {
  readonly code: FaultCode;
  readonly message: string;
}

/**
 * One node's current record: what the graph stores, what a `state` frame
 * carries, and what a page embeds in `#ht-state`. A fault keeps the last good
 * value beside it, so a component can still enumerate the document's actions
 * and attempt a command on a device that stopped answering; it must never
 * present that value's state as current.
 */
export interface NodeRecord<V = unknown> {
  readonly node: NodeId;
  /** 0 until first observed; bumps only when `value` or `fault` changed structurally (every `observedAt` key ignored). */
  readonly version: number;
  readonly value?: V;
  readonly fault?: Fault;
  /** Newest successful observation, ISO 8601. Refreshes without bumping `version`. */
  readonly observedAt?: string;
  /** When `version` last changed, ISO 8601. */
  readonly updatedAt: string;
}

/** How often a subscriber wants a node observed: a device page asks `live`, a list of rows asks `glance`. */
export type Tier = "live" | "glance";
export const TIERS: readonly Tier[] = ["live", "glance"];
export function isTier(value: unknown): value is Tier {
  return value === "live" || value === "glance";
}

/** The first frame of every stream: which worker generation answered and what it will send. */
export interface StreamHello {
  readonly generation: string;
  readonly tier: Tier;
  readonly nodes: readonly NodeId[];
  readonly keepaliveMs: number;
}

/** Polls that changed nothing, coalesced once per flush: node id → newest `observedAt`. */
export type StreamObserved = Readonly<Record<string, string>>;

export interface StreamError {
  readonly code: "too_many_streams";
  readonly message: string;
}

export type StreamFrame =
  | { readonly event: "hello"; readonly data: StreamHello }
  | { readonly event: "state"; readonly data: NodeRecord }
  | { readonly event: "observed"; readonly data: StreamObserved }
  | { readonly event: "error"; readonly data: StreamError };

/** Hard limits of one process; over either, the stream still answers 200 and says so in an `error` frame. */
export const STREAM_LIMITS = { maxNodes: 200, maxStreams: 64, keepaliveMs: 20_000, retryMs: 2_000, retryWhenFullMs: 30_000 } as const;

/**
 * The value of a `group/<id>` node: a device group that is used as a switch,
 * shaped so `<ht-switch>` renders it exactly like a device with a
 * `binarySwitch` capability. `capabilities.binarySwitch.state.value` is
 * present only while every member agrees; `group.mixed` says they do not;
 * `group.canSwitch` is false while a member lacks one of the power controls,
 * and `group.members[].missingForSwitch` names what each one lacks.
 */
export interface GroupSwitch {
  readonly id: string;
  readonly name: string;
  readonly status: Availability;
  readonly capabilities: { readonly binarySwitch: BinarySwitch };
  readonly group: {
    readonly mixed: boolean;
    readonly canSwitch: boolean;
    readonly members: readonly MemberSnapshot[];
  };
}

/**
 * The value of an `automation/<id>` node: an automation's own on/off state,
 * shaped so `<ht-switch>` renders it exactly like a device with a
 * `binarySwitch` capability. Not a device: no host, no config, no other
 * capabilities.
 */
export interface AutomationSwitch {
  readonly id: string;
  readonly name: string;
  readonly status: Availability;
  readonly capabilities: { readonly binarySwitch: BinarySwitch };
}

/** What a node's `value` is, by node kind. */
export type NodeValue<Id extends NodeId> = Id extends `group/${string}` ? GroupSwitch : Id extends `automation/${string}` ? AutomationSwitch : HomeTruthObject;
