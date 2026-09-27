// Isolated Node runtime: Matter controller storage and network handles stay out of Bun hot reloads.
import { ControllerBehavior, Environment, Seconds, ServerNode } from "@matter/main";
import { Read, Subscribe } from "@matter/main/protocol";
import type { ReadResult } from "@matter/main/protocol";
import { AttributeId, ClusterId } from "@matter/main/types";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { mergeAttributes, type MatterAttribute } from "./snapshot.ts";

process.umask(0o077);
Environment.default.vars.set("log.level", "fatal");
let input = "";
for await (const chunk of process.stdin) input += chunk;
const { storagePath, peerId, subscribe } = JSON.parse(input) as { storagePath: string; peerId: string; subscribe?: boolean };
await mkdir(storagePath, { recursive: true, mode: 0o700 });
Environment.default.vars.set("storage.path", storagePath);
// A one-shot read holds this lock only briefly; a subscription holds it for the process's whole life.
const lockPath = join(storagePath, subscribe ? "subscribe.pid" : "read.pid");
const PATHS = [[0x28, 2], [0x28, 4], [0x28, 15], [0x39, 3], [0x39, 5], [0x39, 12], [0x39, 15], [0x39, 17], [0x45, 0], [0x2f, 12]] as const;
const attributePaths = PATHS.map(([cluster, attribute]) => ({ clusterId: ClusterId(cluster), attributeId: AttributeId(attribute) }));

function reportsToAttributes(reports: readonly ReadResult.Report[]): MatterAttribute[] {
  const attributes: MatterAttribute[] = [];
  for (const report of reports) {
    if (report.kind !== "attr-value" && report.kind !== "attr-status") continue;
    attributes.push({ endpoint: Number(report.path.endpointId), cluster: Number(report.path.clusterId), attribute: Number(report.path.attributeId),
      ...(report.kind === "attr-value" ? { value: report.value } : {}) });
  }
  return attributes;
}

/** Drain a read or a report into one array; a chunk iterates the same either way, sync or async. */
async function collect(result: ReadResult): Promise<ReadResult.Report[]> {
  const reports: ReadResult.Report[] = [];
  for await (const chunk of result) for await (const report of chunk) reports.push(report);
  return reports;
}

async function writeLine(value: unknown): Promise<void> {
  await new Promise<void>(resolve => process.stdout.write(JSON.stringify(value) + "\n", () => resolve()));
}

/**
 * Every network step below (create the controller, start it, establish the
 * subscription) is unbounded on its own; nothing here may hang this process
 * past this one deadline. Measured directly against the real hub (a
 * standalone diagnostic script, uncontended): controller create, node
 * start, and subscribe establishment each complete in well under a second
 * when nothing else holds the storage lock — 15 s is generous headroom for
 * that, not a bound the real handshake was ever close to needing.
 */
const CONNECT_TIMEOUT_MS = 15_000;
/** The longest report interval we will accept; the peer answers with the one it actually agrees to. */
const MAX_INTERVAL_CEILING_SECONDS = 60;
/**
 * How many report intervals of total silence — no report, no keepalive — mean the subscription is
 * gone in a way neither side noticed. That state used to be indistinguishable from a quiet house:
 * the worker sat in its wait loop looking healthy while every reading in the house stayed frozen at
 * whatever it was when the process started. Measured against the interval the peer negotiated
 * rather than the ceiling we asked for, because agreeing to the ceiling is its choice, not ours;
 * two and a half of them is late enough that a merely slow peer is not mistaken for a dead one.
 */
const SILENCE_INTERVALS = 2.5;
function withTimeout<T>(work: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), CONNECT_TIMEOUT_MS); });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

