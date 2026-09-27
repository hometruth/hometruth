import { describe, expect, test } from "bun:test";
import { MethodGroup, groupMethods } from "./method-group";

function member(methods: readonly string[], calls: string[], id: string) {
  return {
    methods,
    async turnOn() { calls.push(`${id}:turnOn`); },
    async turnOff() { calls.push(`${id}:turnOff`); },
    async setColor(value: string) { calls.push(`${id}:setColor:${value}`); },
  };
}

describe("MethodGroup", () => {
  test("publishes only methods every member exposes and fans calls out", async () => {
    const calls: string[] = [];
    const group = new MethodGroup([
      member(["turnOn", "turnOff", "setColor"], calls, "one"),
      member(["turnOn", "turnOff"], calls, "two"),
    ]);

    expect(group.methods).toEqual(["turnOn", "turnOff"]);
    expect(typeof (group as unknown as { turnOn: unknown }).turnOn).toBe("function");
    expect((group as unknown as { setColor?: unknown }).setColor).toBeUndefined();
    await (group as unknown as { turnOn(): Promise<void[]> }).turnOn();
    expect(calls).toEqual(["one:turnOn", "two:turnOn"]);
    await expect(group.invoke("setColor", "#ff0000")).rejects.toMatchObject({ code: "unknown_method" });
  });

  test("requires more than one member", () => {
    expect(() => new MethodGroup([member(["turnOn"], [], "one")])).toThrow(/at least two/u);
  });

  test("offers a typed constructor for direct shared-method calls", async () => {
    const calls: string[] = [];
    const group = groupMethods([
      member(["turnOn", "turnOff"], calls, "one"),
      member(["turnOn", "turnOff"], calls, "two"),
    ]);
    await group.turnOff();
    expect(calls).toEqual(["one:turnOff", "two:turnOff"]);
  });
});
