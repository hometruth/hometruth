import { resolve } from "node:path";

let bundled: Promise<string> | undefined;

/** Code only, shared by every installation; never inline server environment values. */
export function cliDownload(): Promise<string> {
  return bundled ??= Bun.build({
    entrypoints: [resolve(import.meta.dir, "index.ts")],
    root: resolve(import.meta.dir, "../.."),
    target: "bun",
    env: "disable",
    sourcemap: "none",
  }).then(async result => {
    if (!result.success || result.outputs.length !== 1) throw new Error("CLI build failed");
    return result.outputs[0]!.text();
  }).catch(error => {
    bundled = undefined;
    throw error;
  });
}
