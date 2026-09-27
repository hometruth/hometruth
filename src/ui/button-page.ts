import type { RegisteredDevice } from "../site";
import { deviceNode } from "../state/protocol";
import type { WorkflowDefinition, WorkflowNode, WorkflowRunView } from "../workflows/runner";
import type { MessageKey } from "./i18n/en";
import { escapeHtml, htElement, renderDeviceHead, renderPage, type PageContext } from "./shell";

export interface WorkflowTarget {
  readonly id: string;
  readonly name: string;
  readonly room?: string;
  readonly controls: readonly string[];
}

export interface ButtonPageOptions {
  ctx: PageContext;
  device: RegisteredDevice;
  workflow?: WorkflowDefinition;
  workflowTargets?: readonly WorkflowTarget[];
  workflowRun?: WorkflowRunView;
  canEditWorkflow?: boolean;
}

export const WORKFLOW_API = { document: "/api/buttons/:id/workflow", save: "/api/buttons/:id/workflow" } as const;

const WORKFLOW_CSS = String.raw`
  .workflow-graph, .workflow-branches { list-style: none; margin: 0; padding: 0; }
  .workflow-graph { border-block-start: var(--rule-w) solid var(--rule); }
  .workflow-node { position: relative; padding: var(--s3) 0 var(--s3) var(--s5); border-block-end: 1px solid var(--hair); }
  .workflow-node::before { content: ""; position: absolute; inset-block: 0; inset-inline-start: .75rem; border-inline-start: 1px solid var(--hair); }
  .workflow-node > article { position: relative; border: var(--rule-w) solid var(--rule); padding: var(--s3); background: var(--panel); }
  .workflow-node > article::before { content: ""; position: absolute; inset-inline-start: -.55rem; inset-block-start: 1rem; width: .9rem; border-block-start: 1px solid var(--rule); }
  .workflow-node-title { display: flex; align-items: baseline; justify-content: space-between; gap: var(--s3); }
  .workflow-node-title strong { font-weight: 600; }
  .workflow-node-meta { display: block; color: var(--fg-2); font-size: .875rem; overflow-wrap: anywhere; }
  .workflow-branches { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--s3); margin: var(--s3) 0 0 var(--s5); }
  .workflow-branch { min-width: 0; }
  .workflow-branch-label { display: block; margin-block-end: var(--s1); color: var(--fg-2); font-size: .75rem; letter-spacing: .08em; text-transform: uppercase; }
  .workflow-branch > .workflow-node { padding-inline-start: var(--s3); }
  .workflow-branch > .workflow-node::before { display: none; }
  .workflow-cycle, .workflow-unreachable { color: var(--fg-2); font-size: .875rem; padding: var(--s2) 0; }
  .workflow-unreachable { margin-block-start: var(--s3); padding-block-start: var(--s3); border-block-start: 1px solid var(--hair); }
  .workflow-run { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--s2) var(--s4); padding-block: var(--s3); border-block: var(--rule-w) solid var(--rule); }
  .workflow-run strong { font-weight: 600; }
  .workflow-run[data-status="running"] strong { color: var(--warn); }
  .workflow-run[data-status="failed"] strong { color: var(--bad); }
  .workflow-editor { margin-block-start: var(--s6); }
  .workflow-editor > form { border-block-start: var(--rule-w) solid var(--rule); }
  .workflow-editor-start { display: flex; gap: var(--s3); flex-wrap: wrap; align-items: baseline; padding-block: var(--s3); border-block-end: 1px solid var(--hair); }
  .workflow-editor-start input { width: min(18rem, 100%); }
  .workflow-nodes { list-style: none; margin: 0; padding: 0; }
  .workflow-edit-node { padding-block: var(--s4); border-block-end: 1px solid var(--hair); }
  .workflow-edit-head { display: flex; gap: var(--s2); align-items: center; flex-wrap: wrap; }
  .workflow-edit-head input { flex: 1 1 12rem; min-width: 8rem; }
  .workflow-edit-head select { flex: 0 1 10rem; }
  .workflow-edit-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 var(--s4); margin-block-start: var(--s3); }
  .workflow-edit-fields .full { grid-column: 1 / -1; }
  .workflow-edit-fields [data-workflow-field] { display: none; }
  .workflow-edit-fields[data-node-type="action"] [data-workflow-field="target"], .workflow-edit-fields[data-node-type="action"] [data-workflow-field="action"], .workflow-edit-fields[data-node-type="action"] [data-workflow-field="next"],
  .workflow-edit-fields[data-node-type="delay"] [data-workflow-field="duration"], .workflow-edit-fields[data-node-type="delay"] [data-workflow-field="next"],
  .workflow-edit-fields[data-node-type="condition"] [data-workflow-field="target"], .workflow-edit-fields[data-node-type="condition"] [data-workflow-field="condition"], .workflow-edit-fields[data-node-type="condition"] [data-workflow-field="next-branch"],
  .workflow-edit-fields[data-node-type="action"] [data-workflow-field="confirm"],
  .workflow-edit-fields[data-node-type="action"] [data-workflow-field="value"], .workflow-edit-fields[data-node-type="condition"] [data-workflow-field="value"] { display: block; }
  .workflow-edit-fields textarea { min-height: 4.5rem; font-family: var(--font-mono); font-size: .8125rem; }
  .workflow-run strong[data-run-status] { min-width: 6rem; }
  .workflow-steps { list-style: none; margin: 0; padding: 0; counter-reset: step; border-block-start: var(--rule-w) solid var(--rule); }
  .workflow-step { counter-increment: step; display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2) var(--s3); padding-block: var(--s3); border-block-end: 1px solid var(--hair); }
  .workflow-step::before { content: counter(step); flex: 0 0 1.5rem; color: var(--fg-2); font-variant-numeric: tabular-nums; }
  .workflow-step[aria-current="step"]::before { content: "▸"; color: var(--warn); }
  .workflow-step[aria-current="step"] { background: var(--panel); }
  .workflow-step select { flex: 1 1 12rem; min-width: 0; }
  .workflow-step [data-step-value] { flex: 0 1 8rem; min-width: 5rem; }
  .workflow-step [data-step-amount] { flex: 0 0 6rem; width: 6rem; }
  .workflow-step [data-step-unit] { flex: 0 1 9rem; }
  .workflow-step-wait { flex: 0 0 auto; min-width: 5rem; }
  .workflow-step-tools { display: flex; gap: var(--s1); margin-inline-start: auto; }
  .workflow-empty { color: var(--fg-2); padding-block: var(--s3); border-block-end: 1px solid var(--hair); }
  .workflow-steps:has(.workflow-step) + .workflow-empty { display: none; }
  .workflow-advanced { margin-block-start: var(--s6); }
  .workflow-advanced > summary { cursor: pointer; color: var(--fg-2); }
  .workflow-advanced[open] > summary { margin-block-end: var(--s3); }
  @media (max-width: 38rem) { .workflow-branches, .workflow-edit-fields { grid-template-columns: 1fr; } .workflow-edit-fields .full { grid-column: auto; } }
`;

