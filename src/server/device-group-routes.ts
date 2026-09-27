import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { Hono, type Context } from "hono";
import type { DeviceConfigWriter } from "../config/device-writer";
import { criteriaProblem, groupSchemaChoices } from "../models/automatic-group";
import type { TagStore } from "../tags/store";
import { CapabilityError } from "../models/capability";
import { isGroupSwitch, SelectedDeviceGroup, type GroupSnapshot, type SwitchRequirement } from "../models/device-group";
import { automaticGroupCriteriaSchema, deviceGroupConfigSchema, deviceGroupSettingsSchema, type AutomaticGroupCriteria, type DeviceGroupConfig, type DeviceGroupSettings, type DeviceGroup } from "../schemas";
import type { StateHub } from "../state/hub";
import type { HomeTruthObject } from "../schemas";
import { deviceNode } from "../state/protocol";
import type { Site } from "../site";
import { renderDeviceGroupBuilder, renderSelectedGroupPage } from "../ui/device-group-page";
import { renderGroupsPage } from "../ui/groups-page";
import { renderGroupSwitchDefinition } from "../ui/switch-definition";
import { renderGroupSwitchPage } from "../ui/group-switch-page";
import { validators } from "../validation";
import { errorJson, pageContext, requestJson, type AppEnvironment } from "./http";

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const validGroup = ajv.compile<DeviceGroupConfig>(deviceGroupConfigSchema);
const validSettings = ajv.compile<DeviceGroupSettings>(deviceGroupSettingsSchema);
const REQUIREMENT_LABELS: Record<SwitchRequirement, string> = { "power.on": "power state", "power.turnOn": "On", "power.turnOff": "Off", "power.toggle": "Toggle" };
/** Names the members that keep a group from being a switch, for callers that never see the page. */
function switchGapDetail(snapshot: GroupSnapshot): string | undefined {
  const odd = snapshot.members.filter(member => member.missingForSwitch?.length);
  if (!odd.length) return undefined;
  const lacking = Object.keys(REQUIREMENT_LABELS).filter(id => odd.some(member => member.missingForSwitch!.includes(id as SwitchRequirement))).map(id => REQUIREMENT_LABELS[id as SwitchRequirement]);
  const prefix = `${odd.length} of ${snapshot.members.length} members lack ${lacking.join(", ")}: `;
  const names = odd.map(member => member.name);
  // Error details are capped at 500 characters; drop whole names rather than cutting one in half.
  let shown = names.length;
  let detail = prefix + names.join(", ");
  while (detail.length > 500 && shown > 1) { shown--; detail = `${prefix}${names.slice(0, shown).join(", ")} and ${names.length - shown} more`; }
  return detail;
}
const validSelection = ajv.compile<{ members?: string[]; criteria?: AutomaticGroupCriteria }>({ type: "object", additionalProperties: false,
  properties: { members: deviceGroupConfigSchema.properties.members, criteria: automaticGroupCriteriaSchema },
  oneOf: [{ properties: { members: {} }, required: ["members"] }, { properties: { criteria: {} }, required: ["criteria"] }],
});

