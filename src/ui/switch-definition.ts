import type { ActionButtonConfig } from "../devices/composites/action-button";
import type { OptimisticSwitchConfig } from "../devices/composites/optimistic-switch";
import type { SyntheticSwitchConfig } from "../devices/composites/synthetic-switch";
import type { LutronCasetaConfig } from "../devices/switches/lutron-caseta";
import type { ShellyPlus1Config } from "../devices/switches/shelly-plus-1";
import type { Device } from "../models/device";
import type { DeviceGroup } from "../schemas";
import type { Site } from "../site";
import type { SavedSignalCode } from "../schemas";
import { escapeHtml, type PageContext } from "./shell";

/** The same-origin routes a device switch answers on; the definition quotes them so a reader can replay a control by hand. */
export const SWITCH_API = {
  state: "/api/switches/:id/state",
  turnOn: "/api/switches/:id/turn-on",
  turnOff: "/api/switches/:id/turn-off",
  toggle: "/api/switches/:id/toggle",
} as const;

type Action = "turnOn" | "turnOff" | "toggle" | "getState";
interface Target { id: string; name: string; page: string }
interface Command { target: Target; call: string; transport?: string; payload?: string }
interface Operation { action: Action; request: string; commands: Command[]; note?: string }
interface Definition { source: Target; kind: string; detail?: string; operations: Operation[]; groups?: Target[] }

export const SWITCH_DEFINITION_CSS = String.raw`
  .switch-definition code { overflow-wrap: anywhere; white-space: pre-wrap; }
  .switch-definition .definition-commands { list-style: none; margin: var(--s2) 0; padding: 0; }
  .definition-commands li + li { margin-top: var(--s2); }
  .definition-commands code { display: block; }
  .definition-source a, .definition-commands a { color: inherit; text-decoration: none; }
  .definition-source .mono, .definition-commands .mono { font-size: .8125rem; color: var(--muted); }
`;

function deviceTarget(site: Site, id: string): Target {
  return { id, name: site.get(id)?.name ?? id, page: site.view(id)?.page ?? `/devices/${encodeURIComponent(id)}` };
}
function groupTarget(site: Site, group: DeviceGroup): Target {
  return { id: group.id, name: group.name, page: site.pages().page("group", group.id) ?? `/groups/${encodeURIComponent(group.id)}` };
}
function link(target: Target): string {
  return `<a href="${escapeHtml(target.page)}">${escapeHtml(target.name)} <span class="mono">${escapeHtml(target.id)}</span></a>`;
}
function render(ctx: PageContext, definition: Definition): string {
  const { t } = ctx.i18n;
  const labels = { turnOn: t("action.on"), turnOff: t("action.off"), toggle: t("action.toggle"), getState: t("action.refresh") };
  return `<section class="switch-definition" id="switch-definition" data-switch-definition aria-labelledby="switch-definition-title">
    <h2 id="switch-definition-title">${escapeHtml(t("definition.title"))}</h2>
    <p class="definition-source">${escapeHtml(definition.kind)} · ${link(definition.source)}${definition.detail ? `<br><span class="muted small">${escapeHtml(definition.detail)}</span>` : ""}</p>
    ${definition.groups?.length ? `<p class="definition-source">${escapeHtml(t("definition.groups"))}: ${definition.groups.map(link).join(" · ")}</p>` : ""}
    <dl class="kv">${definition.operations.map(operation => `<dt>${escapeHtml(labels[operation.action])}</dt><dd>
      <code>${escapeHtml(operation.request)}</code>
      ${operation.note ? `<p class="note">${escapeHtml(operation.note)}</p>` : ""}
      <ul class="definition-commands">${operation.commands.map(command => `<li>${link(command.target)}
        <code>${escapeHtml(command.call)}</code>${command.transport ? `<code class="small">${escapeHtml(command.transport)}</code>` : ""}
        ${command.payload ? `<details><summary>${escapeHtml(t("definition.payload"))}</summary><code>${escapeHtml(command.payload)}</code></details>` : ""}</li>`).join("")}</ul>
    </dd>`).join("")}</dl><p class="note">${escapeHtml(t("definition.after"))}</p>
  </section>`;
}

