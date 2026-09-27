import { subscribeMatter, type MatterSubscription } from "../../protocols/matter/client";
import { matterValue, type MatterSnapshot } from "../../protocols/matter/snapshot";
import type { AqaraSource, ConnectionState } from "./connection";

/** How long read()/probe() wait for the subscription's first report before answering "unknown" (not "degraded": no report yet is not evidence of a problem). */
const FIRST_REPORT_TIMEOUT_MS = 2_500;

/**
 * One continuous Matter subscription per peer, held open for this
 * connection's whole life from the moment it is constructed — the normal
 * Matter pattern: subscribe once, at startup, and every reader (a poll from
 * this class's own `read()`, a push into HomeTruth's state graph) answers
 * from that one subscription's maintained state, never a competing one-shot
 * read. Two Matter controllers cannot hold the same peer's paired storage
 * directory open at once (the SDK locks it exclusively), so exactly one
 * `AqaraMatterConnection` may ever exist per peer at a time — the site
 * construction that owns the live device graph is the only one that should
 * build one; see `AqaraHubM2`'s model `create()`.
 */
export class AqaraMatterConnection implements AqaraSource {
  private cached: ConnectionState = { availability: "unknown", detail: "Connecting to Matter…" };
  private readonly waiters = new Set<() => void>();
  private readonly listeners = new Set<(state: ConnectionState) => void>();
  private readonly subscription: MatterSubscription;

  constructor(readonly peerId: string, private readonly subscribeDevice = subscribeMatter, private readonly firstReportTimeoutMs = FIRST_REPORT_TIMEOUT_MS) {
    if (!/^peer[1-9][0-9]*$/.test(peerId)) throw new Error("Invalid Matter peer id");
    this.subscription = this.subscribeDevice(this.peerId, matter => this.report(matter), { onError: detail => this.fail(detail) });
  }

  private report(matter: MatterSnapshot): void {
    this.cached = this.identify(matter);
    this.settle();
  }

  /**
   * A worker crash or connection failure (a timed-out handshake, an
   * unreachable peer) is real evidence, unlike simply not having reported
   * yet: it degrades the cached state so `read()` stops waiting and a
   * stuck subscribe no longer looks identical to "still connecting"
   * forever. The worker restarts on its own (`subscribeMatter`'s backoff);
   * a later successful report clears this the normal way, through `report()`.
   */
  private fail(detail: string): void {
    this.cached = { availability: "degraded", detail };
    this.settle();
  }

  private settle(): void {
    for (const resolve of [...this.waiters]) resolve();
    this.waiters.clear();
    for (const listener of [...this.listeners]) listener(this.cached);
  }

  private identify(matter: MatterSnapshot): ConnectionState {
    if (matterValue(matter, 0, 0x28, 2) !== 4447 || matterValue(matter, 0, 0x28, 4) !== 2050) {
      return { availability: "degraded", detail: "Matter peer is not an Aqara Hub M2" };
    }
    return { availability: "online", matter };
  }

  /**
   * The most recent report, waiting briefly for the first one if the
   * subscription has not reported yet. Never having heard from the
   * subscription yet is not evidence it failed, so a still-connecting read
   * answers "unknown", not "degraded" — and once a report has ever arrived,
   * that report (good or bad) stays cached and answers every read from then
   * on; a later timeout while waiting for a *fresher* report never regresses
   * a once-online peer back to looking unreachable.
   */
  async read(): Promise<ConnectionState> {
    if (this.cached.availability !== "unknown") return this.cached;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.waiters.delete(onReport); resolve(); }, this.firstReportTimeoutMs);
      const onReport = () => { clearTimeout(timer); resolve(); };
      this.waiters.add(onReport);
    });
    return this.cached;
  }

  /** A live push of every report the subscription delivers, for a caller that wants to react rather than poll. */
  subscribe(onChange: (state: ConnectionState) => void): () => void {
    this.listeners.add(onChange);
    return () => { this.listeners.delete(onChange); };
  }

  /** Ends this connection's one subscription; nothing else can read through it afterward. */
  stop(): void {
    this.subscription.stop();
  }
}
