import { readFileSync } from "node:fs";

/** The downloadable module and playground use the exact same library as package consumers. */
export const clientSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

/** Compile only. User code runs in the browser's opaque sandbox, never on the server. */
export function compilePlayground(source: string): string {
  const transpiler = new Bun.Transpiler({ loader: "ts", target: "browser" });
  for (const imported of transpiler.scanImports(source)) {
    if (imported.kind !== "import-statement" || !["./ht", "./ht.ts", "/ht.js"].includes(imported.path)) throw new Error('Use import ht from "./ht" in this playground');
  }
  const compiled = transpiler.transformSync(source);
  const code = compiled.replace(/^import\s+([\w$]+)\s+from\s+["'](?:\.\/ht(?:\.ts)?|\/ht\.js)["'];?\s*$/gm,
    (_match, name: string) => `const ${name} = __ht;`);
  if (transpiler.scanImports(code).length) throw new Error('Use the default import: import ht from "./ht"');
  const library = clientSource.replace(/^export default ht;?$/gm, "").replace(/^export /gm, "").replace("const ht = new HomeTruth();", "const __ht = new HomeTruth({ transport });");
  return transpiler.transformSync(`(async () => {
    const send = (message: unknown) => parent.postMessage(message, '*');
    const console = { log: (...values: unknown[]) => send({ type: 'output', text: values.map(value => typeof value === 'string' ? value : JSON.stringify(value, null, 2)).join(' ') }) };
    let sequence = 0;
    const transport = (path: string, init: RequestInit): Promise<unknown> => new Promise((resolve, reject) => {
      const id = ++sequence;
      const receive = (event: MessageEvent) => {
        if (event.source !== parent || event.data?.type !== 'result' || event.data.id !== id) return;
        removeEventListener('message', receive);
        event.data.error ? reject(new Error(event.data.error)) : resolve(event.data.result);
      };
      addEventListener('message', receive); send({ type: 'request', id, path, init });
    });
    ${library}
    try { await (async () => { ${code}\n })(); }
    catch (error) { console.log(String(error instanceof Error ? error.message : error)); }
    finally { send({ type: 'done' }); }
  })();`);
}
