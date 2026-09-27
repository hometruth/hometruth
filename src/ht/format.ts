/**
 * How `ht` puts an answer on a terminal: a padded table, an element, and the
 * ego graph. Nothing here asks the install anything — it renders what
 * `elements.ts` already read, so `--json` and the text below always describe
 * the same answer.
 */
import { inverseOf, type GraphEdge, type GraphNode, type RelationName } from "../graph/types";
import { RELATION_ORDER } from "../graph/ego";
import type { Element } from "./elements.ts";

/** A moment in the reader's own time, because the reader is in the house, not in UTC. */
function clock(iso: string | undefined): string {
  const when = iso ? new Date(iso) : new Date();
  return Number.isNaN(when.getTime()) ? "--:--:--" : when.toTimeString().slice(0, 8);
}

export function table(rows: readonly (readonly string[])[]): string {
  const widths = rows.reduce<number[]>((acc, row) => row.map((cell, index) => Math.max(acc[index] ?? 0, cell.length)), []);
  return rows.map((row) => row.map((cell, index) => index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)).join("  ").trimEnd()).join("\n") + "\n";
}

/**
 * One element: what it is, what it reads right now, and what may be done to
 * it. The state comes before the controls because the answer to "what is it
 * doing" is usually why someone typed the id.
 */
export function renderElement(element: Element): string {
  const lines: string[] = [
    `${element.name}  ${[element.kind, element.what, element.status].filter(Boolean).join(" · ")}`,
  ];
  if (element.facts.length) lines.push(element.facts.join(" · "));
  const readings = renderReadings(element);
  if (readings) lines.push("", readings.replace(/\n$/u, ""));
  lines.push("", "controls");
  if (!element.controls.length) lines.push("  none");
  const width = Math.max(1, ...element.controls.map((control) => control.name.length));
  for (const control of element.controls) {
    const notes = [
      ...(control.value ? [control.value] : []),
      ...(control.confirm ? ["needs --confirm"] : []),
      ...(control.until ? [`standing until ${clock(control.until)}`] : []),
    ];
    lines.push(`  ${control.name.padEnd(width)}${notes.length ? `  ${notes.join(", ")}` : ""}`.trimEnd());
  }
  return `${lines.join("\n")}\n`;
}

/** Only what an element reads right now, section by section; what a control prints after it lands. */
export function renderReadings(element: Element): string {
  const lines: string[] = [];
  for (const section of element.sections) {
    // A capability with nothing observable still says it is there, and how it is.
    if (!section.readings.length && !section.status) continue;
    if (lines.length) lines.push("");
    lines.push(section.status ? `${section.title}  ${section.status}` : section.title);
    const width = Math.max(0, ...section.readings.map((reading) => reading.label.length));
    for (const reading of section.readings) lines.push(`  ${reading.label.padEnd(width)}  ${reading.value}`.trimEnd());
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}

/**
 * One line of the live view: when it changed, which node, and what it now
 * says. A fault is printed as a fault — never as the value beside it, which
 * is the last good reading and no longer true.
 */
export function renderRecord(data: unknown): string {
  const record = data as {
    node?: string;
    version?: number;
    value?: { status?: string; capabilities?: Record<string, { state?: Record<string, unknown> }> };
    fault?: { code?: string; message?: string };
    updatedAt?: string;
  };
  const head = `${clock(record.updatedAt)}  ${record.node ?? "?"}`;
  if (record.fault) return `${head}  ${record.fault.code ?? "fault"}: ${record.fault.message ?? "no detail"}\n`;
  const parts: string[] = [];
  for (const [kind, capability] of Object.entries(record.value?.capabilities ?? {})) {
    const state = Object.entries(capability.state ?? {})
      .filter(([key]) => key !== "availability" && key !== "observedAt" && key !== "commandedAt")
      .map(([key, value]) => `${key} ${typeof value === "string" ? value : JSON.stringify(value)}`);
    if (state.length) parts.push(`${kind} ${state.join(", ")}`);
  }
  return `${head}  ${record.value?.status ?? "unknown"}${parts.length ? `  ${parts.join(" · ")}` : ""}\n`;
}

export interface GraphResponse {
  readonly focus: string;
  readonly depth: number;
  readonly nodes: readonly { readonly node: GraphNode; readonly depth: number; readonly via?: RelationName }[];
  readonly edges: readonly GraphEdge[];
  readonly truncated: readonly { readonly from: string; readonly relation: string; readonly hidden: number }[];
}

/**
 * The ego view as text: the focus, then each relation and what it reaches,
 * indented by how far away it is. `--explain` adds where each edge came from,
 * which is how you tell a recorded reference from a derived one.
 */
export function renderGraphText(body: GraphResponse, explain: boolean): string {
  const byId = new Map(body.nodes.map((entry) => [entry.node.id, entry]));
  const glyph = (node: GraphNode) => node.icon.kind === "emoji" ? node.icon.value : "[img]";
  const lines: string[] = [];
  const focus = byId.get(body.focus);
  if (focus) lines.push(`${glyph(focus.node)} ${focus.node.name}  (${focus.node.kind})`);

  const seen = new Set<string>([body.focus]);
  const walk = (from: string, indent: string, depth: number) => {
    const buckets = new Map<string, { edge: GraphEdge; other: string }[]>();
    for (const edge of body.edges) {
      if (edge.from !== from && edge.to !== from) continue;
      const other = edge.from === from ? edge.to : edge.from;
      if (seen.has(other) || !byId.get(other)) continue;
      const relation = edge.from === from ? edge.relation : inverseOf(edge.relation);
      const bucket = buckets.get(relation);
      if (bucket) bucket.push({ edge, other });
      else buckets.set(relation, [{ edge, other }]);
    }
    // In display order, so the most meaningful path claims a node first: a
    // blaster belongs under the buttons that drive it, not under the room it
    // happens to share with them.
    const ordered = [...buckets.entries()].sort((a, b) => {
      const rank = (name: string) => { const index = (RELATION_ORDER as readonly string[]).indexOf(name); return index < 0 ? RELATION_ORDER.length : index; };
      return rank(a[0]) - rank(b[0]);
    });
    for (const [relation, entries] of ordered) {
      // Something claimed by a deeper branch is not listed twice, and a bucket
      // left empty by that must not print a heading with nothing under it.
      const fresh = entries.filter(({ other }) => !seen.has(other));
      if (!fresh.length) continue;
      lines.push(`${indent}${relation}`);
      for (const { edge, other } of fresh) {
        if (seen.has(other)) continue;
        seen.add(other);
        const entry = byId.get(other)!;
        const role = edge.label ? ` [${edge.label}]` : "";
        const via = edge.via ? ` via ${edge.via}` : "";
        const origin = explain ? `  (${edge.origin})` : "";
        lines.push(`${indent}  ${glyph(entry.node)} ${entry.node.name}${role}${via}  (${entry.node.kind})${origin}`);
        if (depth < 2) walk(other, `${indent}    `, depth + 1);
      }
    }
  };
  walk(body.focus, "  ", 1);
  for (const entry of body.truncated) {
    const owner = byId.get(entry.from);
    lines.push(`  … ${entry.hidden} more from ${owner?.node.name ?? entry.from}`);
  }
  return `${lines.join("\n")}\n`;
}