/** Read configuration only: displaying a definition must never execute a device command. */
export function renderDeviceSwitchDefinition(ctx: PageContext, site: Site, device: Device, signalCodes?: (id: string) => readonly SavedSignalCode[]): string {
  if (!device.capability("binarySwitch")) return "";
  const { t } = ctx.i18n;
  const source = deviceTarget(site, device.id);
  const operations: Operation[] = (["turnOn", "turnOff", "toggle", "getState"] as const).map(action => ({
    action, request: `${action === "getState" ? "GET" : "POST"} ${SWITCH_API[action === "getState" ? "state" : action].replace(":id", encodeURIComponent(device.id))}${action === "getState" ? "" : " {}"}`,
    commands: [{ target: source, call: `binarySwitch.${action}()` }],
  }));
  const [on, off, toggle, refresh] = operations as [Operation, Operation, Operation, Operation];
  let kind = t("definition.device");
  if (device.model.id === "shelly-plus-1") {
    const config = device.config as ShellyPlus1Config;
    const endpoint = `http://${config.host}/rpc/`;
    const channel = config.channel ?? 0;
    for (const [operation, method] of [[on, `Switch.Set?id=${channel}&on=true`], [off, `Switch.Set?id=${channel}&on=false`], [toggle, `Switch.Toggle?id=${channel}`], [refresh, `Switch.GetStatus?id=${channel}`]] as const) {
      operation.commands[0]!.transport = `GET ${endpoint}${method}`;
    }
  } else if (device.model.id === "lutron-caseta-switch") {
    const config = device.config as LutronCasetaConfig;
    for (const [operation, level] of [[on, 100], [off, 0]] as const) {
      operation.commands[0]!.transport = `LEAP ${config.host} · CreateRequest /zone/${config.zone}/commandprocessor\n${JSON.stringify({ Command: { CommandType: "GoToLevel", Parameter: [{ Type: "Level", Value: level }] } })}`;
    }
    refresh.commands[0]!.transport = `LEAP ${config.host} · ReadRequest /zone/${config.zone}/status`;
    toggle.note = t("definition.hardwareToggle");
    toggle.commands = [{ ...refresh.commands[0]! }, { target: source, call: "state === \"on\" ? binarySwitch.turnOff() : binarySwitch.turnOn()" }];
  } else if (device.model.id === "optimistic-switch") {
    kind = t("definition.buttonPair");
    const config = device.config as OptimisticSwitchConfig;
    const press = (id: string): Command[] => {
      const button = site.get(id);
      const commands: Command[] = [{ target: deviceTarget(site, id), call: "button.press()" }];
      if (button?.model.id === "action-button") {
        const action = button.config as ActionButtonConfig;
        if (action.savedCodeId) {
          const saved = signalCodes?.(action.device)?.find(code => code.id === action.savedCodeId);
          const capability = saved?.channel === "infrared" ? "infraredBlaster" : "radioFrequencyBlaster";
          const durationMs = saved?.durationMs ?? 0;
          commands.push({ target: deviceTarget(site, action.device), call: t("definition.savedCommand", { name: saved?.name ?? action.savedCodeId, id: action.savedCodeId }),
            ...(saved ? { payload: `${capability}.send(${JSON.stringify(durationMs > 0 ? { code: saved.code, durationMs } : saved.code)})` } : { transport: t("definition.savedUnavailable") }),
          });
        } else commands.push({ target: deviceTarget(site, action.device), call: `invokeControl(${JSON.stringify(action.control)}${action.value === undefined ? "" : `, ${JSON.stringify(action.value)}`})` });
      }
      return commands;
    };
    [on.commands, off.commands] = [press(config.onButton), press(config.offButton)];
    toggle.note = t("definition.optimisticToggle");
    refresh.note = t("definition.optimisticState") + (config.initialState ? ` ${t("definition.initial", { state: config.initialState })}` : "");
  } else if (device.model.id === "synthetic-switch") {
    kind = t("definition.scene");
    const config = device.config as SyntheticSwitchConfig;
    const memberCommands = (action: "on" | "off" | "getState"): Command[] => config.members.map(member => {
      const target = site.get(member.device);
      const capability = member.capability ?? Object.entries(target?.capabilities ?? {}).find(([, value]) => ["turnOn", "turnOff", "getState"].every(method => value.methods.includes(method)))?.[0];
      return { target: deviceTarget(site, member.device), call: `${capability}.${action === "getState" ? "getState" : member[action] === "on" ? "turnOn" : "turnOff"}()` };
    });
    on.commands = memberCommands("on");
    off.commands = memberCommands("off");
    refresh.commands = memberCommands("getState");
    refresh.note = t("definition.sceneState");
    toggle.note = t("definition.sceneToggle");
  }
  return render(ctx, { source, kind, detail: `${device.model.title}${device.displayHost?.() ? ` · ${device.displayHost()}` : ""}`, operations,
    groups: site.deviceGroups.filter(group => group.members.includes(device.id)).map(group => groupTarget(site, group)),
  });
}

export function renderGroupSwitchDefinition(ctx: PageContext, site: Site, group: DeviceGroup): string {
  const { t } = ctx.i18n;
  const endpoint = `/api/device-groups/${encodeURIComponent(group.id)}/switch`;
  const operations: Operation[] = (["turnOn", "turnOff", "toggle", "getState"] as const).map(action => {
    const path = { turnOn: "/turn-on", turnOff: "/turn-off", toggle: "/toggle", getState: "" }[action];
    const request = `${action === "getState" ? "GET" : "POST"} ${endpoint}${path}${action === "getState" ? "" : " {}"}`;
    const commands = group.members.flatMap(id => {
      const device = site.get(id);
      if (action === "getState") return Object.keys(device?.capabilities ?? {}).map(kind => ({ target: deviceTarget(site, id), call: `${kind}.describe()` }));
      const capability = device?.capability("binarySwitch") ? "binarySwitch" : device?.capability("stringLight") ? "stringLight" : "light";
      return [{ target: deviceTarget(site, id), call: action === "toggle" ? `${capability}.turnOff() / ${capability}.turnOn()` : `${capability}.${action}()` }];
    });
    return { action, request, commands, ...(action === "toggle" ? { note: t("definition.groupToggle") } : action === "getState" ? { note: t("definition.groupState") } : {}) };
  });
  return render(ctx, { source: groupTarget(site, group), kind: t("definition.group"), operations });
}