function nodeName(node: WorkflowNode): string {
  if (node.label) return node.label;
  if (node.type === "action") return `${node.device} · ${node.control}`;
  if (node.type === "delay") return `Wait ${node.durationMs / 1000}s`;
  if (node.type === "condition") return `If ${node.device}.${node.path}`;
  return "End";
}

function nodeDetail(node: WorkflowNode): string {
  if (node.type === "action") return `${node.device} → ${node.control}`;
  if (node.type === "delay") return `${node.durationMs.toLocaleString()} ms`;
  if (node.type === "condition") return `${node.operator}${Object.hasOwn(node, "value") ? ` ${JSON.stringify(node.value)}` : ""}`;
  return "Workflow complete";
}

function graphPath(id: string | undefined, nodes: ReadonlyMap<string, WorkflowNode>, seen: ReadonlySet<string>): string {
  if (!id) return "";
  const node = nodes.get(id);
  if (!node) return `<li class="workflow-cycle">Missing node ${escapeHtml(id)}</li>`;
  if (seen.has(id)) return `<li class="workflow-cycle">↺ ${escapeHtml(id)}</li>`;
  const nextSeen = new Set(seen).add(id);
  let children = "";
  if (node.type === "condition") {
    children = `<ol class="workflow-branches">
      <li class="workflow-branch"><span class="workflow-branch-label">true</span><ol class="workflow-graph">${graphPath(node.ifTrue, nodes, nextSeen)}</ol></li>
      <li class="workflow-branch"><span class="workflow-branch-label">false</span><ol class="workflow-graph">${graphPath(node.ifFalse, nodes, nextSeen)}</ol></li>
    </ol>`;
  } else if (node.type !== "end" && node.next) {
    children = `<ol class="workflow-graph">${graphPath(node.next, nodes, nextSeen)}</ol>`;
  }
  return `<li class="workflow-node" data-node-id="${escapeHtml(node.id)}" data-node-type="${escapeHtml(node.type)}">
    <article><div class="workflow-node-title"><strong>${escapeHtml(nodeName(node))}</strong><code>${escapeHtml(node.id)}</code></div><span class="workflow-node-meta">${escapeHtml(nodeDetail(node))}</span></article>${children}
  </li>`;
}

function renderWorkflowGraph(workflow: WorkflowDefinition): string {
  const nodes = new Map(workflow.nodes.map((node) => [node.id, node]));
  const reachable = new Set<string>();
  const visit = (id: string) => {
    if (reachable.has(id)) return;
    const node = nodes.get(id); if (!node) return;
    reachable.add(id);
    if (node.type === "condition") { visit(node.ifTrue); visit(node.ifFalse); }
    else if (node.type !== "end" && node.next) visit(node.next);
  };
  visit(workflow.start);
  const unreachable = workflow.nodes.filter((node) => !reachable.has(node.id));
  return `<ol class="workflow-graph" aria-label="Workflow state machine">${graphPath(workflow.start, nodes, new Set())}</ol>
    ${unreachable.length ? `<p class="workflow-unreachable">Unreachable nodes: ${unreachable.map((node) => `<code>${escapeHtml(node.id)}</code>`).join(", ")}</p>` : ""}`;
}

