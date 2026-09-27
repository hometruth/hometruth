import type { FromSchema } from "json-schema-to-ts";
import { Capability, CapabilityError } from "./capability";
import { cooktopSchema } from "./cooktop-schema";
import { validators } from "../validation";

export type CooktopDocument = FromSchema<typeof cooktopSchema>;
export type CooktopState = CooktopDocument["state"];

/** Observation plus auxiliary controls. No burner-start or heat-setting action. */
export abstract class Cooktop extends Capability<CooktopDocument> {
  readonly kind = "cooktop" as const;
  readonly controlIds = ["getState", "setChildLock", "setTimer"] as const;
  readonly methods = ["getState", "setChildLock", "setTimer"] as const;
  abstract getState(): Promise<CooktopState>;
  abstract setChildLock(locked: boolean): Promise<void>;
  abstract setTimer(seconds: number): Promise<void>;
  protected abstract allowedControls(): Promise<{ lock: boolean; timer: boolean }>;
  override async describe(): Promise<CooktopDocument> {
    const state = await this.getState();
    const allowed = state.availability === "online" ? await this.allowedControls() : { lock: false, timer: false };
    const doc = { id: this.id, state, actions: { getState: {}, ...(allowed.lock ? { setChildLock: {} } : {}), ...(allowed.timer ? { setTimer: {} } : {}) } };
    if (!validators.cooktop(doc)) throw new Error("Invalid cooktop document");
    return doc;
  }
  override async invoke(control: string, value?: unknown): Promise<unknown> {
    if (control === "getState") return this.getState();
    if (control === "setChildLock") {
      if (typeof value !== "boolean") throw new CapabilityError("Child lock takes a boolean", "invalid_value");
      return this.setChildLock(value);
    }
    if (control === "setTimer") {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 5940) throw new CapabilityError("Timer takes whole seconds from 0 to 5940", "invalid_value");
      return this.setTimer(value);
    }
    return this.unknownControl(control);
  }
}
