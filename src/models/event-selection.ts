import type { FilterCondition } from "./filter-schema";

export interface EventSelection {
  subjects: readonly string[];
  type: string;
  labels: readonly string[];
  timeWindow?: Extract<FilterCondition, { timeWindow: unknown }>["timeWindow"];
  other: readonly FilterCondition[];
}

/** The simple controls edit only their own clauses. Other predicates survive intact. */
export function readEventSelection(condition: FilterCondition): EventSelection {
  const selection: EventSelection = { subjects: [], type: "", labels: [], other: [] };
  const other: FilterCondition[] = [];
  for (const clause of "all" in condition ? condition.all : [condition]) {
    if ("path" in clause && clause.path === "/subject" && !selection.subjects.length && clause.op === "eq" && typeof clause.value === "string") selection.subjects = [clause.value];
    else if ("path" in clause && clause.path === "/subject" && !selection.subjects.length && clause.op === "in" && clause.value.every(value => typeof value === "string")) selection.subjects = clause.value as readonly string[];
    else if ("path" in clause && clause.op === "eq" && typeof clause.value === "string" && clause.path === "/type" && !selection.type) selection.type = clause.value;
    else if ("detectionLabels" in clause && !selection.labels.length) selection.labels = clause.detectionLabels;
    else if ("timeWindow" in clause && !selection.timeWindow) selection.timeWindow = clause.timeWindow;
    else other.push(clause);
  }
  selection.other = other;
  return selection;
}

export function eventSelectionCondition(selection: EventSelection): FilterCondition {
  const all: FilterCondition[] = [];
  if (selection.subjects.length) all.push({ path: "/subject", op: "in", value: [...new Set(selection.subjects)].sort() });
  if (selection.type) all.push({ path: "/type", op: "eq", value: selection.type });
  if (selection.labels.length) all.push({ detectionLabels: [...selection.labels] });
  if (selection.timeWindow) all.push({ timeWindow: selection.timeWindow });
  all.push(...selection.other);
  return { all };
}