function targetOptions(targets: readonly WorkflowTarget[], selected?: string): string {
  return `<option value="">Choose a device…</option>${targets.map((target) => `<option value="${escapeHtml(target.id)}"${target.id === selected ? " selected" : ""}>${escapeHtml(target.name)}</option>`).join("")}`;
}

function workflowNodeEditor(node: WorkflowNode, targets: readonly WorkflowTarget[]): string {
  const value = node.type === "action" || node.type === "condition" ? (Object.hasOwn(node, "value") ? JSON.stringify(node.value) : "") : "";
  const operator = node.type === "condition" ? node.operator : "equals";
  const typeOptions = ["action", "delay", "condition", "end"].map((type) => `<option value="${type}"${node.type === type ? " selected" : ""}>${type[0]!.toUpperCase()}${type.slice(1)}</option>`).join("");
  return `<li class="workflow-edit-node" data-workflow-node data-node-id="${escapeHtml(node.id)}">
    <div class="workflow-edit-head"><input data-field="id" value="${escapeHtml(node.id)}" required maxlength="100" class="mono" aria-label="Node id"><select data-field="type" aria-label="Node type">${typeOptions}</select><button type="button" class="btn btn-small btn-danger" data-remove-node>Remove</button></div>
    <div class="workflow-edit-fields" data-node-type="${escapeHtml(node.type)}">
      <label class="field full"><span>Label</span><input data-field="label" value="${escapeHtml(node.label ?? "")}" maxlength="200"></label>
      <label class="field" data-workflow-field="target"><span>Device</span><select data-field="device">${targetOptions(targets, node.type === "action" || node.type === "condition" ? node.device : undefined)}</select></label>
      <label class="field" data-workflow-field="action"><span>Control</span><input data-field="control" value="${escapeHtml(node.type === "action" ? node.control : "")}" list="workflow-controls" placeholder="turnOn"></label>
      <label class="field" data-workflow-field="value"><span>Value (JSON, optional)</span><textarea data-field="value" spellcheck="false">${escapeHtml(value)}</textarea></label>
      <label class="field" data-workflow-field="confirm"><span><input data-field="confirmed" type="checkbox"${node.type === "action" && node.confirmed === true ? " checked" : ""}> Confirm this action</span></label>
      <label class="field" data-workflow-field="duration"><span>Wait (seconds)</span><input data-field="duration" type="number" min="0" max="86400" step="0.1" value="${node.type === "delay" ? escapeHtml(String(node.durationMs / 1000)) : "0"}"></label>
      <label class="field" data-workflow-field="next"><span>Next node id</span><input data-field="next" value="${node.type === "action" || node.type === "delay" ? escapeHtml(node.next ?? "") : ""}" class="mono"></label>
      <div class="field" data-workflow-field="condition"><span>Comparison</span><select data-field="operator">${["equals", "notEquals", "greaterThan", "lessThan", "contains", "truthy", "falsy"].map((item) => `<option value="${item}"${item === operator ? " selected" : ""}>${item}</option>`).join("")}</select></div>
      <label class="field" data-workflow-field="next-branch"><span>True branch node id</span><input data-field="ifTrue" value="${node.type === "condition" ? escapeHtml(node.ifTrue) : ""}" class="mono"></label>
      <label class="field" data-workflow-field="next-branch"><span>False branch node id</span><input data-field="ifFalse" value="${node.type === "condition" ? escapeHtml(node.ifFalse) : ""}" class="mono"></label>
      <label class="field" data-workflow-field="condition"><span>State path</span><input data-field="path" value="${node.type === "condition" ? escapeHtml(node.path) : ""}" class="mono" placeholder="capabilities.binarySwitch.state.value"></label>
    </div>
  </li>`;
}

