/**
 * Runtime composition for objects that explicitly publish callable methods.
 * The group publishes only the intersection of its members' method lists and
 * fans each call out concurrently. Capability-specific groups can build their
 * state reduction on top of this without duplicating the method plumbing.
 */

export interface MethodPublisher {
  readonly methods: readonly string[];
}

/** Optional fast path for members that can perform one shared call atomically (or in one protocol frame). */
export const GROUP_INVOKE = Symbol("HomeTruth.groupInvoke");

export interface GroupInvocationResult {
  readonly results: readonly unknown[];
}

export interface GroupMethodBatcher {
  [GROUP_INVOKE](members: readonly MethodPublisher[], name: string, args: readonly unknown[]): Promise<GroupInvocationResult | undefined>;
}

type CallableKeys<T> = { [K in keyof T]-?: T[K] extends (...args: never[]) => unknown ? K : never }[keyof T];
export type GroupedMethods<T extends MethodPublisher> = {
  [K in Extract<CallableKeys<T>, string>]: T[K] extends (...args: infer Args) => infer Result
    ? (...args: Args) => Promise<Awaited<Result>[]>
    : never;
};

export class MethodGroupError extends Error {
  constructor(message: string, readonly code: "too_few_members" | "unknown_method") {
    super(message);
    this.name = "MethodGroupError";
  }
}

export class MethodGroup {
  readonly members: readonly MethodPublisher[];
  readonly methods: readonly string[];

  constructor(members: readonly MethodPublisher[]) {
    if (members.length < 2) {
      throw new MethodGroupError("A group needs at least two members", "too_few_members");
    }
    this.members = Object.freeze([...members]);
    const [first, ...rest] = members as [MethodPublisher, ...MethodPublisher[]];
    this.methods = Object.freeze(first.methods.filter((name, index, methods) =>
      methods.indexOf(name) === index
      && !(name in this)
      && typeof (first as unknown as Record<string, unknown>)[name] === "function"
      && rest.every((member) => member.methods.includes(name) && typeof (member as unknown as Record<string, unknown>)[name] === "function"),
    ));

    for (const name of this.methods) {
      if (name in this) continue;
      Object.defineProperty(this, name, {
        value: (...args: unknown[]) => this.invoke(name, ...args),
        enumerable: false,
        configurable: false,
        writable: false,
      });
    }
  }

  /** Call one shared method on every member concurrently, preserving member order in the results. */
  async invoke(name: string, ...args: unknown[]): Promise<unknown[]> {
    if (!this.methods.includes(name)) {
      throw new MethodGroupError(`The group does not share method "${name}"`, "unknown_method");
    }
    const batch = (this.members[0] as Partial<GroupMethodBatcher>)[GROUP_INVOKE];
    if (batch) {
      const result = await batch.call(this.members[0], this.members, name, args);
      if (result) return [...result.results];
    }
    return await Promise.all(this.members.map(async (member) => {
      const method = (member as unknown as Record<string, (...values: unknown[]) => unknown>)[name]!;
      return await method.apply(member, args);
    }));
  }
}

/** Typed constructor for application code that wants to call the shared methods directly. */
export function groupMethods<T extends MethodPublisher>(members: readonly T[]): MethodGroup & GroupedMethods<T> {
  return new MethodGroup(members) as MethodGroup & GroupedMethods<T>;
}
