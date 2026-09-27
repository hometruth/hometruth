#!/usr/bin/env bun
/**
 * `ht`: the HomeTruth client.
 *
 * It is one binary for every install. It holds no list of devices, no list of
 * capabilities and no list of controls: it connects to one HomeTruth, reads
 * the elements that install publishes, and offers exactly those. A model this
 * build has never heard of is as usable as one it ships with, because the
 * model, its config schema, its capabilities and the bounds of every control
 * all arrive over the same API the web UI uses.
 *
 * The commands come in two halves. Everything under "the install" works
 * against any HomeTruth you can reach. Everything under "this machine" reads
 * files or hardware here — secrets, a camera with no server in the way, the
 * router's admission window — and does not care which install is running.
 */
import { client, cliToken, UsageError, type Client } from "./client.ts";
import { elementFrom, invoke, resolve, type Element } from "./elements.ts";
import { discoverCommands, renderCommands, runElementCommand } from "./element-commands";
import { renderElement, renderGraphText, renderReadings, renderRecord, table, type GraphResponse } from "./format.ts";
import { DEFAULT_REBOOT_TIMEOUT_MS } from "./local.ts";
import { elementKey, isElementKey } from "../tags/identity";

const HELP = `ht — the HomeTruth client

The install (any HomeTruth you can reach)
  ht                                                 what this install is and what is in it
  ht root [command]                                 the site element; root help lists its commands
  ht ls [kind] [--side schema] [--json]              every element of a kind; devices by default.
                                                     device, group, service, model and schema answer in full;
                                                     every other kind this install publishes comes from the
                                                     graph — scene, preset, signal, capability, control,
                                                     property, event-type, widget, … and a kind it has none of
                                                     names the kinds it does have
  ht find <text> [--json]                            every element whose id, name or context matches
  ht <id> [--json]                                   one element: state and controls
  ht <id> <command> [value] [options]               e.g. exhaust-fan on, desk-light brightness 50
                                                     <capability>.<command> when two capabilities share a name
  ht <id> help                                      every command and option for this element
  ht watch <id>… [--for <seconds>] [--json]          subscribe to state and print every change
  ht graph <id> [--depth <n>] [--explain]            what an element is connected to, and one level beyond
  ht tags [list] [--json]                            every tag, including rooms, and how many elements carry it
  ht tags export                                     the whole ontology as YAML, to keep and to diff
  ht tags import [file]                              restore an export; additive, and never deletes
  ht enable <id>                                     switch a device back on: controls resume, polling resumes
  ht disable <id>                                    switch a device off without removing it: no controls, no polling
  ht reboot <id> [--timeout <seconds>]               reboot a device through the install
  ht reconnect <id>                                  reconnect managed Wi-Fi and renew DHCP
  ht rescan [id]                                     find every device (or one) by MAC on any subnet and update its address
  ht network on|off|kick                             DNS override for the cameras; kick makes them follow it
  ht isolation                                       every device with a LAN address: isolated or not, rule and capture state
  ht isolate <id> on|off                             cut one device off from the public internet, or release it
  ht tokens [list] [--json]                          every API token: what it may do, what it reaches, when it was last used
  ht tokens issue <name> --can <perms> --for <reach> [--expires <date>]
                                                     issue one and print it once; --can read,write,admin
                                                     --for all | device:<id> | group:<id> | room:<name>,schema:<id>,tag:<uuid>
  ht tokens revoke <id>                              stop a token working, keeping its record

This machine (files and hardware here, not the install)
  ht secrets list                                    every stored secret's path (never a value)
  ht secrets set <path>                              store one value, read from stdin or a prompt
  ht secrets unset <path>
  ht secrets import                                  move .env.local / camera-setup.json values in, once
  ht tokens bootstrap [name]                         mint a full-access token straight into the database and save it
                                                     for this client — the way back in when no token is to hand
  ht reboot <id|ip> --direct [--locate] [--timeout <seconds>]
                                                     find and reboot a camera without the server
  ht network accept-next <ssid> [--timeout <seconds>] [--dry-run]
                                                     allow the next new Wi-Fi client, then restore MAC restriction (default 180s)
  ht network accept-next <ssid> --recover            restore a window left by a stopped admission worker
  ht hub                                             run the local cloud emulator on its own
  ht tkenpro <args…>                                 the TKENPRO camera CLI (direct to camera or cloud)

Environment:
  HOMETRUTH_URL       the install to talk to (default http://127.0.0.1:3000)
  HOMETRUTH_TOKEN     the API token to present; otherwise api.cli.token from the secrets file
  HOMETRUTH_TOKENS_DB the token database (default .hometruth/tokens.sqlite), read directly by "tokens bootstrap"
  HOMETRUTH_DEVICES   devices.yml to read for --direct and secrets import (default devices.yml)
  HOMETRUTH_SECRETS   the secrets file (default .hometruth/secrets.yml)

Secret paths: devices.<id>.<key>…, vendors.<name>.<key>…, network.<adapter>.<key>…, api.<client>.<key>
  e.g. devices.example-camera.onvif.password, vendors.tkenpro.account.password, network.unifi.apiKey,
       api.cli.token
`;

