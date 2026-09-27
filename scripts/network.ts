#!/usr/bin/env bun
import { runNetworkTools } from "../src/network/tools";

const abort = new AbortController();
const cancel = () => abort.abort();
process.on("SIGINT", cancel);
process.on("SIGTERM", cancel);
try {
  const result = await runNetworkTools(process.argv.slice(2), { signal: abort.signal });
  if (result && typeof result === "object" && "status" in result && (result.status === "timeout" || result.status === "cancelled")) process.exitCode = 1;
  process.stdout.write(typeof result === "string" ? result : JSON.stringify(result, null, 2) + "\n");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  process.off("SIGINT", cancel);
  process.off("SIGTERM", cancel);
}
