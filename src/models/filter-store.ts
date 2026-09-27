import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Filter, FilterValidationError, type FilterDocument } from "./filter";
import { filterSchema } from "./filter-schema";
import { nameSlug } from "../page-urls";

export interface SavedFilter { filter: FilterDocument; revision: number; slug: string }
export class FilterStoreError extends Error {
  constructor(message: string, readonly code: "missing" | "conflict" | "forbidden") { super(message); }
}

/** Named Event predicates, stored in the private installation alongside other settings. */
export class FilterStore {
  private readonly db: Database;
  private generationValue = 0;
  /** Changes only after a successful write, so live evaluators can cache compiled predicates. */
  get generation(): number { return this.generationValue; }
  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { strict: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS filters (id TEXT PRIMARY KEY, document TEXT NOT NULL, revision INTEGER NOT NULL)`);
  }

  list(): SavedFilter[] {
    const records = (this.db.query("SELECT document, revision FROM filters ORDER BY id").all() as { document: string; revision: number }[])
      .map(row => ({ filter: new Filter(JSON.parse(row.document)).describe(), revision: row.revision }));
    const counts = new Map<string, number>();
    for (const { filter } of records) { const base = nameSlug(filter.name); counts.set(base, (counts.get(base) ?? 0) + 1); }
    // Reserve every base name before assigning suffixes, including names that look like a suffixed slug.
    const occupied = new Set(counts.keys());
    return records.map(record => {
      const base = nameSlug(record.filter.name);
      let slug = base;
      if (counts.get(base)! > 1) {
        const hash = createHash("sha256").update(record.filter.id).digest("hex");
        let length = 8;
        do { slug = `${base}-${hash.slice(0, length++)}`; } while (occupied.has(slug));
        occupied.add(slug);
      }
      return { ...record, slug };
    }).sort((a, b) => a.filter.name.localeCompare(b.filter.name) || a.filter.id.localeCompare(b.filter.id));
  }

  get(id: string): SavedFilter {
    const record = this.list().find(record => record.filter.id === id);
    if (!record) throw new FilterStoreError("Filter not found", "missing");
    return record;
  }

  getBySlug(slug: string): SavedFilter {
    const record = this.list().find(record => record.slug === slug);
    if (!record) throw new FilterStoreError("Filter not found", "missing");
    return record;
  }

  private document(id: string, input: unknown, updating: boolean): FilterDocument {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new FilterValidationError("Expected a Filter definition");
    const fields = input as Record<string, unknown>;
    const allowed = updating ? ["name", "description", "condition", "revision"] : ["name", "description", "condition"];
    if (Object.keys(fields).some(key => !allowed.includes(key))) throw new FilterValidationError("Unknown Filter field");
    if (updating) this.checkRevision(fields.revision);
    const name = typeof fields.name === "string" ? fields.name.trim() : fields.name;
    return new Filter({ schemaId: filterSchema.$id, id, name, condition: fields.condition,
      ...(fields.description === undefined ? {} : { description: fields.description }) }).describe();
  }

  create(input: unknown): SavedFilter {
    const filter = this.document(`filter-${randomUUID()}`, input, false);
    this.db.query("INSERT INTO filters (id, document, revision) VALUES (?, ?, 1)").run(filter.id, JSON.stringify(filter));
    this.generationValue++;
    return this.get(filter.id);
  }

  update(id: string, input: unknown): SavedFilter {
    const filter = this.document(id, input, true);
    const revision = (input as { revision: number }).revision;
    const saved = this.db.transaction(() => {
      this.expectRevision(id, revision);
      this.db.query("UPDATE filters SET document = ?, revision = revision + 1 WHERE id = ?").run(JSON.stringify(filter), id);
      return this.get(id);
    }).immediate();
    this.generationValue++;
    return saved;
  }

  delete(id: string, revision: unknown): void {
    this.checkRevision(revision);
    this.db.transaction(() => {
      this.expectRevision(id, revision);
      this.db.query("DELETE FROM filters WHERE id = ?").run(id);
    }).immediate();
    this.generationValue++;
  }

  private checkRevision(revision: unknown): asserts revision is number {
    if (!Number.isSafeInteger(revision) || Number(revision) < 1) throw new FilterValidationError("A positive revision is required");
  }
  private expectRevision(id: string, revision: number): void {
    if (this.get(id).revision !== revision) throw new FilterStoreError("This Filter changed elsewhere. Reopen it before updating or deleting it.", "conflict");
  }
  close(): void { this.db.close(); }
}