export function deviceGroupRoutes(site: Site, tags: TagStore, hub: StateHub, writer?: DeviceConfigWriter, onControl?: (id: string, control: string) => void, onRead?: (group: DeviceGroup, snapshot: GroupSnapshot) => void) {
  const app = new Hono<AppEnvironment>();
  /**
   * A group is shown only when every member is in reach. `policy.ts` marks
   * these routes `listing`, which checks the verb and leaves the rows here; a
   * group half in reach is not the group, and a control on it would fan out to
   * devices this token may not touch.
   */
  const reachable = <T extends { readonly members: readonly string[] }>(context: Context<AppEnvironment>, groups: readonly T[]): T[] => {
    const principal = context.get("principal");
    return principal ? groups.filter(group => principal.reachesAll(group.members)) : [...groups];
  };
  const reachableDevices = <T extends { readonly id: string }>(context: Context<AppEnvironment>, devices: readonly T[]): T[] => {
    const principal = context.get("principal");
    return principal ? principal.filter(devices, device => device.id) : [...devices];
  };
  app.get("/groups", context => context.html(renderGroupsPage({ ctx: pageContext(context), groups: reachable(context, site.listGroups()), devices: reachableDevices(context, site.list()), canCreate: Boolean(writer?.addGroup) })));
  const linked = (snapshot: GroupSnapshot) => {
    const pages = site.pages();
    return { ...snapshot, members: snapshot.members.map(member => ({ ...member, page: pages.page("device", member.id) })) };
  };
  const resolve = (ids: readonly string[], automatic = false) => new SelectedDeviceGroup(ids.map(id => {
    const device = site.get(id);
    if (!device) throw new CapabilityError(`Device "${id}" is no longer available`, "invalid_value");
    return device;
  }), automatic, async device => {
    const record = await hub.observer.refresh(deviceNode(device.id));
    if (record.fault || !record.value) throw new Error(record.fault?.message ?? "No observation available");
    return record.value as HomeTruthObject;
  });
  const selection = (input: { members?: string[]; criteria?: AutomaticGroupCriteria }) => {
    const problem = input.criteria && criteriaProblem(input.criteria, site.models, site.devices, id => Boolean(tags.get(id)));
    if (problem) throw new CapabilityError(problem, "invalid_value");
    return resolve(input.criteria ? site.automaticGroupMembers(input.criteria) : input.members!, Boolean(input.criteria));
  };
  const builderOptions = () => ({ rooms: site.rooms, schemas: groupSchemaChoices(site.models, site.devices), tags: tags.list() });
  app.get("/groups/new", context => context.html(renderDeviceGroupBuilder({ ...builderOptions(), automatic: context.req.query("type") === "automatic", ctx: pageContext(context), devices: site.list(), canCreate: Boolean(writer?.addGroup) })));
  app.get("/groups/:slug", (context, next) => {
    const match = site.pages().resolve(new URL(context.req.url).pathname);
    if (match?.entry.source !== "group") return next();
    const group = site.listGroups().find(group => group.id === match.entry.id);
    return group ? context.html(renderSelectedGroupPage({ ctx: pageContext(context), group, snapshot: hub.data.group(group.id)!, ...builderOptions(), canEdit: !group.builtIn && Boolean(writer?.setGroupSettings),
      devices: site.list(),
      switchDefinition: group.asSwitch ? renderGroupSwitchDefinition(pageContext(context), site, group) : "",
    })) : context.notFound();
  });
  for (const suffix of ["", "/settings"]) app.get(`/switches/:slug${suffix}`, (context, next) => {
    const match = site.pages().resolve(new URL(context.req.url).pathname);
    if (match?.entry.source !== "group-switch") return next();
    const group = site.listGroups().find(group => group.id === match.entry.id)!;
    const members = group.members.flatMap(id => site.view(id) ?? []);
    return context.html(renderGroupSwitchPage({ ctx: pageContext(context), group, members, settingsView: suffix === "/settings", definition: renderGroupSwitchDefinition(pageContext(context), site, group) }));
  });
  app.get("/api/device-groups", context => context.json({ groups: reachable(context, site.listGroups()), writable: Boolean(writer?.addGroup) }));
  app.post("/api/device-groups/preview", async context => {
    const input = await requestJson(context);
    if (!validSelection(input)) return errorJson(context, 400, "invalid_request", "Choose tag, room, or type/schema criteria, or between 2 and 100 different devices");
    const snapshot = await selection(input).describe();
    return context.json({ ...linked(snapshot), canSwitch: isGroupSwitch(snapshot) });
  });
  app.post("/api/device-groups", async context => {
    if (!writer?.addGroup) return errorJson(context, 409, "not_supported", "Groups are read-only on this server");
    const input = await requestJson(context);
    if (!validGroup(input)) return errorJson(context, 400, "invalid_request", "Enter a group name, a valid id, and either criteria or between 2 and 100 different devices");
    if (input.id.startsWith("automatic:")) return errorJson(context, 400, "invalid_request", "Ids beginning with automatic: are reserved for built-in groups");
    if (site.deviceGroups.some(group => group.id === input.id)) return errorJson(context, 409, "already_exists", "A group with this id already exists");
    const selected = selection(input);
    if (input.asSwitch) {
      const snapshot = await selected.describe();
      if (!isGroupSwitch(snapshot)) return errorJson(context, 400, "invalid_request", "Every group member must share power state, On, Off, and Toggle to use this group as a switch", switchGapDetail(snapshot));
    }
    await writer.addGroup({ ...input, name: input.name.trim() });
    hub.data.configurationChanged();
    const page = site.pages().page("group", input.id);
    if (!page) throw new Error(`Saved group "${input.id}" was not loaded into the site`);
    return context.json({ id: input.id, page }, 201);
  });
  app.get("/api/device-groups/:id", async context => {
    const group = site.deviceGroups.find(group => group.id === context.req.param("id"));
    if (!group) return errorJson(context, 404, "not_found", "No group with that id");
    const snapshot = await resolve(group.members, Boolean(group.criteria)).describe();
    return context.json({ ...group, ...linked(snapshot), canSwitch: isGroupSwitch(snapshot) });
  });
  app.post("/api/device-groups/:id/settings", async context => {
    const group = site.deviceGroups.find(group => group.id === context.req.param("id"));
    if (!group) return errorJson(context, 404, "not_found", "No group with that id");
    if (!writer?.setGroupSettings) return errorJson(context, 409, "not_supported", "Groups are read-only on this server");
    const input = await requestJson(context);
    if (!validSettings(input)) return errorJson(context, 400, "invalid_request", "Choose valid group settings and between 2 and 100 different member devices");
    if (group.builtIn) return errorJson(context, 409, "not_supported", "Built-in automatic groups cannot be edited; create your own automatic group");
    if (group.criteria && input.members || !group.criteria && input.criteria) return errorJson(context, 400, "invalid_request", "Edit criteria for an automatic group, or members for a selected group");
    const settings = { ...input };
    if (input.members || input.criteria || input.asSwitch) {
      const selected = selection(group.criteria ? { criteria: input.criteria ?? group.criteria } : { members: input.members ?? group.members });
      const snapshot = await selected.describe();
      const canSwitch = isGroupSwitch(snapshot);
      if (input.asSwitch && !canSwitch) return errorJson(context, 400, "invalid_request", "Every group member must share power state, On, Off, and Toggle to use this group as a switch", switchGapDetail(snapshot));
      if ((input.members || input.criteria) && group.asSwitch && !canSwitch) settings.asSwitch = false;
    }
    await writer.setGroupSettings(group.id, settings);
    hub.data.configurationChanged();
    return context.json({ id: group.id, ...settings });
  });
  app.post("/api/device-groups/:id/controls/:control", async context => {
    const group = site.deviceGroups.find(group => group.id === context.req.param("id"));
    if (!group) return errorJson(context, 404, "not_found", "No group with that id");
    const input = await requestJson(context);
    if (!validators.deviceControlRequest(input)) return errorJson(context, 400, "invalid_request", "Invalid group control request");
    const control = context.req.param("control");
    const result = await resolve(group.members, Boolean(group.criteria)).invoke(control, input.value, input.confirmed === undefined ? {} : { confirmed: input.confirmed });
    for (const member of result.results) if (member.ok) onControl?.(member.id, control);
    return context.json({ ...result, group: { ...linked(result.group), canSwitch: isGroupSwitch(result.group) } });
  });
  // Group switches use their own endpoint so group and device ids cannot collide.
  const switchResponse = async (context: Parameters<typeof errorJson>[0], action?: "turnOn" | "turnOff" | "toggle") => {
    const group = site.deviceGroups.find(group => group.id === context.req.param("id") && group.asSwitch);
    if (!group) return errorJson(context, 404, "not_found", "No group switch with that id");
    const selected = resolve(group.members, Boolean(group.criteria));
    let snapshot = await selected.describe();
    if (!isGroupSwitch(snapshot)) return errorJson(context, 409, "not_supported", "This group no longer shares all switch controls", switchGapDetail(snapshot));
    if (action) {
      const result = await selected.invoke(`power.${action}`);
      for (const member of result.results) if (member.ok) onControl?.(member.id, `power.${action}`);
      if (!result.ok) return errorJson(context, 502, "member_failed", result.results.filter(member => !member.ok).map(member => `${member.name}: ${member.error}`).join("; "));
      snapshot = result.group;
    }
    onRead?.(group, snapshot);
    const power = snapshot.properties.find(property => property.id === "power.on")!;
    return context.json({ id: group.id, state: { availability: snapshot.availability,
      ...(power.status === "shared" && typeof power.value === "boolean" ? { value: power.value ? "on" : "off" } : {}),
    }, mixed: power.status === "mixed" });
  };
  app.get("/api/device-groups/:id/switch", context => switchResponse(context));
  app.post("/api/device-groups/:id/switch/turn-on", context => switchResponse(context, "turnOn"));
  app.post("/api/device-groups/:id/switch/turn-off", context => switchResponse(context, "turnOff"));
  app.post("/api/device-groups/:id/switch/toggle", context => switchResponse(context, "toggle"));
  return app;
}