function renderWorkflowEditor(workflow: WorkflowDefinition, targets: readonly WorkflowTarget[], canEdit: boolean, t: PageContext["i18n"]["t"]): string {
  if (!canEdit) return `<p class="note">This HomeTruth instance has no writable device configuration.</p>`;
  const targetData = escapeHtml(JSON.stringify(targets));
  const template = workflowNodeEditor({ id: "new-node", type: "action", device: targets[0]?.id ?? "", control: targets[0]?.controls[0] ?? "", next: "" }, targets);
  return `<div class="workflow-editor" data-workflow-editor data-targets="${targetData}">
    <form>
      <div class="workflow-editor-start"><label>Start at <input data-workflow-start value="${escapeHtml(workflow.start)}" required class="mono"></label><label>Concurrency <select data-workflow-concurrency><option value=""${workflow.concurrency === undefined ? " selected" : ""}>Default (replace)</option>${["parallel", "replace", "ignore"].map((item) => `<option value="${item}"${workflow.concurrency === item ? " selected" : ""}>${item}</option>`).join("")}</select></label><label>Max steps <input data-workflow-max-steps type="number" min="1" max="10000" step="1" value="${workflow.maxSteps === undefined ? "" : escapeHtml(String(workflow.maxSteps))}"></label><span class="muted small">Edges use node ids. A condition chooses its true or false branch.</span></div>
      <ol class="workflow-nodes" data-workflow-nodes>${workflow.nodes.map((node) => workflowNodeEditor(node, targets)).join("")}</ol>
      <template data-workflow-node-template>${template}</template>
      <datalist id="workflow-controls"></datalist>
      <div class="bar"><button type="button" class="btn" data-workflow-add="action">${escapeHtml(t("action.add"))} action</button><button type="button" class="btn" data-workflow-add="delay">${escapeHtml(t("action.add"))} delay</button><button type="button" class="btn" data-workflow-add="condition">${escapeHtml(t("action.add"))} condition</button><button type="button" class="btn" data-workflow-add="end">${escapeHtml(t("action.add"))} end</button><button type="submit" class="btn btn-primary">${escapeHtml(t("action.save"))}</button></div>
      <output class="feedback" data-workflow-feedback role="status" aria-live="polite"></output>
    </form>
  </div>`;
}

type WorkflowStep =
  | { readonly type: "action"; readonly node: Extract<WorkflowNode, { type: "action" }> }
  | { readonly type: "wait"; readonly node: Extract<WorkflowNode, { type: "delay" }> };

/**
 * The workflow as a plain list of steps when it is one: a single chain of
 * actions and waits from the start, optionally closed by an end node, with
 * nothing branching, looping, or left over. Anything else is a state machine.
 */
export function workflowSteps(workflow: WorkflowDefinition): WorkflowStep[] | undefined {
  const nodes = new Map(workflow.nodes.map((node) => [node.id, node]));
  const steps: WorkflowStep[] = [];
  const seen = new Set<string>();
  let current: string | undefined = workflow.start;
  while (current !== undefined) {
    const node = nodes.get(current);
    if (!node || seen.has(current)) return undefined;
    seen.add(current);
    if (node.type === "condition") return undefined;
    if (node.type === "end") break;
    steps.push(node.type === "action" ? { type: "action", node } : { type: "wait", node });
    current = node.next;
  }
  return seen.size === workflow.nodes.length ? steps : undefined;
}

const CONTROL_LABELS: Readonly<Record<string, MessageKey>> = {
  turnOn: "workflow.control.turnOn",
  turnOff: "workflow.control.turnOff",
  toggle: "workflow.control.toggle",
  press: "workflow.control.press",
};

const WAIT_UNITS = [["hours", 3600000], ["minutes", 60000], ["seconds", 1000]] as const;

/** Controls that take a value get a value field; the rest are a bare verb. */
const VALUED_CONTROL = /^(?:set|apply|play|send)[A-Z]|^send$/u;

function controlOptions(ctx: PageContext, controls: readonly string[], selected: string): string {
  const all = controls.includes(selected) || !selected ? controls : [selected, ...controls];
  return all.map((control) => {
    const key = CONTROL_LABELS[control];
    return `<option value="${escapeHtml(control)}"${control === selected ? " selected" : ""}>${escapeHtml(key ? ctx.i18n.t(key) : control)}</option>`;
  }).join("");
}

function deviceOptions(ctx: PageContext, targets: readonly WorkflowTarget[], selected: string): string {
  const rooms = new Map<string, WorkflowTarget[]>();
  for (const target of targets) rooms.set(target.room ?? "", [...(rooms.get(target.room ?? "") ?? []), target]);
  const option = (target: WorkflowTarget) => `<option value="${escapeHtml(target.id)}"${target.id === selected ? " selected" : ""}>${escapeHtml(target.name)}</option>`;
  const known = targets.some((target) => target.id === selected);
  return `${selected && !known ? `<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)}</option>` : `<option value=""${selected ? "" : " selected"} disabled>${escapeHtml(ctx.i18n.t("workflow.chooseDevice"))}</option>`}${[...rooms].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b))).map(([room, members]) => {
    const list = members.map(option).join("");
    return room ? `<optgroup label="${escapeHtml(room)}">${list}</optgroup>` : list;
  }).join("")}`;
}

function stepTools(ctx: PageContext): string {
  const { t } = ctx.i18n;
  return `<span class="workflow-step-tools"><button type="button" class="btn btn-small" data-step-move="-1" aria-label="${escapeHtml(t("workflow.moveUp"))}" title="${escapeHtml(t("workflow.moveUp"))}">↑</button><button type="button" class="btn btn-small" data-step-move="1" aria-label="${escapeHtml(t("workflow.moveDown"))}" title="${escapeHtml(t("workflow.moveDown"))}">↓</button><button type="button" class="btn btn-small btn-danger" data-step-remove>${escapeHtml(t("action.remove"))}</button></span>`;
}

