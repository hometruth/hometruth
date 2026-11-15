import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Ajv from "ajv/dist/2020";
import { BridgeError, type BridgeDefinition, type BridgeMembership, type BridgeProtocol } from "./model";
import { isElementKey } from "../tags/identity";

import { bridgeMembershipsSchema } from "./schemas";

const validMembers = new Ajv({ strict: true, allowUnionTypes: true }).compile<BridgeMembership[]>(bridgeMembershipsSchema);

export function assertMembers(members: unknown): asserts members is BridgeMembership[] {
  if (!validMembers(members) || members.some(member => !isElementKey(member.element))) throw new BridgeError("Invalid bridge membership or mapping");
  if (new Set(members.map(member => member.element)).size !== members.length) throw new BridgeError("An element can appear only once in a bridge");
  for (const member of members) {
    if (new Set(member.mappings.map(mapping => mapping.id)).size !== member.mappings.length) throw new BridgeError("Mapping IDs must be distinct within an element");
    if (member.accessories && member.mappings.length) throw new BridgeError("Accessory names and types for automatic settings cannot be combined with custom mappings");
  }
}

export class BridgeStore {
  private db: Database;
  private listeners = new Set<() => void>();
  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { strict: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS bridges (id TEXT PRIMARY KEY, name TEXT NOT NULL, protocol TEXT NOT NULL,
        enabled INTEGER NOT NULL, port INTEGER NOT NULL UNIQUE, revision INTEGER NOT NULL, members TEXT NOT NULL)`);
  }
  list(): BridgeDefinition[] {
    return (this.db.query("SELECT * FROM bridges ORDER BY name COLLATE NOCASE, id").all() as (Omit<BridgeDefinition, "enabled" | "members"> & { enabled: number; members: string })[])
      .map(row => ({ ...row, enabled: Boolean(row.enabled), members: JSON.parse(row.members) as BridgeMembership[] }));
  }
  get(id: string): BridgeDefinition {
    const bridge = this.list().find(bridge => bridge.id === id);
    if (!bridge) throw new BridgeError("Bridge not found", "missing");
    return bridge;
  }
  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed(): void { for (const listener of this.listeners) listener(); }
  create(name: string, protocol: BridgeProtocol): BridgeDefinition {
    name = this.name(name);
    if (protocol !== "matter" && protocol !== "homekit") throw new BridgeError("Choose Matter or HomeKit");
    if (this.list().length >= 32) throw new BridgeError("This installation already has 32 bridges");
    const used = new Set(this.list().map(bridge => bridge.port));
    let port = protocol === "matter" ? 5550 : 52100;
    while (used.has(port)) port += protocol === "homekit" ? 160 : 1;
    const id = randomUUID();
    this.db.query("INSERT INTO bridges VALUES (?, ?, ?, 1, ?, 1, '[]')").run(id, name, protocol, port);
    this.changed(); return this.get(id);
  }
  update(id: string, input: { name?: string; enabled?: boolean; members?: BridgeMembership[]; revision: number }): BridgeDefinition {
    const current = this.get(id);
    if (input.revision !== current.revision) throw new BridgeError("This bridge changed in another window. Refresh before saving.", "conflict");
    const name = input.name === undefined ? current.name : this.name(input.name);
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new BridgeError("Enabled must be true or false");
    const members = input.members ?? current.members;
    assertMembers(members);
    const result = this.db.query("UPDATE bridges SET name=?, enabled=?, members=?, revision=revision+1 WHERE id=? AND revision=?")
      .run(name, Number(input.enabled ?? current.enabled), JSON.stringify(members), id, input.revision);
    if (!result.changes) throw new BridgeError("This bridge changed. Refresh before saving.", "conflict");
    this.changed(); return this.get(id);
  }
  remove(id: string, revision: number): void {
    this.get(id);
    if (!this.db.query("DELETE FROM bridges WHERE id=? AND revision=?").run(id, revision).changes) throw new BridgeError("This bridge changed. Refresh before deleting.", "conflict");
    this.changed();
  }
  close(): void { this.db.close(); }
  private name(value: unknown): string {
    if (typeof value !== "string" || !value.trim() || value.trim().length > 100) throw new BridgeError("Give the bridge a name of 1–100 characters");
    return value.trim();
  }
}