let locked = false;
let controller: ServerNode<ServerNode.RootEndpoint> | undefined;
let exitCode = 1;
try {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const lock = await open(lockPath, "wx", 0o600);
      await lock.writeFile(String(process.pid));
      await lock.close();
      locked = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(await readFile(lockPath, "utf8"));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error("Invalid controller lock");
      try { process.kill(pid, 0); throw new Error("Controller busy"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      await unlink(lockPath);
    }
  }
  if (!locked) throw new Error("Controller busy");
  const node = await withTimeout(ServerNode.create(ServerNode.RootEndpoint.with(ControllerBehavior), {
    id: "hometruth-aqara-controller", network: { port: 0 }, commissioning: { enabled: false },
    controller: { adminFabricLabel: "HomeTruth" },
  }), "Matter controller did not start in time");
  controller = node;
  // A one-shot read needs no subscription; a persistent subscription is exactly what `subscribe` mode asks for.
  for (const peer of node.peers) await peer.set({ network: { autoSubscribe: false } });
  await withTimeout(node.start(), "Matter controller did not start in time");
  const peer = node.peers.get(peerId);
  if (!peer?.lifecycle.isCommissioned) throw new Error("Matter pairing required");

  if (!subscribe) {
    const request = { ...Read({ attributes: attributePaths }), includeKnownVersions: true };
    await writeLine({ observedAt: new Date().toISOString(), attributes: reportsToAttributes(await collect(peer.interaction.read(request))) });
    exitCode = 0;
  } else {
    // Stays open until the parent signals teardown, the subscription itself closes, or the peer
    // goes silent for longer than a subscription's heartbeat allows.
    let closed = false;
    /** The last time the peer proved it was there, with a report or a content-free keepalive. */
    let lastSignal = Date.now();
    /**
     * The whole picture of the hub, maintained here because this is the only place that knows a
     * DataReport is a delta. A report names only the paths that changed; every reader downstream
     * (`identify()`, `matterAccessories()`, `AqaraContact.getState()`) takes a `MatterSnapshot` to
     * be the complete state of the hub. Writing a bare delta out as a snapshot would strip the
     * peer of its own identity — endpoint 0's Basic Information is not in a door's report — and
     * every bridged sensor of its reading, all at once.
     */
    let attributes: MatterAttribute[] = [];
    /** Nothing is written before the initial read: a partial picture is worse than a late one. */
    let seeded = false;
    const emit = () => writeLine({ observedAt: new Date().toISOString(), attributes });

    const request = Subscribe({
      attributes: attributePaths,
      keepSubscriptions: true,
      minIntervalFloor: Seconds(1),
      maxIntervalCeiling: Seconds(MAX_INTERVAL_CEILING_SECONDS),
    });
    /**
     * These go on the request, not into `Subscribe()`'s options, and they are spelled `updated`
     * and `closed`. `Subscribe()` builds a fresh request through `Read()` and copies exactly
     * `keepSubscriptions`, `minIntervalFloor` and `maxIntervalCeiling` onto it, so an `update:`
     * handed to it as an option is silently dropped — even though `Subscribe.Options` declares
     * one, which is why this typechecks either way. With `updated` unset, `ClientInteraction`
     * drains every DataReport into `for await (const _chunk of result);` and discards it. That is
     * not a hypothetical: it is why this hub reported once at startup and never again, while the
     * worker, the subscription and the service all went on looking healthy.
     */
    request.updated = async data => {
      lastSignal = Date.now();
      const reports = await collect(data);
      if (!reports.length) return;
      attributes = mergeAttributes(attributes, reportsToAttributes(reports));
      if (seeded) await emit();
    };
    // A DataReport carrying no data: not news, so nothing is written, but it is proof the peer is
    // still there and it is what keeps the silence watchdog below from firing on a quiet house.
    request.keepaliveReceived = () => { lastSignal = Date.now(); };
    request.closed = () => { closed = true; };

    // Establishing the subscription is a network round trip with no built-in timeout of its own.
    const subscription = await withTimeout(peer.interaction.subscribe(request), "Matter subscription did not establish in time");
    // Subscribe first, read second: a change during the read arrives as a report rather than being
    // missed in the gap, and the read that follows is the newer answer, so it wins the merge.
    const initialRequest = { ...Read({ attributes: attributePaths }), includeKnownVersions: true };
    attributes = mergeAttributes(attributes, reportsToAttributes(await collect(peer.interaction.read(initialRequest))));
    if (!attributes.length) throw new Error("Matter peer returned no attributes");
    seeded = true;
    lastSignal = Date.now();
    await emit();
    // A signal, not stdin: stdin reached EOF while the request above was being read, so its `end`
    // fired long before anything could listen for it and `subscribeMatter`'s teardown has only
    // ever been the kill that follows. Handling it here is what gives the peer a closed
    // subscription and the next worker an unlocked storage directory, which matters now that the
    // silence watchdog below can restart this process on its own. The failsafe is for a close that
    // hangs: holding the lock while refusing to die would keep the replacement out.
    const teardown = () => {
      closed = true;
      subscription.close();
      setTimeout(() => process.exit(0), 2_000);
    };
    process.on("SIGTERM", teardown);
    process.on("SIGINT", teardown);
    // The interval the peer settled on, which is what it owes a report against — with data, or
    // empty as a keepalive. It may be shorter than the ceiling we asked for, and it may be longer.
    const reportInterval = Number(subscription.maxInterval);
    const silenceLimitMs = (reportInterval > 0 ? reportInterval : MAX_INTERVAL_CEILING_SECONDS) * SILENCE_INTERVALS * 1000;
    while (!closed && Date.now() - lastSignal < silenceLimitMs) await new Promise(resolve => setTimeout(resolve, 500));
    // Ending the process is the repair: `subscribeMatter` respawns the worker with backoff, which
    // establishes a fresh subscription. Reporting it first is what stops a lost connection from
    // showing the house a set of readings that quietly stopped being true.
    if (!closed) throw new Error(`Matter peer sent nothing for ${Math.round(silenceLimitMs / 1000)} s; the subscription is no longer live`);
    exitCode = 0;
  }
} catch (error) {
  await writeLine({ error: error instanceof Error ? error.message : "Matter connection unavailable" });
}
finally {
  // Matter shutdown may wait for remote session teardown. The work is complete;
  // bound cleanup so an unavailable hub cannot hold the process indefinitely.
  if (controller) await Promise.race([controller.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 1000))]);
  if (locked) await unlink(lockPath).catch(() => {});
}
process.exit(exitCode);