function actionStep(ctx: PageContext, targets: readonly WorkflowTarget[], node: { id: string; label?: string; device: string; control: string; value?: unknown; confirmed?: boolean }): string {
  const { t } = ctx.i18n;
  const controls = targets.find((target) => target.id === node.device)?.controls ?? [];
  const hasValue = Object.hasOwn(node, "value");
  const value = hasValue ? (typeof node.value === "string" ? node.value : JSON.stringify(node.value)) : "";
  return `<li class="workflow-step" data-step="action" data-node-id="${escapeHtml(node.id)}"${node.label ? ` data-label="${escapeHtml(node.label)}"` : ""}${node.confirmed ? " data-confirmed" : ""}>
    <select data-step-device aria-label="${escapeHtml(t("workflow.device"))}">${deviceOptions(ctx, targets, node.device)}</select>
    <select data-step-control aria-label="${escapeHtml(t("workflow.control"))}">${controlOptions(ctx, controls, node.control)}</select>
    <input data-step-value aria-label="${escapeHtml(t("workflow.value"))}" placeholder="${escapeHtml(t("workflow.value"))}" value="${escapeHtml(value)}"${hasValue || VALUED_CONTROL.test(node.control) ? "" : " hidden"}>
    ${stepTools(ctx)}
  </li>`;
}

function waitStep(ctx: PageContext, node: { id: string; label?: string; durationMs: number }): string {
  const { t } = ctx.i18n;
  const [unit, size] = WAIT_UNITS.find(([, ms]) => node.durationMs > 0 && node.durationMs % ms === 0) ?? WAIT_UNITS[2];
  return `<li class="workflow-step" data-step="wait" data-node-id="${escapeHtml(node.id)}"${node.label ? ` data-label="${escapeHtml(node.label)}"` : ""}>
    <span class="workflow-step-wait">${escapeHtml(t("workflow.wait"))}</span>
    <input data-step-amount type="number" min="0" step="any" required value="${escapeHtml(String(node.durationMs / size))}" aria-label="${escapeHtml(t("workflow.duration"))}">
    <select data-step-unit aria-label="${escapeHtml(t("workflow.unit"))}">${WAIT_UNITS.map(([name, ms]) => `<option value="${ms}"${name === unit ? " selected" : ""}>${escapeHtml(t(`workflow.${name}` as const))}</option>`).join("")}</select>
    ${stepTools(ctx)}
  </li>`;
}

/** The plain editor: one row per step, run top to bottom. */
function renderStepsEditor(ctx: PageContext, workflow: WorkflowDefinition, steps: readonly WorkflowStep[], allTargets: readonly WorkflowTarget[], current?: string): string {
  const { t } = ctx.i18n;
  const targets = allTargets.filter((target) => target.controls.length > 0);
  const timer = targets.some((target) => target.controls.includes("turnOn") && target.controls.includes("turnOff"));
  const settings = { ...(workflow.concurrency ? { concurrency: workflow.concurrency } : {}), ...(workflow.maxSteps ? { maxSteps: workflow.maxSteps } : {}) };
  return `<form class="workflow-steps-editor" data-steps-editor data-targets="${escapeHtml(JSON.stringify(targets))}" data-settings="${escapeHtml(JSON.stringify(settings))}">
    <ol class="workflow-steps" data-steps>${steps.map((step) => {
      const row = step.type === "action" ? actionStep(ctx, targets, step.node) : waitStep(ctx, step.node);
      return step.node.id === current ? row.replace("<li ", '<li aria-current="step" ') : row;
    }).join("")}</ol>
    <p class="workflow-empty">${escapeHtml(t("workflow.empty"))}</p>
    <template data-step-template="action">${actionStep(ctx, targets, { id: "", device: "", control: "" })}</template>
    <template data-step-template="wait">${waitStep(ctx, { id: "", durationMs: 300000 })}</template>
    <div class="bar"><button type="button" class="btn" data-step-add="action">${escapeHtml(t("workflow.addAction"))}</button><button type="button" class="btn" data-step-add="wait">${escapeHtml(t("workflow.addWait"))}</button>${timer ? `<button type="button" class="btn" data-step-add="timer">${escapeHtml(t("workflow.addTimer"))}</button>` : ""}<button type="submit" class="btn btn-primary">${escapeHtml(t("action.save"))}</button></div>
    <output class="feedback" data-steps-feedback role="status" aria-live="polite"></output>
  </form>`;
}

/**
 * The workflow half of the page: the run line and the editor. Pressing is the
 * `<ht-button>` element's job. A press leaves the Button's document unchanged,
 * so no frame follows it; the run line refreshes when the host drops
 * `aria-busy`, which is the moment the press has been answered and a run exists.
 */