export interface HtDependencies {
  readonly fetch?: typeof fetch;
  readonly env?: Record<string, string | undefined>;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  /** Runs the TKENPRO camera CLI; loaded lazily by default so nothing else pulls in camera code. */
  readonly tkenpro?: (argv: readonly string[]) => Promise<number>;
  readonly hub?: () => Promise<void>;
  readonly directReboot?: (target: string, options: { locateOnly: boolean; timeoutMs: number }) => Promise<string>;
  /** Reads a secret value without echoing it to the terminal or putting it in argv. */
  readonly readSecret?: (prompt: string) => Promise<string>;
  readonly secretStore?: import("../config/secrets").SecretStore;
  readonly importSecrets?: () => Promise<string[]>;
  readonly wifiAdmission?: (options: import("../network/wifi-admission-command").WifiAdmissionCommandOptions,
    env: Record<string, string | undefined>, report: (message: string) => void) => Promise<import("../network/wifi-admission").AdmissionResult>;
  /** Stops `watch`; the terminal's own interrupt by default. */
  readonly signal?: AbortSignal;
}

/**
 * Every first word that is a command; anything else names an element. The set
 * is deliberately short — the fewer words `ht` reserves, the more ids an
 * install is free to use.
 */
const COMMANDS = new Set(["help", "ls", "find", "graph", "watch", "tags", "enable", "disable",
  "reboot", "reconnect", "rescan", "network", "isolation", "isolate", "secrets", "tokens", "hub", "tkenpro"]);

/**
 * Element kinds with an endpoint of their own, which answers more fully than
 * the graph does: live status for the three instance kinds, the whole config
 * schema for a model, the whole document for a schema. `--side` means nothing
 * for these.
 */
const LISTED = new Set(["device", "group", "service", "model", "schema"]);

interface Parsed {
  readonly command: string | undefined;
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, string | true>;
}

