/**
 * Turning a token's subject into a set of device ids.
 *
 * A device subject names one id; group subjects resolve through the same
 * functions that resolve a group on the Groups page.
 * `{ group }` is looked up in `site.deviceGroups`, which is the list the page
 * renders; `{ criteria }` goes straight to `site.automaticGroupMembers`, which
 * is what the group builder calls. There is no second membership rule to keep
 * in step, so a token and a group can never disagree about what
 * `room = Kitchen` means.
 *
 * Resolution is per request and lazy. `{ all: true }` never touches the site at
 * all, and the resolved set is memoised for the life of one principal, so a
 * request that checks twenty devices resolves once.
 */
import type { AutomaticGroupCriteria } from "../schemas";
import { permits, type Permission, type TokenSubject } from "./model";
import type { TokenRecord } from "./store";

/** The slice of `Site` a principal needs; narrow so tests can hand over a literal. */
export interface ScopeSite {
  automaticGroupMembers(criteria: AutomaticGroupCriteria): string[];
  readonly deviceGroups: readonly { readonly id: string; readonly name: string; readonly members: readonly string[] }[];
}

/** Every device a subject covers, or `"all"` when it covers the site itself. */
export function subjectDevices(site: ScopeSite, subject: TokenSubject): "all" | ReadonlySet<string> {
  if ("all" in subject && subject.all) return "all";
  if ("device" in subject && typeof subject.device === "string") return new Set([subject.device]);
  if ("group" in subject && typeof subject.group === "string") {
    const group = site.deviceGroups.find(candidate => candidate.id === subject.group);
    // A subject naming a group that no longer exists reaches nothing. It is not
    // an error — deleting a group must narrow a token, never widen it.
    return new Set(group?.members ?? []);
  }
  const criteria = ("criteria" in subject ? subject.criteria : undefined) as AutomaticGroupCriteria | undefined;
  return new Set(criteria ? site.automaticGroupMembers(criteria) : []);
}

/**
 * Who is making this request, and what they may touch.
 *
 * Every authorization question in the app goes through one of these three
 * methods, so there is exactly one place where "may I" is answered.
 */
/** Where a principal's authority came from: a token it presented, or the network it is on. */
export type PrincipalOrigin = "token" | "local-network";

export class Principal {
  #devices: "all" | ReadonlySet<string> | undefined;

  constructor(readonly token: TokenRecord, readonly site: ScopeSite, readonly origin: PrincipalOrigin = "token") {}

  get kid(): string { return this.token.kid; }
  get name(): string { return this.token.name; }
  get permissions(): readonly Permission[] { return this.token.permissions; }

  /** Holds the verb, without reference to any particular device. */
  allows(permission: Permission): boolean {
    return permits(this.token.permissions, permission);
  }

  /** Holds the verb, and this device is in reach. */
  allowsDevice(deviceId: string, permission: Permission): boolean {
    if (!this.allows(permission)) return false;
    const devices = this.devices();
    return devices === "all" || devices.has(deviceId);
  }

  /**
   * A site-wide route — the tag ontology, network isolation, the token list.
   * Only a subject of `all` reaches these: a token scoped to the kitchen has no
   * business rewriting the ontology that decides what the kitchen is.
   */
  allowsSite(permission: Permission): boolean {
    return this.allows(permission) && this.devices() === "all";
  }

  /** Every device in reach, for narrowing a listing to what the caller may see. */
  devices(): "all" | ReadonlySet<string> {
    this.#devices ??= subjectDevices(this.site, this.token.subject);
    return this.#devices;
  }

  /** True when this authority came from being on the local network rather than from a token. */
  get isLocalNetwork(): boolean { return this.origin === "local-network"; }

  /** Whether one device is in reach, without asking about a verb. */
  reaches(deviceId: string): boolean {
    const devices = this.devices();
    return devices === "all" || devices.has(deviceId);
  }

  /**
   * Whether a whole set is in reach. All-or-nothing on purpose: this answers
   * for groups, and a group half in reach is not the group.
   */
  reachesAll(deviceIds: readonly string[]): boolean {
    if (this.devices() === "all") return true;
    return deviceIds.length > 0 && deviceIds.every(id => this.reaches(id));
  }

  /** Keeps only the entries this principal may see. */
  filter<T>(items: readonly T[], idOf: (item: T) => string): T[] {
    const devices = this.devices();
    return devices === "all" ? [...items] : items.filter(item => devices.has(idOf(item)));
  }
}

/** The id a local-network principal reports; never a real key id, which is hex. */
export const LOCAL_NETWORK_KID = "local-network";

/**
 * The authority a caller has purely by being on the local network.
 *
 * Everything, on every device, exactly as if an admin token had been
 * presented — that is what "open on the local network" means, and pretending
 * otherwise in the type would only hide it. What keeps it honest is that it is
 * built in one place, from an address the supervisor read off the socket, and
 * that it says so: `origin` is `local-network`, so the UI and `whoami` can
 * report how someone got in rather than implying they hold a token.
 */
export function localNetworkPrincipal(site: ScopeSite, address: string, now = new Date()): Principal {
  return new Principal({
    kid: LOCAL_NETWORK_KID,
    name: "Local network",
    permissions: ["admin"],
    subject: { all: true },
    createdAt: now.toISOString(),
    lastUsedFrom: address,
  }, site, "local-network");
}
