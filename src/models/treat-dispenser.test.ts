import { describe, expect, test } from "bun:test";
import { validators } from "../validation";
import { TreatDispenser, type DispenseBounds } from "./treat-dispenser";

class FakeDispenser extends TreatDispenser {
  dispensed: number[] = [];
  calls = 0;
  constructor(private readonly limits: DispenseBounds, private readonly withCall = false) {
    super("treats");
    if (withCall) this.playCall = async () => { this.calls += 1; };
  }
  async state() { return { availability: "online" as const, lowFood: false };
  }
  async bounds() { return this.limits; }
  async dispense(portions: number) { this.dispensed.push(portions); }
}

describe("TreatDispenser", () => {
  test("describes its bounds and optional call sound as a valid TreatDispenser document", async () => {
    const dispenser = new FakeDispenser({ minimumPortions: 1, maximumPortions: 10, step: 1, portionSizeGrams: 2.5 }, true);
    const document = await dispenser.describe();
    expect(validators.treatDispenser(document)).toBe(true);
    expect(document.actions).toEqual({ dispense: { minimumPortions: 1, maximumPortions: 10, step: 1, portionSizeGrams: 2.5, confirmation: "none" }, playCall: {} });
    expect(document.state).toEqual({ availability: "online", lowFood: false });
    const plain = await new FakeDispenser({ minimumPortions: 1, maximumPortions: 3, step: 1 }).describe();
    expect(plain.actions.playCall).toBeUndefined();
  });

  test("enforces the declared bounds, step, and confirmation", async () => {
    const dispenser = new FakeDispenser({ minimumPortions: 2, maximumPortions: 10, step: 2, confirmation: "confirm" });
    await expect(dispenser.invoke("dispense", 4)).rejects.toMatchObject({ code: "confirmation_required" });
    await dispenser.invoke("dispense", 4, { confirmed: true });
    await dispenser.invoke("dispense", undefined, { confirmed: true });
    expect(dispenser.dispensed).toEqual([4, 2]);
    await expect(dispenser.invoke("dispense", 3, { confirmed: true })).rejects.toMatchObject({ code: "invalid_value" });
    await expect(dispenser.invoke("dispense", 12, { confirmed: true })).rejects.toMatchObject({ code: "invalid_value" });
    await expect(dispenser.invoke("dispense", "two", { confirmed: true })).rejects.toMatchObject({ code: "invalid_value" });
    await expect(dispenser.invoke("playCall")).rejects.toMatchObject({ code: "not_supported" });
    await expect(dispenser.invoke("refill")).rejects.toMatchObject({ code: "unknown_control" });
  });

  test("plays the call sound when the product has one", async () => {
    const dispenser = new FakeDispenser({ minimumPortions: 1, maximumPortions: 5, step: 1 }, true);
    await dispenser.invoke("playCall");
    expect(dispenser.calls).toBe(1);
  });
});