function parse(argv: readonly string[]): Parsed {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  const valued = new Set(["timeout", "depth", "can", "for", "expires", "side"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const [name, ...assigned] = argument.slice(2).split("=");
    if (!name) throw new UsageError("An option needs a name");
    if (assigned.length) { flags.set(name, assigned.join("=")); continue; }
    const boolean = new Set(["json", "confirm", "direct", "locate", "explain", "recover", "dry-run", "help"]);
    if (valued.has(name) || !boolean.has(name) && argv[index + 1] !== undefined && !argv[index + 1]!.startsWith("--")) {
      const value = argv[index + 1];
      if (value === undefined) throw new UsageError(`--${name} needs a value`);
      flags.set(name, value);
      index += 1;
    } else {
      flags.set(name, true);
    }
  }
  const [command, ...rest] = positionals;
  return { command, positionals: rest, flags };
}

/** A control argument: JSON when it parses (numbers, booleans, objects), else the raw string. */
export function parseValue(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

interface TokenRow {
  kid: string;
  name: string;
  permissions: string[];
  reaches: string;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
  lastUsedAt?: string;
}

function timeoutMs(flags: Parsed["flags"]): number {
  const raw = flags.get("timeout");
  if (raw === undefined || raw === true) return DEFAULT_REBOOT_TIMEOUT_MS;
  const seconds = Number(raw);
  if (!Number.isInteger(seconds) || seconds < 10 || seconds > 600) throw new UsageError("--timeout takes 10..600 seconds");
  return seconds * 1000;
}

/**
 * `--for` selects `all`, `device:<id>`, `group:<id>`, or one
 * or more of `room:`/`schema:`/`tag:` combined, which is exactly an
 * `AutomaticGroupCriteria`.
 */
export function parseTokenSubject(raw: string): unknown {
  const parts = raw.split(",").map(part => part.trim()).filter(Boolean);
  if (parts.length === 0) throw new UsageError("--for takes all, device:<id>, group:<id>, or room:/schema:/tag: parts");
  if (parts.length === 1 && parts[0] === "all") return { all: true };
  if (parts.length === 1 && parts[0]!.startsWith("device:")) return { device: parts[0]!.slice("device:".length) };
  if (parts.length === 1 && parts[0]!.startsWith("group:")) return { group: parts[0]!.slice("group:".length) };
  const criteria: { room?: string; schemaId?: string; tagIds?: string[] } = {};
  for (const part of parts) {
    const separator = part.indexOf(":");
    const [kind, value] = [part.slice(0, separator), part.slice(separator + 1)];
    if (!value) throw new UsageError(`--for part "${part}" needs a value`);
    if (kind === "room") criteria.room = value;
    else if (kind === "schema") criteria.schemaId = value;
    else if (kind === "tag") criteria.tagIds = [...(criteria.tagIds ?? []), value];
    else throw new UsageError(`--for does not understand "${kind}:"; use all, device:, group:, room:, schema:, or tag:`);
  }
  return { criteria };
}

interface DeviceRow { id: string; name: string; room?: string; modelTitle?: string; model: string; availability: string; detail?: string; enabled: boolean }
interface GroupRow { id: string; name: string; room?: string; members: string[]; criteria?: unknown }
interface ServiceRow { id: string; title: string; availability: string; detail: string }
interface ModelRow { id: string; title: string; capabilities: string[]; connectionTypes: string[]; configSchema?: { properties?: object } }

/** What this install is and what is in it: the first thing to run against a HomeTruth you do not know. */
async function census(api: Client, json: boolean, stdout: (text: string) => void): Promise<void> {
  const [health, devices, groups, services, models] = await Promise.all([
    api.get("/api/health") as Promise<{ runtime?: { name?: string; version?: string } }>,
    api.get("/api/devices") as Promise<{ devices: DeviceRow[] }>,
    api.get("/api/device-groups") as Promise<{ groups: GroupRow[] }>,
    api.get("/api/services") as Promise<{ services: ServiceRow[] }>,
    api.get("/api/models") as Promise<{ models: ModelRow[] }>,
  ]);
  const body = {
    install: api.baseUrl,
    runtime: health.runtime,
    devices: devices.devices.length,
    groups: groups.groups.length,
    services: services.services.length,
    models: models.models.length,
  };
  if (json) {
    stdout(`${JSON.stringify(body, null, 2)}\n`);
    return;
  }
  const spread = (values: readonly string[]) => {
    const counts = new Map<string, number>();
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]).map(([status, count]) => `${count} ${status}`).join(" · ");
  };
  stdout(`HomeTruth at ${api.baseUrl}${health.runtime ? `  ${health.runtime.name} ${health.runtime.version}` : ""}\n\n`);
  stdout(table([
    ["devices", String(devices.devices.length), spread(devices.devices.map((device) => device.availability))],
    ["groups", String(groups.groups.length), ""],
    ["services", String(services.services.length), spread(services.services.map((service) => service.availability))],
    ["models", String(models.models.length), ""],
  ]));
  stdout(`\nht ls           every device\nht <id>         one element, its state and its controls\nht help         everything else\n`);
}

/**
 * Every element of one kind, and the only lister there is. The five kinds with
 * an endpoint of their own are asked for there, because it answers more fully
 * than the graph — live status for a device, group or service, the whole
 * config schema for a model, the whole document for a schema. Everything else
 * comes from the graph, which is where an install publishes the rest of what
 * it holds, so a kind this client has never heard of still lists.
 */
async function list(api: Client, kind: string, side: string, emit: (value: unknown, text: () => string) => void): Promise<void> {
  if (kind === "device") {
    const body = await api.get("/api/devices") as { devices: DeviceRow[] };
    emit(body, () => table([
      ["ID", "NAME", "WHAT", "WHERE", "STATUS"],
      ...body.devices.map((device) => [device.id, device.name, device.modelTitle ?? device.model, device.room ?? "",
        device.detail ? `${device.availability} · ${device.detail}` : device.availability]),
    ]));
    return;
  }
  if (kind === "group") {
    const body = await api.get("/api/device-groups") as { groups: GroupRow[] };
    emit(body, () => table([
      ["ID", "NAME", "WHAT", "WHERE", "MEMBERS"],
      ...body.groups.map((group) => [group.id, group.name, group.criteria ? "automatic" : "selected", group.room ?? "", String(group.members.length)]),
    ]));
    return;
  }
  if (kind === "service") {
    const body = await api.get("/api/services") as { services: ServiceRow[] };
    emit(body, () => table([
      ["ID", "NAME", "STATUS", "DETAIL"],
      ...body.services.map((service) => [service.id, service.title, service.availability, service.detail]),
    ]));
    return;
  }
  if (kind === "model") {
    const body = await api.get("/api/models") as { models: ModelRow[] };
    emit(body, () => table([
      ["ID", "TITLE", "CONNECTION", "CAPABILITIES", "CONFIG"],
      ...body.models.map((model) => [model.id, model.title, model.connectionTypes.join(" + "), model.capabilities.join(" + "),
        Object.keys(model.configSchema?.properties ?? {}).join(", ")]),
    ]));
    return;
  }
  if (kind === "schema") {
    const body = await api.get("/api/schemas") as { schemas: { key: string; title: string; typeName: string; category: string; schema: { $id?: string } }[] };
    emit(body, () => table([
      ["ID", "TITLE", "CATEGORY", "TYPE"],
      ...body.schemas.map((entry) => [entry.schema.$id ?? entry.key, entry.title, entry.category, entry.typeName]),
    ]));
    return;
  }
  if (LISTED.has(kind)) throw new Error(`No listing for kind "${kind}"`);
  const body = await api.get(`/api/graph?side=${encodeURIComponent(side)}&kind=${encodeURIComponent(kind)}`) as { nodes: { id: string; kind: string; name: string; context: string; ids: string[] }[] };
  if (!body.nodes.length) {
    const all = await api.get("/api/graph") as { nodes: { kind: string; side: string }[] };
    const kinds = [...new Set(all.nodes.filter((node) => node.side === side).map((node) => node.kind))].sort();
    throw new UsageError(`This install publishes no ${side} element of kind "${kind}". It has ${kinds.join(", ")}`);
  }
  emit(body, () => table([
    ["KEY", "NAME", "WHERE"],
    ...body.nodes.map((node) => [node.ids.join("/"), node.name, node.context]),
  ]));
}

