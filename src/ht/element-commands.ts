import { UsageError, type Client } from "./client";
import { commandUsage, shellWord, type ElementCommand } from "./commands";
import type { Element } from "./elements";
import { elementKey } from "../tags/identity";

/** The install publishes the command names and argument schemas for this element. */
export async function discoverCommands(api: Client, element: Element): Promise<ElementCommand[]> {
  const page = element.page ?? `/elements/${elementKey(element.kind, element.id)}`;
  if (!page.startsWith("/") || page.startsWith("//")) throw new UsageError("The element has no local command guide");
  const document = await api.get(`${page === "/" ? "" : page}/openapi.json`) as { paths: Record<string, Record<string, { "x-hometruth-cli"?: ElementCommand }>> };
  const commands = Object.values(document.paths).flatMap(item => Object.values(item).flatMap(operation => operation["x-hometruth-cli"] ? [operation["x-hometruth-cli"]] : []));
  return [...new Map(commands.map(command => [command.name, command])).values()];
}

export function renderCommands(id: string, commands: ElementCommand[]): string {
  return `Commands for ${id}\n\n${commands.map(command => `  ht ${shellWord(id)} ${commandUsage(command)}`).join("\n")}\n\nUse --json for machine-readable output. Values may be JSON; quote objects and arrays.\n`;
}

export async function runElementCommand(api: Client, command: ElementCommand, rawValue: string | undefined, flags: ReadonlyMap<string, string | true>): Promise<unknown> {
  const allowed = new Set(["json", ...command.arguments.filter(arg => arg.fixed === undefined).map(arg => arg.flag)]);
  for (const flag of flags.keys()) if (!allowed.has(flag)) throw new UsageError(`Unknown option --${flag}. Use ${commandUsage(command)}`);
  if (rawValue !== undefined && !command.positional) throw new UsageError(`${command.name} takes named options. Use ${commandUsage(command)}`);
  let path = command.path;
  const query = new URLSearchParams();
  const body: Record<string, unknown> = {};
  let valueBody: unknown;
  for (const argument of command.arguments) {
    const positional = argument.in === "body" && argument.name === command.positional ? rawValue : undefined;
    if (positional !== undefined && flags.has(argument.flag)) throw new UsageError(`Supply ${argument.name} once, as a value or --${argument.flag}`);
    const raw = positional ?? flags.get(argument.flag);
    if (raw === true && argument.type !== "boolean") throw new UsageError(`--${argument.flag} needs a value`);
    const parsed = raw === undefined ? undefined : parseArgument(raw);
    const value = argument.fixed ?? (raw === undefined ? undefined : argument.type === "string" && typeof parsed !== "string" ? String(raw) : parsed);
    if (value === undefined) {
      if (argument.required) throw new UsageError(`Missing ${argument.name}. Use ${commandUsage(command)}`);
      continue;
    }
    if (argument.in === "query") query.set(argument.name, String(value));
    else if (argument.in === "path") path = path.replaceAll(`{${argument.name}}`, encodeURIComponent(String(value)));
    else if (command.body === "value") valueBody = value;
    else body[argument.name] = value;
  }
  if (/\{[^}]+\}/.test(path)) throw new UsageError(`Missing a command argument. Use ${commandUsage(command)}`);
  if (query.size) path += `?${query}`;
  const value = command.body === "object" ? body : valueBody;
  return api.request(command.method, path, command.body === "none" ? undefined : command.media === "application/json" ? JSON.stringify(value) : String(value), command.media);
}

function parseArgument(raw: string | true): unknown {
  if (raw === true) return true;
  try { return JSON.parse(raw); } catch { return raw; }
}
