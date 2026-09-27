import { argumentText, controlCommand, kebab, shellWord, type CommandArgument, type ElementCommand } from "../ht/commands";
import type { ApiOperation } from "./contract";
import type { Json, OpenApiDocument } from "../openapi/document";
import { record, resolveSchema, sample, typeScript } from "./schema";

/** Each operation has a named CLI command, with inputs described by its schema. */
export function cliCommands(operations: ApiOperation[], document: OpenApiDocument, id: string, primary: string, bindings: string[]): void {
  const used = new Set<string>(["help"]);
  const controls = new Map<string, ElementCommand>();
  // Controls own the short names, even if an auxiliary resource has the same name.
  const ordered = [...operations].sort((a, b) => Number(isControl(b)) - Number(isControl(a)));
  for (const operation of ordered) {
    const control = isControl(operation) ? decodeURIComponent(operation.path.split(/\/(?:controls|actions)\//)[1]!) : undefined;
    const sameControl = equivalentControl(operation);
    const existing = sameControl ? controls.get(sameControl) : undefined;
    if (existing) { operation.cli = existing; publish(operation, existing); continue; }
    let name = control ? controlCommand(control) : operationName(operation, primary, bindings, document);
    if (used.has(name)) name = `${operation.method === "GET" ? "show" : operation.method === "DELETE" ? "remove" : "set"}-${name}`;
    const root = name;
    for (let n = 2; used.has(name); n++) name = `${root}-${n}`;
    used.add(name);
    const schema = operation.request ? resolveSchema(operation.request, document) : undefined;
    const fields = record(schema?.properties);
    const body = !schema ? "none" : schema.type === "object" || Object.keys(fields).length ? "object" : "value";
    const args: CommandArgument[] = operation.parameters.map(param => {
      const values = record(param.schema).enum;
      return { name: String(param.name), flag: kebab(String(param.name)), in: param.in as "path" | "query", required: param.required === true,
        type: typeScript(record(param.schema), document), example: sample(record(param.schema), document),
        ...(param.required === true && Array.isArray(values) && values.length === 1 ? { fixed: values[0] } : {}) };
    });
    const required = Array.isArray(schema?.required) ? schema.required : [];
    const exampleFields = record(operation.example);
    const alternatives = schema?.oneOf ?? schema?.anyOf;
    const exampleRequired = new Set(Array.isArray(alternatives) ? record(alternatives[0]).required as string[] ?? [] : []);
    if (body === "object") for (const [key, value] of Object.entries(fields)) {
      args.push({ name: key, flag: key === "confirmed" ? "confirm" : kebab(key), in: "body", required: required.includes(key), type: typeScript(record(value), document), example: sample(record(value), document) });
    }
    if (body === "value") args.push({ name: "value", flag: "value", in: "body", required: true, type: typeScript(schema!, document), example: operation.example });
    // Keep flags unambiguous when a method uses the same field in two locations.
    for (const arg of args) if (args.some(other => other !== arg && other.flag === arg.flag)) arg.flag = `${arg.in}-${arg.flag}`;
    const values = args.filter(arg => arg.in === "body" && arg.name !== "confirmed");
    const positional = values.length === 1 ? values[0]!.name : undefined;
    const example = ["ht", shellWord(id), name];
    for (const arg of args) {
      if (arg.fixed !== undefined || !arg.required && !exampleRequired.has(arg.name) || arg.name === "confirmed") continue;
      if (!(arg.in === "body" && arg.name === positional)) example.push(`--${arg.flag}`);
      example.push(shellWord(argumentText(arg.in === "body" ? exampleFields[arg.name] ?? arg.example : arg.example)));
    }
    const summary = control ? `Run ${name}${values.length ? ` with ${values.map(arg => arg.name).join(", ")}` : ""}.` : operation.description;
    operation.cli = { name, summary, method: operation.method, path: operation.path, media: operation.media, body, ...(positional ? { positional } : {}), arguments: args, example: example.join(" ") };
    if (control) controls.set(controlCommand(control), operation.cli);
    // OpenAPI is also the discovery document consumed by ht; no parallel registry.
    publish(operation, operation.cli);
  }
  function publish(operation: ApiOperation, command: ElementCommand) {
    record(record(document.paths[operation.path])[operation.method.toLowerCase()])["x-hometruth-cli"] = command as unknown as Json;
  }
}

/** Convenience REST routes expose the same controls; the shell names each action once. */
function equivalentControl(operation: ApiOperation): string | undefined {
  if (operation.method !== "POST") return;
  const match = /^\/api\/(?:switches|lights|buttons)\/[^/]+\/([^/]+)$/.exec(operation.path)
    ?? /^\/api\/device-groups\/[^/]+\/switch\/([^/]+)$/.exec(operation.path);
  const action = match?.[1];
  return action === "turn-on" ? "on" : action === "turn-off" ? "off" : action;
}

function isControl(operation: ApiOperation): boolean {
  return /\/(?:controls|actions)\/[^/]+$/.test(operation.path) && !operation.path.includes("{");
}

function operationName(operation: ApiOperation, primary: string, bindings: string[], document: OpenApiDocument): string {
  const { path, method } = operation;
  if (method === "GET" && path === primary) return "status";
  if (method === "GET" && /^\/api\/switches\/[^/]+\/state$/.test(path)) return "state";
  let parts = path.slice(5).split("/").map(decodeURIComponent).filter(part => !bindings.includes(part));
  if (["devices", "device-groups", "elements", "services"].includes(parts[0]!)) parts.shift();
  parts = parts.map(part => part.replace(/^\{(.+)\}$/, "by-$1"));
  let noun = parts.map(kebab).join("-") || "describe";
  if (path.startsWith("/api/elements/")) noun = parts.length ? noun : "describe";
  if (path === "/api/state") noun = "snapshot";
  if (path === "/api/state/stream") noun = "watch";
  if (method === "GET") return noun;
  if (path.includes("/elements/") && noun === "tags" && method === "POST") return "tag";
  if (path.includes("/elements/") && method === "DELETE") return "untag";
  if (method === "POST" && noun === "name") return "rename";
  if (method === "POST" && noun === "settings") return "configure";
  if (method === "DELETE") return `delete-${noun}`;
  if (method === "PATCH") return `update-${noun}`;
  if (method === "PUT" || Object.hasOwn(record(document.paths[path]), "get")) return `set-${noun}`;
  return noun;
}
