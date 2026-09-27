import { execFile } from "node:child_process";
import { isIP, isIPv4 } from "node:net";
import { promisify } from "node:util";

const execute = promisify(execFile);
export function parseDnsAnswer(output: string): string[] {
  const answers = output.trim().split(/\r?\n/).filter(Boolean);
  if (answers.some(answer => !isIPv4(answer))) throw new Error("Gateway returned an unexpected DNS answer");
  return answers;
}

/** Query the named gateway on the wire, independent of the process DNS cache. */
export async function lookupGatewayDns(gateway: string, domain: string): Promise<string[]> {
  if (!isIP(gateway) || !/^[a-z0-9.-]+$/.test(domain)) throw new Error("Supply a numeric gateway address and DNS hostname");
  const { stdout } = await execute("dig", [`@${gateway}`, domain, "A", "+short", "+time=2", "+tries=1"], { timeout: 4000, maxBuffer: 65536 });
  return parseDnsAnswer(stdout);
}

/** UniFi can acknowledge a policy before its resolver has applied it. */
export async function verifyDnsEventually(
  lookup: () => Promise<string[]>,
  expected: string,
  pause: (milliseconds: number) => Promise<void> = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
): Promise<void> {
  let detail = "no answer";
  const deadline = Date.now() + 60_000;
  for (const delay of [0, 500, 1000, 2000, 4000, 8000, 8000, 8000, 8000, 8000]) {
    if (Date.now() + delay >= deadline) break;
    if (delay) await pause(delay);
    try {
      const answers = await lookup();
      if (answers.length === 1 && answers[0] === expected) return;
      detail = answers.join(", ") || "empty answer";
    } catch (error) { detail = error instanceof Error ? error.message : String(error); }
  }
  throw new Error(`Gateway DNS has not resolved exclusively to the emulator after the propagation window: ${detail}`);
}