const WORKFLOW_SCRIPT = String.raw`
  (() => {
    const root = document.querySelector("[data-button-page]");
    if (!(root instanceof HTMLElement)) return;
    const id = encodeURIComponent(root.dataset.deviceId || "");
    const url = (template) => template.replace(":id", id);
    const runLine = (run) => {
      const line = document.querySelector("[data-workflow-run]");
      if (!(line instanceof HTMLElement) || !run) return;
      line.dataset.status = run.status || "idle";
      const label = line.querySelector("[data-run-status]");
      const detail = line.querySelector("[data-run-detail]");
      const stepRows = [...document.querySelectorAll("[data-steps] > [data-node-id]")];
      const current = stepRows.findIndex((row) => row instanceof HTMLElement && row.dataset.nodeId === run.currentNodeId);
      for (const row of stepRows) row.removeAttribute("aria-current");
      if (current >= 0) stepRows[current].setAttribute("aria-current", "step");
      if (label instanceof HTMLElement) label.textContent = ht.t("workflow.run." + (run.status || "idle"));
      if (detail instanceof HTMLElement) detail.textContent = run.error ? " · " + run.error : current >= 0 ? "" : run.currentNodeId ? " · " + run.currentNodeId : "";
    };
    const refreshRun = () => ht.request(url("/api/buttons/:id/workflow")).then((payload) => { runLine(payload.run); return payload.run; }).catch(() => null);
    const poll = (run) => { if (run && run.status === "running") window.setTimeout(() => refreshRun().then(poll), 1000); };
    if (document.querySelector("[data-workflow-run]")) {
      poll({ status: document.querySelector("[data-workflow-run]").dataset.status });
      const press = root.querySelector("ht-button");
      if (press instanceof HTMLElement) {
        new MutationObserver(() => { if (!press.hasAttribute("aria-busy")) refreshRun().then(poll); }).observe(press, { attributes: true, attributeFilter: ["aria-busy"] });
      }
    }

    const steps = document.querySelector("[data-steps-editor]");
    if (steps instanceof HTMLFormElement) {
      const targets = JSON.parse(steps.dataset.targets || "[]");
      const list = steps.querySelector("[data-steps]");
      const valued = /^(?:set|apply|play|send)[A-Z]|^send$/;
      const labelFor = (control) => { const key = "workflow.control." + control; const text = ht.t(key); return text === key ? control : text; };
      const fillControls = (row, preferred) => {
        const device = row.querySelector("[data-step-device]");
        const control = row.querySelector("[data-step-control]");
        if (!(device instanceof HTMLSelectElement) || !(control instanceof HTMLSelectElement)) return;
        const controls = targets.find((target) => target.id === device.value)?.controls || [];
        const keep = preferred ?? control.value;
        control.replaceChildren(...controls.map((id) => { const option = document.createElement("option"); option.value = id; option.textContent = labelFor(id); return option; }));
        if (controls.includes(keep)) control.value = keep;
        showValue(row);
      };
      const showValue = (row) => {
        const control = row.querySelector("[data-step-control]");
        const value = row.querySelector("[data-step-value]");
        if (value instanceof HTMLInputElement) value.hidden = !value.value && !valued.test(control?.value || "");
      };
      const lastAction = () => [...list.querySelectorAll('[data-step="action"]')].pop();
      const add = (type, device, control) => {
        const template = steps.querySelector('template[data-step-template="' + type + '"]');
        const row = template instanceof HTMLTemplateElement ? template.content.firstElementChild?.cloneNode(true) : null;
        if (!(row instanceof HTMLElement)) return null;
        list.append(row);
        if (type === "action") {
          const select = row.querySelector("[data-step-device]");
          if (select instanceof HTMLSelectElement && device) select.value = device;
          fillControls(row, control);
        }
        return row;
      };
      steps.addEventListener("change", (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const row = target.closest("[data-step]");
        if (!row) return;
        if (target.matches("[data-step-device]")) fillControls(row);
        if (target.matches("[data-step-control]")) showValue(row);
      });
      steps.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const row = target.closest("[data-step]");
        if (row && target.closest("[data-step-remove]")) { row.remove(); return; }
        const move = target.closest("[data-step-move]");
        if (row && move instanceof HTMLElement) {
          if (move.dataset.stepMove === "-1" && row.previousElementSibling) row.previousElementSibling.before(row);
          if (move.dataset.stepMove === "1" && row.nextElementSibling) row.nextElementSibling.after(row);
          move.focus();
          return;
        }
        const adder = target.closest("[data-step-add]");
        if (!(adder instanceof HTMLElement)) return;
        const previous = lastAction();
        const device = previous?.querySelector("[data-step-device]")?.value || "";
        const control = previous?.querySelector("[data-step-control]")?.value || "";
        const kind = adder.dataset.stepAdd;
        let first = null;
        if (kind === "timer") {
          const switchable = (id) => { const controls = targets.find((item) => item.id === id)?.controls || []; return controls.includes("turnOn") && controls.includes("turnOff"); };
          const id = switchable(device) ? device : targets.find((item) => switchable(item.id))?.id || "";
          first = add("action", id, "turnOn"); add("wait"); add("action", id, "turnOff");
        } else if (kind === "action") {
          first = add("action", device, control === "turnOn" ? "turnOff" : control === "turnOff" ? "turnOn" : control);
        } else first = add("wait");
        first?.querySelector("select, input")?.focus();
      });
      steps.addEventListener("submit", async (event) => {
        event.preventDefault();
        const feedback = steps.querySelector("[data-steps-feedback]");
        const rows = [...list.querySelectorAll("[data-step]")];
        const nodes = [];
        for (const [index, row] of rows.entries()) {
          const id = "step-" + (index + 1);
          const next = index + 1 < rows.length ? "step-" + (index + 2) : "done";
          const label = row.dataset.label ? { label: row.dataset.label } : {};
          if (row.dataset.step === "wait") {
            const durationMs = Math.round(Number(row.querySelector("[data-step-amount]")?.value || 0) * Number(row.querySelector("[data-step-unit]")?.value || 1000));
            if (durationMs > 86400000) { ht.say(feedback, ht.t("workflow.tooLong"), "bad"); return; }
            nodes.push({ id, type: "delay", ...label, durationMs, next });
          } else {
            const device = row.querySelector("[data-step-device]")?.value || "";
            const control = row.querySelector("[data-step-control]")?.value || "";
            if (!device || !control) { ht.say(feedback, ht.t("workflow.missingDevice", { step: index + 1 }), "bad"); row.querySelector("select")?.focus(); return; }
            const input = row.querySelector("[data-step-value]");
            const raw = input instanceof HTMLInputElement && !input.hidden ? input.value.trim() : "";
            let value;
            if (raw) { try { value = JSON.parse(raw); } catch { value = raw; } }
            nodes.push({ id, type: "action", ...label, device, control, ...(raw ? { value } : {}), ...(row.hasAttribute("data-confirmed") ? { confirmed: true } : {}), next });
          }
        }
        nodes.push({ id: "done", type: "end" });
        const workflow = { start: nodes[0].id, nodes, ...JSON.parse(steps.dataset.settings || "{}") };
        const save = steps.querySelector('button[type="submit"]'); if (save instanceof HTMLButtonElement) save.disabled = true;
        ht.say(feedback, ht.t("feedback.saving"));
        try { await ht.request(url("/api/buttons/:id/workflow"), { method: "PUT", body: JSON.stringify({ workflow }) }); ht.say(feedback, ht.t("feedback.savedReloading"), "ok"); window.setTimeout(() => window.location.reload(), 300); }
        catch (error) { ht.say(feedback, error instanceof Error ? error.message : ht.t("feedback.requestFailed"), "bad"); if (save instanceof HTMLButtonElement) save.disabled = false; }
      });
    }

    const editor = document.querySelector("[data-workflow-editor]");
    if (!(editor instanceof HTMLElement)) return;
    const targets = JSON.parse(editor.dataset.targets || "[]");
    const nodes = editor.querySelector("[data-workflow-nodes]");
    const template = editor.querySelector("template[data-workflow-node-template]");
    const controls = editor.querySelector("#workflow-controls");
    const updateControls = (node) => {
      if (!(node instanceof HTMLElement) || !(controls instanceof HTMLDataListElement)) return;
      const device = node.querySelector('[data-field="device"]');
      controls.replaceChildren(...((targets.find((target) => target.id === device?.value)?.controls || []).map((control) => { const option = document.createElement("option"); option.value = control; return option; })));
    };
    const updateNode = (node) => {
      if (!(node instanceof HTMLElement)) return;
      const type = node.querySelector('[data-field="type"]')?.value || "action";
      const fields = node.querySelector(".workflow-edit-fields");
      if (fields instanceof HTMLElement) fields.dataset.nodeType = type;
      updateControls(node);
    };
    for (const node of editor.querySelectorAll("[data-workflow-node]")) updateNode(node);
    editor.addEventListener("change", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const node = target.closest("[data-workflow-node]");
      if (node && (target.matches('[data-field="type"]') || target.matches('[data-field="device"]'))) updateNode(node);
    });
    editor.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const remove = target.closest("[data-remove-node]");
      if (remove) { remove.closest("[data-workflow-node]")?.remove(); return; }
      const add = target.closest("[data-workflow-add]");
      if (!add || !(nodes instanceof HTMLOListElement) || !(template instanceof HTMLTemplateElement)) return;
      const fragment = template.content.cloneNode(true);
      const node = fragment instanceof DocumentFragment ? fragment.firstElementChild : null;
      if (!(node instanceof HTMLElement)) return;
      const count = nodes.querySelectorAll("[data-workflow-node]").length + 1;
      node.dataset.nodeId = (add.dataset.workflowAdd || "action") + "-" + count;
      const id = node.querySelector('[data-field="id"]'); if (id instanceof HTMLInputElement) id.value = node.dataset.nodeId;
      const type = node.querySelector('[data-field="type"]'); if (type instanceof HTMLSelectElement) type.value = add.dataset.workflowAdd || "action";
      updateNode(node); nodes.append(node);
    });
    editor.addEventListener("submit", async (event) => {
      event.preventDefault();
      const feedback = editor.querySelector("[data-workflow-feedback]");
      const workflow = { start: String(editor.querySelector("[data-workflow-start]")?.value || ""), nodes: [] };
      const concurrency = String(editor.querySelector("[data-workflow-concurrency]")?.value || "");
      const maxSteps = Number(editor.querySelector("[data-workflow-max-steps]")?.value || 0);
      if (concurrency) workflow.concurrency = concurrency;
      if (maxSteps) workflow.maxSteps = maxSteps;
      for (const node of editor.querySelectorAll("[data-workflow-node]")) {
        const value = (field) => node.querySelector('[data-field="' + field + '"]')?.value?.trim() || "";
        const base = { id: value("id"), type: value("type"), ...(value("label") ? { label: value("label") } : {}) };
        if (base.type === "action") {
          const item = { ...base, device: value("device"), control: value("control"), ...(value("next") ? { next: value("next") } : {}) };
          if (value("value")) { try { item.value = JSON.parse(value("value")); } catch { ht.say(feedback, "Value must be valid JSON.", "bad"); return; } }
          if (node.querySelector('[data-field="confirmed"]')?.checked) item.confirmed = true;
          workflow.nodes.push(item);
        } else if (base.type === "delay") workflow.nodes.push({ ...base, durationMs: Math.round(Number(value("duration") || 0) * 1000), ...(value("next") ? { next: value("next") } : {}) });
        else if (base.type === "condition") {
          const item = { ...base, device: value("device"), path: value("path"), operator: value("operator"), ifTrue: value("ifTrue"), ifFalse: value("ifFalse") };
          if (value("value")) { try { item.value = JSON.parse(value("value")); } catch { ht.say(feedback, "Value must be valid JSON.", "bad"); return; } }
          workflow.nodes.push(item);
        } else workflow.nodes.push(base);
      }
      const save = editor.querySelector('button[type="submit"]'); if (save instanceof HTMLButtonElement) save.disabled = true;
      ht.say(feedback, ht.t("feedback.saving"));
      try { await ht.request(url("/api/buttons/:id/workflow"), { method: "PUT", body: JSON.stringify({ workflow }) }); ht.say(feedback, ht.t("feedback.savedReloading"), "ok"); window.setTimeout(() => window.location.reload(), 300); }
      catch (error) { ht.say(feedback, error instanceof Error ? error.message : ht.t("feedback.requestFailed"), "bad"); if (save instanceof HTMLButtonElement) save.disabled = false; }
    });
  })();
`;

