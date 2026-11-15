import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { BinarySwitchState } from "../../../models/binary-switch";

export type OptimisticSwitchState = {
  readonly value: BinarySwitchState;
  readonly source: "commanded" | "assumed";
  readonly at: string;
};

export interface OptimisticSwitchMemory {
  get(): OptimisticSwitchState | undefined;
  set(state: OptimisticSwitchState): void;
}

export interface OptimisticSwitchStateStore {
  /** A remembered command applies only to its exact on/off button mapping. */
  forSwitch(id: string, onButton: string, offButton: string): OptimisticSwitchMemory;
}

export class MemoryOptimisticSwitchStateStore implements OptimisticSwitchStateStore {
  private readonly states = new Map<string, { mapping: string; state?: OptimisticSwitchState }>();

  forSwitch(id: string, onButton: string, offButton: string): OptimisticSwitchMemory {
    const mapping = JSON.stringify([onButton, offButton]);
    return {
      get: () => this.states.get(id)?.mapping === mapping ? this.states.get(id)?.state : undefined,
      set: state => { this.states.set(id, { mapping, state }); },
    };
  }
}

/** Installation-owned command memory; no hardware observation is inferred from it. */
export class SqliteOptimisticSwitchStateStore implements OptimisticSwitchStateStore {
  private readonly db: Database;
  private readonly memory = new MemoryOptimisticSwitchStateStore();
  private readonly loaded = new Set<string>();

  constructor(path = ".hometruth/optimistic-switches.sqlite") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { strict: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS switch_state (
        id TEXT PRIMARY KEY,
        on_button TEXT NOT NULL,
        off_button TEXT NOT NULL,
        value TEXT CHECK (value IN ('on', 'off')),
        source TEXT CHECK (source IN ('commanded', 'assumed')),
        at TEXT
      );`);
  }

  forSwitch(id: string, onButton: string, offButton: string): OptimisticSwitchMemory {
    if (!this.loaded.has(id)) {
      const row = this.db.query("SELECT on_button, off_button, value, source, at FROM switch_state WHERE id = ?").get(id) as (OptimisticSwitchState & { on_button: string; off_button: string }) | null;
      if (row && (row.value === "on" || row.value === "off") && (row.source === "commanded" || row.source === "assumed") && Number.isFinite(Date.parse(row.at))) {
        this.memory.forSwitch(id, row.on_button, row.off_button).set({ value: row.value, source: row.source, at: row.at });
      }
      this.loaded.add(id);
    }
    // Binding a candidate configuration must not change the still-active site's state.
    const memory = this.memory.forSwitch(id, onButton, offButton);
    return {
      get: () => memory.get(),
      set: state => {
        // A successful physical command stays current even if durability fails.
        memory.set(state);
        try {
          this.db.query(`INSERT INTO switch_state (id, on_button, off_button, value, source, at) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET on_button = excluded.on_button, off_button = excluded.off_button,
              value = excluded.value, source = excluded.source, at = excluded.at`)
            .run(id, onButton, offButton, state.value, state.source, state.at);
        } catch { console.warn(JSON.stringify({ event: "optimistic_switch_state_save_failed", id })); }
      },
    };
  }

  close(): void { this.db.close(); }
}
