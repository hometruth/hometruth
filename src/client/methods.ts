import type { ElementApi } from "../element-api/contract";
import { record, resolveSchema, typeScript } from "../element-api/schema";
import type { ElementCommand } from "../ht/commands";
import type { MethodDefinition } from "./index";

export function methodName(command: string): string {
  if (command === "status") return "read";
  if (command === "describe") return "metadata";
  return command.replace(/-([a-z0-9])/g, (_match, next: string) => next.toUpperCase());
}

export function clientMethods(api: ElementApi): MethodDefinition[] {
  return api.commands.map(command => {
    const operation = api.operations.find(operation => operation.path === command.path && operation.method === command.method)!;
    return { name: methodName(command.name), description: command.summary, arguments: command.arguments.map(({ flag: _flag, example: _example, ...arg }) => arg),
      returns: typeScript(operation.response, api.document, new Set(), true), ...(command.positional ? { positional: command.positional } : {}),
      transport: { method: command.method, path: command.path, media: command.media, body: command.body },
    };
  });
}

export function clientExamples(api: ElementApi): { name: string; description: string; code: string; signature: string }[] {
  const target = api.kind === "site" ? "ht.elements.root"
    : api.kind === "device" ? `ht.devices[${JSON.stringify(api.id)}]` : `ht.elements[${JSON.stringify(api.uuid ?? api.key)}]`;
  const prefix = `import ht from "./ht";\nawait ht.connect(${JSON.stringify(api.document.servers[0]?.url)});\n\n`;
  return [{ name: "describe", description: "Inspect this element's identity, public properties and available methods.", signature: "describe(): Promise<ElementDescription>", code: `${prefix}console.log(await ${target}.describe());` },
    ...api.commands.map(command => {
      const operation = api.operations.find(operation => operation.path === command.path && operation.method === command.method)!;
      const schema = resolveSchema(operation.request ?? {}, api.document);
      const alternatives = schema.oneOf ?? schema.anyOf;
      const exampleRequired = new Set(Array.isArray(alternatives) ? record(alternatives[0]).required as string[] ?? [] : []);
      const bodyExample = record(operation.example);
      const method = methodName(command.name);
      const args: unknown[] = [];
      if (command.positional) args.push(command.arguments.find(arg => arg.in === "body" && arg.name === command.positional)?.example);
      const options = Object.fromEntries(command.arguments.filter(arg => arg.fixed === undefined && (arg.required || arg.in === "body" && exampleRequired.has(arg.name)) && !(arg.in === "body" && arg.name === command.positional)).map(arg => [arg.name, arg.in === "body" ? bodyExample[arg.name] ?? arg.example : arg.example]));
      if (Object.keys(options).length) args.push(options);
      // Optional values are omitted until a caller supplies one intentionally.
      if (command.positional && !command.arguments.find(arg => arg.in === "body" && arg.name === command.positional)?.required && !Object.keys(options).length) args.length = 0;
      const access = method.split(".").map(name => /^[a-zA-Z_$][\w$]*$/.test(name) ? `.${name}` : `[${JSON.stringify(name)}]`).join("");
      return { name: method, description: command.summary, signature: signature(command), code: `${prefix}console.log(await ${target}${access}(${args.map(arg => JSON.stringify(arg, null, 2)).join(", ")}));` };
    }),
  ];
}

function signature(command: ElementCommand): string {
  const positional = command.arguments.find(arg => arg.in === "body" && arg.name === command.positional);
  const options = command.arguments.filter(arg => arg.fixed === undefined && arg !== positional);
  const args = [positional ? `${positional.name}${positional.required ? "" : "?"}: ${positional.type}` : "",
    options.length ? `options${options.some(arg => arg.required) ? "" : "?"}: { ${options.map(arg => `${arg.name}${arg.required ? "" : "?"}: ${arg.type}`).join("; ")} }` : ""].filter(Boolean);
  return `${methodName(command.name)}(${args.join(", ")})`;
}
