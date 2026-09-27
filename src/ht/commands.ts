/** The shell vocabulary, shared by command discovery and the generated guides. */
export const kebab = (name: string): string => name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

export function controlCommand(control: string): string {
  const parts = control.replace(/^power\./, "").split(".");
  return parts.map(part => part === "turnOn" ? "on" : part === "turnOff" ? "off" : part === "getState" ? "state"
    : kebab(part.replace(/^set(?=[A-Z])/, ""))).join(".");
}

/** Quote only when the shell needs it; ordinary ids and commands remain readable. */
export const shellWord = (value: string): string => /^[a-zA-Z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
export const argumentText = (value: unknown): string => typeof value === "string" && !/^(?:true|false|null|-?\d)/.test(value) ? value : JSON.stringify(value);

export interface CommandArgument {
  name: string;
  flag: string;
  in: "path" | "query" | "body";
  required: boolean;
  type: string;
  example: unknown;
  fixed?: unknown;
}

/** Transport details stay inside discovery; a person supplies names, values and flags. */
export interface ElementCommand {
  name: string;
  summary: string;
  method: string;
  path: string;
  media: string;
  body: "none" | "object" | "value";
  positional?: string;
  arguments: CommandArgument[];
  example: string;
}

export function commandUsage(command: ElementCommand): string {
  return [command.name, ...command.arguments.filter(arg => arg.fixed === undefined).map(arg => {
    const text = arg.name === command.positional && arg.in === "body" ? `<${arg.name}>` : arg.flag === "confirm" ? "--confirm" : `--${arg.flag} <${arg.type}>`;
    return arg.required ? text : `[${text}]`;
  })].join(" ");
}