export async function runHt(argv: readonly string[], dependencies: HtDependencies = {}): Promise<number> {
  if (argv[0] === "tkenpro") {
    // The camera CLI parses its own flags; hand the rest over untouched.
    const run = dependencies.tkenpro ?? (async (rest) => (await import("../vendors/tkenpro/cli")).runCli(rest));
    return await run(argv.slice(1));
  }
  const env = dependencies.env ?? process.env;
  const stdout = dependencies.stdout ?? ((text) => process.stdout.write(text));
  const stderr = dependencies.stderr ?? ((text) => process.stderr.write(text));
  const api = client(dependencies.fetch ?? fetch, env.HOMETRUTH_URL?.trim() || "http://127.0.0.1:3000", cliToken(env, dependencies.secretStore));

  let parsed: Parsed;
  try {
    parsed = parse(argv);
  } catch (error) {
    stderr(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const json = parsed.flags.has("json");
  const emit = (value: unknown, text: () => string) => stdout(json ? `${JSON.stringify(value, null, 2)}\n` : text());

  // A first word that is not a command names an element: `ht gate-relay`
  // describes it, `ht gate-relay toggle` invokes one of its controls.
  const element = parsed.command !== undefined && !COMMANDS.has(parsed.command) ? parsed.command : undefined;

  try {
    if (element !== undefined) return await elementCommand(api, element, parsed, emit, stdout);
    if (parsed.flags.has("help")) { stdout(HELP); return 0; }
    switch (parsed.command) {
      case undefined:
        await census(api, json, stdout);
        return 0;
      case "help":
        stdout(HELP);
        return 0;
      case "ls": {
        const [kind] = parsed.positionals;
        const side = parsed.flags.get("side");
        if (side !== undefined && side !== "schema" && side !== "instance") throw new UsageError("--side takes schema or instance");
        await list(api, kind ?? "device", typeof side === "string" ? side : "instance", emit);
        return 0;
      }
      case "find": {
        const [text] = parsed.positionals;
        if (!text) throw new UsageError("find needs something to look for");
        const needle = text.toLowerCase();
        const body = await api.get("/api/graph") as { nodes: { id: string; side: string; kind: string; name: string; context: string; ids: string[] }[] };
        const hits = body.nodes.filter((node) =>
          node.name.toLowerCase().includes(needle) || node.context.toLowerCase().includes(needle) || node.ids.some((id) => id.toLowerCase().includes(needle)));
        emit({ matches: hits }, () => hits.length
          ? table([["KEY", "KIND", "NAME", "WHERE"], ...hits.map((node) => [node.ids.join("/"), node.kind, node.name, node.context])])
          : `Nothing here matches "${text}".\n`);
        return 0;
      }
      case "graph": {
        const [id] = parsed.positionals;
        if (!id) throw new UsageError("graph needs an element id or key; try a device id");
        const depth = parsed.flags.get("depth");
        const key = isElementKey(id) ? id : elementKey("device", id);
        const body = await api.get(`/api/graph/${encodeURIComponent(key)}?depth=${encodeURIComponent(typeof depth === "string" ? depth : "2")}`) as GraphResponse;
        emit(body, () => renderGraphText(body, parsed.flags.has("explain")));
        return 0;
      }
      case "watch":
        return await watch(api, parsed, json, stdout, stderr, dependencies.signal);
      case "tags": {
        const [action] = parsed.positionals;
        if (action === "export") {
          stdout(await api.getText("/api/tags/export"));
          return 0;
        }
        if (action === "import") {
          const [file] = parsed.positionals.slice(1);
          const text = file ? await Bun.file(file).text() : await Bun.stdin.text();
          if (!text.trim()) throw new UsageError("tags import needs a file or YAML on stdin");
          const body = await api.postText("/api/tags/import", text, "text/yaml") as { names: number; tags: number; assignments: number; skipped: number };
          emit(body, () => `imported ${body.tags} tags, ${body.names} names, ${body.assignments} assignments${body.skipped ? `; skipped ${body.skipped}` : ""}\n`);
          return 0;
        }
        if (action && action !== "list") throw new UsageError("tags takes list, export, or import [file]");
        const body = await api.get("/api/tags") as { tags: { id: string; name: string; value: string; description: string }[]; counts: Record<string, number> };
        emit(body, () => table([
          ["TAG", "VALUE", "ELEMENTS", "DESCRIPTION"],
          ...body.tags.map(tag => [tag.name || "#", tag.value, String(body.counts[tag.id] ?? 0), tag.description]),
        ]));
        return 0;
      }
      case "enable":
      case "disable": {
        const [id] = parsed.positionals;
        if (!id) throw new UsageError(`${parsed.command} needs a device id`);
        const enabled = await api.request("POST", `/api/devices/${encodeURIComponent(id)}/${parsed.command}`) as boolean;
        emit(enabled, () => `${id} is now ${enabled ? "enabled" : "disabled"}\n`);
        return 0;
      }
      case "reboot": {
        const [target] = parsed.positionals;
        if (!target) throw new UsageError("reboot needs a device id (or an IP address with --direct)");
        const timeout = timeoutMs(parsed.flags);
        if (parsed.flags.has("direct") || parsed.flags.has("locate")) {
          const direct = dependencies.directReboot ?? (await import("./local.ts")).directReboot;
          stdout(`${await direct(target, { locateOnly: parsed.flags.has("locate"), timeoutMs: timeout })}\n`);
          return 0;
        }
        const body = await api.post(`/api/devices/${encodeURIComponent(target)}/reboot`, {}, timeout + 60_000) as { object: { status?: string } };
        emit(body, () => `Rebooted ${target}; status ${body.object.status ?? "unknown"}\n`);
        return 0;
      }
      case "reconnect": {
        const [id] = parsed.positionals;
        if (!id) throw new UsageError("reconnect needs a device id");
        const body = await api.post(`/api/devices/${encodeURIComponent(id)}/network/reconnect`, {}) as { message?: string };
        emit(body, () => `${body.message ?? `Reconnect requested for ${id}`}\n`);
        return 0;
      }
      case "rescan": {
        const [id] = parsed.positionals;
        type Result = { deviceId: string; outcome: string; address: string; currentAddress?: string; detail: string };
        const body = id
          ? await api.post(`/api/devices/${encodeURIComponent(id)}/network/rescan`, {}, 120_000) as { message: string; result: Result }
          : await api.post("/api/network/rescan", {}, 120_000) as { message: string; results: Result[] };
        emit(body, () => {
          const results = "results" in body ? body.results : [body.result];
          const changed = results.filter((result) => result.outcome !== "unchanged");
          const lines = changed.map((result) => `${result.outcome.padEnd(12)} ${result.deviceId.padEnd(34)} ${result.detail}`);
          return `${body.message}\n${lines.length > 0 ? `${lines.join("\n")}\n` : ""}`;
        });
        return 0;
      }
      case "network": {
        const [action, ssid, ...extra] = parsed.positionals;
        if (action === "accept-next") {
          if (!ssid?.trim() || extra.length) throw new UsageError("network accept-next needs exactly one Wi-Fi SSID");
          if ([...parsed.flags.keys()].some(flag => !["timeout", "dry-run", "recover", "json"].includes(flag))) throw new UsageError("accept-next supports --timeout, --dry-run, --recover, and --json");
          if (parsed.flags.has("recover") && (parsed.flags.has("dry-run") || parsed.flags.has("timeout"))) throw new UsageError("--recover cannot be combined with --dry-run or --timeout");
          const run = dependencies.wifiAdmission ?? (await import("../network/wifi-admission-command")).runWifiAdmissionCommand;
          const result = await run({ ssid, timeoutMs: parsed.flags.has("timeout") ? timeoutMs(parsed.flags) : 180_000,
            dryRun: parsed.flags.has("dry-run"), recover: parsed.flags.has("recover") }, env, message => stderr(`${message}\n`));
          emit(result, () => result.status === "dry-run"
            ? `${result.ssid}: ready; ${result.allowedCount} allowed MACs. Dry run only; no settings changed.\n`
            : `${result.ssid}: ${result.status}${result.client ? ` ${result.client.mac}${result.client.address ? ` at ${result.client.address}` : ""}` : ""}; MAC restriction is enabled (${result.allowedCount} allowed).\n`);
          return result.status === "timeout" || result.status === "cancelled" ? 1 : 0;
        }
        if (action !== "on" && action !== "off" && action !== "kick") throw new UsageError("network takes on, off, kick, or accept-next");
        const body = action === "kick"
          ? await api.post("/api/camera/network/reconnect", {}, 90_000)
          : await api.post("/api/camera/network/dns-override", { action }, 90_000);
        const message = (body as { message?: string }).message;
        emit(body, () => `${message ?? "done"}\n`);
        return 0;
      }
      case "isolation": {
        const body = await api.get("/api/isolation?refresh=1") as { devices: { deviceId: string; name: string; host: string; isolated: boolean; internetBlock: string; capture: string; hostnames: string[]; detail?: string }[]; dns: { domain: string; record: string; resolvedTo?: string }[]; overrideIp?: string; canIsolate: boolean; detail?: string };
        emit(body, () => {
          const lines = body.devices.map((device) => `${device.isolated ? "ISOLATED " : "open     "} ${device.deviceId.padEnd(18)} ${device.host.padEnd(15)} block ${device.internetBlock}, capture ${device.capture}${device.hostnames.length ? `, stands in for ${device.hostnames.join(", ")}` : ""}${device.detail ? ` — ${device.detail}` : ""}`);
          const dns = body.dns.map((record) => `  ${record.domain} → record ${record.record}${record.resolvedTo ? `, resolves to ${record.resolvedTo}` : ""}`);
          return `${lines.join("\n") || "No device has a LAN address."}\n${dns.length ? `DNS overrides to ${body.overrideIp ?? "?"}:\n${dns.join("\n")}\n` : ""}${body.canIsolate ? "" : `Cannot isolate: ${body.detail ?? "no capable network adapter"}\n`}`;
        });
        return 0;
      }
      case "isolate": {
        const [id, action] = parsed.positionals;
        if (!id || (action !== "on" && action !== "off")) throw new UsageError("isolate needs a device id and on or off");
        const body = await api.post(`/api/devices/${encodeURIComponent(id)}/isolation`, { isolated: action === "on" }, 120_000) as { message?: string };
        emit(body, () => `${body.message ?? "done"}\n`);
        return 0;
      }
      case "secrets": {
        const { FileSecretStore, secretPaths, withSecret } = await import("../config/secrets");
        const store = dependencies.secretStore ?? new FileSecretStore(env.HOMETRUTH_SECRETS?.trim() || undefined);
        const [action, path] = parsed.positionals;
        switch (action) {
          case "list": {
            const paths = secretPaths(await store.load());
            emit({ paths }, () => paths.length ? `${paths.join("\n")}\n` : "No secrets stored.\n");
            return 0;
          }
          case "set": {
            if (!path) throw new UsageError("secrets set needs a path, e.g. devices.example-camera.onvif.password");
            const read = dependencies.readSecret ?? (await import("./local.ts")).readSecret;
            const value = (await read(`Value for ${path}: `)).replace(/\r?\n$/u, "");
            if (!value) throw new UsageError("No value given");
            await store.save(withSecret(await store.load(), path, value));
            stdout(`Stored ${path}.\n`);
            return 0;
          }
          case "unset": {
            if (!path) throw new UsageError("secrets unset needs a path");
            await store.save(withSecret(await store.load(), path, undefined));
            stdout(`Removed ${path}.\n`);
            return 0;
          }
          case "import": {
            const run = dependencies.importSecrets ?? (async () => {
              const [{ loadDevicesConfig }, { importLegacySecrets }] = await Promise.all([import("../config/devices"), import("../vendors/tkenpro/secrets")]);
              return importLegacySecrets(store, await loadDevicesConfig(env.HOMETRUTH_DEVICES));
            });
            const written = await run();
            emit({ written }, () => written.length ? `Imported:\n${written.join("\n")}\n` : "Nothing new to import.\n");
            return 0;
          }
          default:
            throw new UsageError("secrets takes list, set <path>, unset <path>, or import");
        }
      }
      case "tokens": {
        const [action, ...rest] = parsed.positionals;
        switch (action ?? "list") {
          case "list": {
            const body = await api.get("/api/tokens") as { tokens: TokenRow[] };
            emit(body, () => body.tokens.length
              ? table([["ID", "NAME", "CAN", "REACHES", "LAST USED", "STATE"], ...body.tokens.map(token => [
                token.kid,
                token.name,
                token.permissions.join(","),
                token.reaches,
                token.lastUsedAt ?? "never",
                token.revokedAt ? "revoked" : token.expiresAt && Date.parse(token.expiresAt) <= Date.now() ? "expired" : "live",
              ])])
              : "No tokens issued.\n");
            return 0;
          }
          case "issue": {
            const name = rest.join(" ").trim();
            if (!name) throw new UsageError('tokens issue needs a name, e.g. ht tokens issue "Kindle dashboard" --can read --for all');
            const can = parsed.flags.get("can");
            const reach = parsed.flags.get("for");
            if (typeof can !== "string") throw new UsageError("tokens issue needs --can, e.g. --can write");
            if (typeof reach !== "string") throw new UsageError("tokens issue needs --for, e.g. --for all or --for room:Kitchen");
            const expires = parsed.flags.get("expires");
            const body: Record<string, unknown> = {
              name,
              permissions: can.split(",").map(part => part.trim()).filter(Boolean),
              subject: parseTokenSubject(reach),
            };
            if (typeof expires === "string") {
              const at = new Date(expires);
              if (Number.isNaN(at.getTime())) throw new UsageError("--expires takes a date, e.g. 2027-01-31");
              body.expiresAt = at.toISOString();
            }
            const { validateTokenCreate } = await import("../auth/model");
            if (!validateTokenCreate(body)) throw new UsageError("tokens issue needs read, write or admin access and one valid --for scope");
            const issued = await api.post("/api/tokens", body) as TokenRow & { token: string };
            // The only time this string exists outside the install.
            emit(issued, () => `${issued.token}\n\nCopy it now; it is not stored and cannot be shown again.\nIt can do ${issued.permissions.join(", ")} on ${issued.reaches}.\n`);
            return 0;
          }
          /**
           * The way back in when the first token scrolled past.
           *
           * This one command does not go through the server: it opens the
           * token database directly, which is why it still works when nobody
           * can authenticate. That is not a hole — the file is mode 0600 and
           * anyone who can read it can already read every secret this site
           * holds. Without it, one missed line of log output locks a person
           * out of their own house with no recovery but deleting the database.
           */
          case "bootstrap": {
            const { TokenStore, DEFAULT_TOKEN_STORE_PATH } = await import("../auth/store");
            const store = new TokenStore(env.HOMETRUTH_TOKENS_DB?.trim() || DEFAULT_TOKEN_STORE_PATH);
            try {
              const name = rest.join(" ").trim() || "Recovery token";
              const issued = store.issue({ name, permissions: ["admin"], subject: { all: true } });
              // Save it where this client looks, so the next command just works.
              const { FileSecretStore, withSecret } = await import("../config/secrets");
              const secrets = dependencies.secretStore ?? new FileSecretStore(env.HOMETRUTH_SECRETS?.trim() || undefined);
              let saved = true;
              try { await secrets.save(withSecret(await secrets.load(), "api.cli.token", issued.token)); }
              catch { saved = false; }
              emit({ ...issued.record, token: issued.token, saved }, () =>
                `${issued.token}\n\nIssued "${name}" with every permission on every device.\n`
                + `${saved ? "Saved to api.cli.token, so ht is ready to use.\n" : "Could not write the secrets file; set HOMETRUTH_TOKEN to use ht.\n"}`
                + `Sign in with it, issue narrower tokens for each client, then revoke this one.\n`);
              return 0;
            } finally { store.close(); }
          }
          case "revoke": {
            const [kid] = rest;
            if (!kid) throw new UsageError("tokens revoke needs a token id, as shown by ht tokens");
            const revoked = await api.post(`/api/tokens/${encodeURIComponent(kid)}/revoke`, {}) as TokenRow;
            emit(revoked, () => `Revoked ${revoked.name} (${revoked.kid}).\n`);
            return 0;
          }
          default:
            throw new UsageError("tokens takes list, issue <name> --can <…> --for <…>, revoke <id>, or bootstrap");
        }
      }
      case "hub": {
        const hub = dependencies.hub ?? (async () => { await (await import("../vendors/tkenpro/emulator")).runLocalCloudEmulator(); });
        await hub();
        return 0;
      }
      default:
        throw new UsageError(`Unknown command ${String(parsed.command)}; run "ht help"`);
    }
  } catch (error) {
    stderr(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}

/** Resolve the element's own command vocabulary before dispatching an action. */
async function elementCommand(
  api: Client,
  id: string,
  parsed: Parsed,
  emit: (value: unknown, text: () => string) => void,
  stdout: (text: string) => void,
): Promise<number> {
  const [command, rawValue, ...extra] = parsed.positionals;
  if (extra.length) throw new UsageError(`A command takes one value: ht ${id} <command> [value] [options]`);
  // Device configuration commands must work even when the device is disabled
  // or unreachable. Resolve their identity without asking for a live reading.
  const configurationCommand = command === "enabled" || command === "enable" || command === "disable";
  const element = await resolve(api, configurationCommand && !isElementKey(id) ? elementKey("device", id) : id);
  if (command === undefined && !parsed.flags.has("help")) {
    emit(element.body, () => renderElement(element));
    return 0;
  }
  const control = element.controls.find(control => control.name === command);
  if (control && !parsed.flags.has("help")) {
    for (const flag of parsed.flags.keys()) if (!["json", "confirm"].includes(flag)) throw new UsageError(`Unknown option --${flag}. Use ht ${id} help`);
    const confirmation = parsed.flags.get("confirm");
    if (confirmation !== undefined && confirmation !== true && confirmation !== "true" && confirmation !== "false") throw new UsageError("--confirm takes true or false");
    const body = await invoke(api, element, control.id, parseValue(rawValue), confirmation === true || confirmation === "true");
    emit(body, () => {
      if (element.kind === "service") {
        const done = body as { detail?: string };
        return `${command} on ${element.id}: ${done.detail ?? "done"}\n`;
      }
      const after = asElement(body, element.kind);
      return `${command} sent to ${after?.name ?? id}${after ? ` · ${after.status}` : ""}\n${after ? renderReadings(after) : ""}`;
    });
    return 0;
  }
  const commands = await discoverCommands(api, element);
  if (command === "help" || parsed.flags.has("help")) {
    emit(commands, () => renderCommands(id, command && command !== "help" ? commands.filter(entry => entry.name === command) : commands));
    return 0;
  }
  const found = commands.find(entry => entry.name === command);
  if (!found) throw new UsageError(`${element.name} has no command "${command}". Use ht ${id} help. Commands: ${commands.map(entry => entry.name).join(", ")}`);
  const result = await runElementCommand(api, found, rawValue, parsed.flags);
  if (result instanceof ReadableStream) {
    const decoder = new TextDecoder();
    try { for await (const chunk of result) stdout(decoder.decode(chunk, { stream: true })); }
    catch (error) { if (!(error instanceof Error) || !["TimeoutError", "AbortError"].includes(error.name)) throw error; }
    stdout(decoder.decode());
  } else emit(result, () => typeof result === "string" ? result + "\n" : JSON.stringify(result, null, 2) + "\n");
  return 0;
}

/** The element the install answered a control with, so the new state is printed rather than asked for again. */
function asElement(body: unknown, kind: Element["kind"]): Element | undefined {
  if (kind === "group") {
    const response = body as { group?: unknown };
    return response.group ? elementFrom(response.group, "group") : undefined;
  }
  return elementFrom(body, "device");
}

/**
 * The live view. Nothing polls: the install pushes a record whenever a node
 * changes, and this prints one line per change until the terminal interrupts
 * or `--for` runs out.
 */
async function watch(
  api: Client,
  parsed: Parsed,
  json: boolean,
  stdout: (text: string) => void,
  stderr: (text: string) => void,
  outer?: AbortSignal,
): Promise<number> {
  const ids = parsed.positionals;
  if (!ids.length) throw new UsageError("watch needs at least one element id");
  const nodes: string[] = [];
  for (const id of ids) {
    const found = await resolve(api, id);
    if (!found.node) throw new UsageError(`${found.name} is a ${found.kind}; only devices and groups publish state to subscribe to`);
    nodes.push(found.node);
  }
  const controller = new AbortController();
  outer?.addEventListener("abort", () => controller.abort(), { once: true });
  const onInterrupt = () => controller.abort();
  process.once("SIGINT", onInterrupt);
  const seconds = parsed.flags.get("for");
  if (seconds !== undefined && (typeof seconds !== "string" || !(Number(seconds) > 0))) {
    throw new UsageError("--for takes a number of seconds to watch for");
  }
  const timer = typeof seconds === "string"
    ? setTimeout(() => controller.abort(), Number(seconds) * 1000)
    : undefined;
  const query = nodes.map((node) => `node=${encodeURIComponent(node)}`).join("&");
  try {
    for await (const frame of api.stream(`/api/state/stream?${query}&tier=live`, controller.signal)) {
      if (json) {
        stdout(`${JSON.stringify(frame)}\n`);
        continue;
      }
      if (frame.event === "hello") {
        const hello = frame.data as { nodes?: string[]; generation?: string };
        const missing = nodes.filter((node) => !(hello.nodes ?? []).includes(node));
        if (missing.length) stderr(`Not watching ${missing.join(", ")}: this token does not reach them\n`);
        stdout(`watching ${(hello.nodes ?? []).join(", ")}\n`);
        continue;
      }
      if (frame.event === "error") {
        const problem = frame.data as { message?: string };
        stderr(`${problem.message ?? "the stream ended"}\n`);
        return 1;
      }
      if (frame.event === "state") stdout(renderRecord(frame.data));
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    if (timer) clearTimeout(timer);
    process.off("SIGINT", onInterrupt);
  }
  return 0;
}

if (import.meta.main) {
  process.exitCode = await runHt(Bun.argv.slice(2));
}
