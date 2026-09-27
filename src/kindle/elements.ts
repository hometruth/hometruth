import type { CapabilityKind } from "../models/capability";
import type { RegisteredDevice, Site } from "../site";

export type KindleElement = Pick<RegisteredDevice, "id" | "name" | "room" | "model" | "modelTitle" | "capabilities" | "page"> & {
  source: "device" | "group";
};

/** Include saved groups without hiding their individual members or conflating IDs. */
export function kindleElements(site: Site): KindleElement[] {
  return [
    ...site.list().map(({ id, name, room, model, modelTitle, capabilities, page }) => ({ id, name, ...(room ? { room } : {}), model, modelTitle, capabilities, page, source: "device" as const })),
    ...site.deviceGroups.map(group => {
      const members = group.members.map(id => site.get(id));
      const capabilities = [...(members[0]?.model.capabilities ?? [])].filter(kind => members.every(member => member?.model.capabilities.includes(kind)));
      const power = members.length > 0 && members.every(member => member && ["light", "binarySwitch"].some(kind => member.model.capabilities.includes(kind as CapabilityKind)));
      if (power && !capabilities.includes("light") && !capabilities.includes("binarySwitch")) capabilities.unshift("binarySwitch");
      return { id: group.id, name: group.name, ...(group.room ? { room: group.room } : {}), model: "device-group", modelTitle: "Group", capabilities, page: site.pages().page("group", group.id)!, source: "group" as const };
    }),
  ];
}

// Device IDs cannot contain '/', so this also distinguishes a group from a same-ID device.
export function kindleElementKey(element: Pick<KindleElement, "source" | "id">): string {
  return element.source === "group" ? `group/${element.id}` : element.id;
}