export function renderButtonPage({ ctx, device, workflow, workflowTargets = [], workflowRun, canEditWorkflow = false }: ButtonPageOptions): string {
  const { t } = ctx.i18n;
  const targets = workflowTargets.filter((target) => target.id !== device.id);
  const steps = workflow ? workflowSteps(workflow) : undefined;
  const status = workflowRun?.status ?? "idle";
  const workflowSection = workflow ? `<section aria-labelledby="workflow-title">
      <h2 id="workflow-title">${escapeHtml(t("workflow.title"))}</h2>
      <div class="workflow-run" data-workflow-run data-status="${escapeHtml(status)}"><strong data-run-status>${escapeHtml(t(`workflow.run.${status}` as const))}</strong><span data-run-detail>${workflowRun?.error ? ` · ${escapeHtml(workflowRun.error)}` : workflowRun?.currentNodeId && !steps ? ` · ${escapeHtml(workflowRun.currentNodeId)}` : ""}</span></div>
      ${steps && canEditWorkflow ? `${renderStepsEditor(ctx, workflow, steps, targets, workflowRun?.currentNodeId)}
      <details class="workflow-advanced"><summary>${escapeHtml(t("workflow.stateMachine"))}</summary><p class="muted small">${escapeHtml(t("workflow.stateMachineNote"))}</p>${renderWorkflowEditor(workflow, targets, canEditWorkflow, t)}</details>`
        : `${renderWorkflowGraph(workflow)}${renderWorkflowEditor(workflow, targets, canEditWorkflow, t)}`}
    </section>` : "";
  const node = deviceNode(device.id);
  return renderPage({
    ctx,
    title: device.name,
    nav: "buttons",
    wide: Boolean(workflow),
    css: workflow ? WORKFLOW_CSS : "",
    mainAttributes: workflow ? `data-button-page data-device-id="${escapeHtml(device.id)}"` : "",
    body: `${renderDeviceHead(ctx, device, "controls")}
      ${htElement(ctx, "ht-button", node)}${workflowSection}`,
    script: workflow ? WORKFLOW_SCRIPT : "",
    messages: ["button.", "state.", "summary.", ...(workflow ? ["workflow."] : [])],
    nodes: [node],
  });
}

export function renderWorkflowGraphForTest(workflow: WorkflowDefinition): string { return renderWorkflowGraph(workflow); }
