/** Private stdio worker: isolates HAP sockets so a timed-out handshake can be killed cleanly. */
import HttpClient from "hap-controller/lib/transport/ip/http-client.js";

if (import.meta.main) {
  let client: HttpClient | undefined;
  let output: unknown;
  try {
    const input = await Bun.stdin.json();
    client = new HttpClient(input.homekitId, input.host, input.port, input.pairing, { usePersistentConnections: true });
    if (input.operation === "pair") {
      await client.pairSetup(input.pin);
      output = { pairing: client.getLongTermData() };
    } else if (input.operation === "read") {
      output = await client.getAccessories();
    } else throw new Error("Unsupported operation");
  } catch {
    // Never echo a library error or the request: either can contain credentials.
    process.exitCode = 1;
  } finally {
    await client?.close();
  }
  if (output !== undefined) {
    await new Promise<void>((resolve, reject) => process.stdout.write(JSON.stringify(output), (error) => error ? reject(error) : resolve()));
  }
  // The library ends sockets without destroying them. Once output is flushed,
  // exit this dedicated worker even when a peer never completes TCP shutdown.
  process.exit(process.exitCode ?? 0);
}
