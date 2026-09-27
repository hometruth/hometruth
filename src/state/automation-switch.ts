/**
 * The value of an `automation/<id>` node, built from an automation's own
 * on/off flag and status, so `<ht-switch>` renders it exactly like a device
 * with a `binarySwitch` capability. Pure: the caller stamps the read time,
 * which the document needs because a switch value is always dated
 * (`dependentRequired: value → observedAt`).
 */
import type { Availability } from "../models/capability";
import type { AutomationSwitch } from "./protocol";

export function automationSwitchDocument(id: string, name: string, enabled: boolean, status: Availability, observedAt: string): AutomationSwitch {
  return {
    id,
    name,
    status,
    capabilities: {
      binarySwitch: {
        id,
        state: { availability: status, value: enabled ? "on" : "off", observedAt },
        actions: { turnOn: {}, turnOff: {}, toggle: {}, getState: {} },
      },
    },
  };
}
