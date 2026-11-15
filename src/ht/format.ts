/**
 * How `ht` puts an answer on a terminal: a padded table, an element, and the
 * graph scene. Nothing here asks the install anything — it renders what
 * `elements.ts` already read, so `--json` and the text below always describe
 * the same answer.
 */
import type { GraphScene } from "../graph/scene";
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
 * doing" is usually why someone typed its address.
 */
export function renderElement(element: Element): string {
  const lines: string[] = [
    `${element.name}  ${[element.kind, element.what, element.status].filter(Boolean).join(" · ")}`,
    ...(element.address ? [`address  ${element.address}`] : []),
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

/** Geometry is optional to the text renderer; the scene is shared with the web graph. */
export type GraphResponse = GraphScene;

/** Print every displayed connection once, including convergence and cycles. */
export function renderGraphText(body: GraphResponse, explain: boolean): string {
  const byId = new Map(body.nodes.map((entry) => [entry.id, entry]));
  const focus = body.nodes.find(entry => entry.node.id === body.query.focus);
  const lines = [focus ? `${focus.node.name}  (${focus.node.kind})` : `${body.query.view} graph`];
  const rows = body.edges.map(({ from, to, edge }) => {
    const source = byId.get(from)?.node.name ?? from;
    const target = byId.get(to)?.node.name ?? to;
    const role = edge.label ? ` [${edge.label}]` : "";
    const via = edge.via ? ` via ${edge.via}` : "";
    return [source, `${edge.relation}${role}${via}`, target, ...(explain ? [edge.origin] : [])];
  });
  if (rows.length) lines.push("", table([["FROM", "RELATION", "TO", ...(explain ? ["ORIGIN"] : [])], ...rows]).trimEnd());
  const connected = new Set(body.edges.flatMap(edge => [edge.from, edge.to]));
  for (const entry of body.nodes) if (!connected.has(entry.id) && entry !== focus) lines.push(`  ${entry.node.name}  (${entry.node.kind})`);
  for (const group of body.groups) if (group.hidden) lines.push(`  … ${group.hidden} more in ${group.name}`);
  for (const entry of body.nodes) if (entry.hidden) lines.push(`  … ${entry.hidden} more connected to ${entry.node.name}`);
  if (body.omitted) lines.push(`${body.omitted} matching elements are outside this view.`);
  return `${lines.join("\n")}\n`;
}
