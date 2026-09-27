import { describe, expect, test } from "bun:test";
import { Button, type ButtonPressOptions } from "./button";
import { validators } from "../validation";

class MemoryButton extends Button {
  readonly presses: ButtonPressOptions[] = [];
  constructor(id: string, private readonly maximum?: number) { super(id); }
  protected override maximumDurationMs() { return this.maximum; }
  protected async performPress(options: ButtonPressOptions) { this.presses.push(options); }
}

describe("Button", () => {
  test("has one stateless press action and unknown availability by default", async () => {
    const button = new MemoryButton("candles-on", 60_000);
    const document = await button.describe();
    expect(validators.button(document)).toBe(true);
    expect(document).toEqual({ id: "candles-on", state: { availability: "unknown" }, actions: { press: { maximumDurationMs: 60_000 } } });
  });

  test("accepts an optional bounded duration and notifies only after success", async () => {
    const button = new MemoryButton("candles-on", 60_000);
    const observed: ButtonPressOptions[] = [];
    button.subscribe((options) => observed.push(options));
    await button.invoke("press");
    await button.invoke("press", { durationMs: 1_500 });
    expect(button.presses).toEqual([{}, { durationMs: 1_500 }]);
    expect(observed).toEqual(button.presses);
    await expect(button.invoke("press", { durationMs: 60_001 })).rejects.toMatchObject({ code: "invalid_value" });
  });

  test("a momentary-only button rejects a duration", async () => {
    await expect(new MemoryButton("doorbell").press({ durationMs: 1 })).rejects.toMatchObject({ code: "not_supported" });
  });
});
