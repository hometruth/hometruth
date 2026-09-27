/**
 * The value of a `group/<id>` node, built from the same group snapshot the
 * group switch route folds today, so `<ht-switch>` renders a group exactly
 * like a device with a `binarySwitch` capability. Pure: the caller stamps
 * the read time, which the document needs because a switch value is always
 * dated (`dependentRequired: value → observedAt`).
 */
import { isGroupSwitch, type GroupSnapshot } from "../models/device-group";
import type { DeviceGroup } from "../schemas";
import type { GroupSwitch } from "./protocol";

export function groupSwitchDocument(group: DeviceGroup, snapshot: GroupSnapshot, observedAt: string): GroupSwitch {
  const canSwitch = isGroupSwitch(snapshot);
  const power = snapshot.properties.find((property) => property.id === "power.on");
  const shared = canSwitch && power?.status === "shared" && typeof power.value === "boolean";
  return {
    id: group.id,
    name: group.name,
    status: snapshot.availability,
    capabilities: {
      binarySwitch: {
        id: group.id,
        state: {
          availability: snapshot.availability,
          ...(shared ? { value: power.value ? "on" : "off", observedAt } : {}),
        },
        actions: { turnOn: {}, turnOff: {}, toggle: {}, getState: {} },
      },
    },
    group: {
      mixed: power?.status === "mixed",
      canSwitch,
      members: snapshot.members,
    },
  };
}
