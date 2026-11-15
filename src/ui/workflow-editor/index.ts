import { Graph, Config, type Node as CanvasNode } from "@antv/x6";
import { content as x6Css } from "@antv/x6/es/style/raw";
import ELK from "elkjs/lib/elk.bundled.js";
import { childGraphs, emptyGraph, OUTLETS, OUTLET_LABELS, transitions, walkNodes, type Json, type WorkflowDefinition, type WorkflowNode, type WorkflowPresentation } from "../../workflows/definition";
import { connect, defaultInput, EditorHistory, graphAt, insertNode, NODE_TITLES, type EditorSnapshot } from "../../workflows/editor-model";
import type { WorkflowTarget } from "../../workflows/catalog";
import type { WorkflowRunView } from "../../workflows/runner";
import { compileTemporaryOnWorkflow, recognizeTemporaryOnWorkflow, timedSwitchTargets } from "../../workflows/temporary-on";
import { durationMilliseconds, renderTemporaryOnCard } from "./temporary-on-card";

type Bootstrap = { id: string; workflow: WorkflowDefinition; targets: WorkflowTarget[]; run: WorkflowRunView; canEdit: boolean; schema: unknown; nonce: string };
const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const option = (value: string, label: string, current: string) => `<option value="${escape(value)}"${value === current ? " selected" : ""}>${escape(label)}</option>`;
const button = (action: string, label: string, extra = "") => `<button type="button" class="btn ${extra.match(/class="([^"]*)"/)?.[1] ?? ""}" data-command="${action}" ${extra.replace(/class="[^"]*"/, "")}>${label}</button>`;
const colors: Record<WorkflowNode["type"], string> = { action: "#346689", delay: "#82703e", condition: "#976226", parallel: "#756098", repeat: "#756098", waitFor: "#82703e", end: "#387564" };
async function start() {
  const bootstrap: Bootstrap = JSON.parse(document.getElementById("workflow-data")!.textContent!);
  const root = document.getElementById("workflow-editor")!;
  const disabled = bootstrap.canEdit ? "" : "disabled";
  const api = `/api/buttons/${encodeURIComponent(bootstrap.id)}/workflow`;
  const request = (url: string, init?: RequestInit): Promise<any> => (window as unknown as { ht: { request: typeof request } }).ht.request(url, init);
  const post = (suffix: string, value: unknown) => request(api + suffix, { method: "POST", body: JSON.stringify(value) });
  let saved = JSON.stringify(bootstrap.workflow);
  let workflow = structuredClone(bootstrap.workflow);
  let presentation: WorkflowPresentation = { positions: {} };
  let scope = "root"; let selected = workflow.graph.entry;
  let run = bootstrap.run; let rendering = false; let busy = false;
  const history = new EditorHistory(); const elk = new ELK();
  const storageKey = `hometruth.workflow.v1.${bootstrap.id}`;
  const snapshot = (): EditorSnapshot => ({ workflow, presentation });
  const currentGraph = () => graphAt(workflow, scope);
  const currentNode = () => currentGraph().nodes.find(n => n.id === selected);
  const recipeTargets = timedSwitchTargets(bootstrap.targets);
  root.innerHTML = `<div class="wf-header"><div><span class="wf-eyebrow">Workflow studio</span><h2>Make the flow clear.</h2></div><div class="wf-toolbar">${button("undo", "Undo", 'id="wf-undo"')}${button("redo", "Redo", 'id="wf-redo"')}${button("validate", "Validate")}${button("save", "Save workflow", `id="wf-save" class="btn-primary" ${disabled}`)}</div></div>
    <div class="wf-recipe-start"><div><span class="wf-eyebrow">Start with a recipe</span>${button("temporary-on", "Turn on temporarily", `class="wf-recipe-button" ${disabled} ${recipeTargets.length ? "" : "disabled"}`)}${recipeTargets.length ? "" : '<p class="small muted">Add a device with a readable on/off state to use this recipe.</p>'}</div><span class="wf-status" id="wf-save-state"></span></div>
    <section id="wf-recipe" class="wf-recipe" aria-label="Temporary on rule" hidden></section>
    <details id="wf-advanced" class="wf-advanced"><summary>Advanced flow editor</summary><div class="wf-advanced-toolbar">${button("ai", "Describe with AI", disabled)}${button("export", "Export JSON")}</div>
    <div class="wf-palette"><span class="wf-eyebrow">Add a step</span>${Object.entries(NODE_TITLES).map(([type, title]) => button(`add:${type}`, `＋ ${title}`, disabled)).join("")}</div>
    <nav class="wf-breadcrumbs" aria-label="Workflow branches" id="wf-breadcrumbs"></nav>
    <div class="wf-workspace"><div class="wf-canvas-wrap"><div class="wf-canvas" id="wf-canvas" aria-label="Workflow graph. Use the step outline below for keyboard editing." role="img"></div><div class="wf-canvas-tools">${button("zoom-out", "−", 'aria-label="Zoom out"')}${button("zoom-in", "+", 'aria-label="Zoom in"')}${button("fit", "Fit")}${button("layout", "Arrange")}</div></div><aside class="wf-inspector" id="wf-inspector" aria-label="Step inspector"></aside></div>
    <div class="wf-footer"><span>Drag steps to arrange. Drag an output dot to connect. Select a step to edit.</span><div class="wf-legend"><span>Normal path</span><span>Error / unknown</span></div></div>
    <details><summary>Step outline &amp; keyboard editing</summary><div id="wf-outline" class="wf-outline"></div></details>
    <details><summary>Workflow settings</summary><div class="wf-settings" id="wf-settings"></div></details>
    <details><summary>Simulate without devices</summary><p class="small muted">Actions are recorded and waits skipped. Choose one assumption for every decision. This tests a possible path, not device behavior.</p><div class="bar"><select id="wf-assumption" aria-label="Predicate assumption"><option value="true">All decisions: true</option><option value="false">All decisions: false</option><option value="unknown">All decisions: unknown</option></select>${button("simulate", "Simulate")}</div></details>
    </details><div id="wf-feedback" class="wf-feedback" role="status" aria-live="polite"></div>
    <dialog id="wf-ai" class="wf-dialog"><header><h2>Describe a workflow</h2>${button("close-ai", "Close")}</header><p>Describe what should happen. Copy the authoring prompt to your AI agent, then paste its JSON draft here. The prompt includes the schema, available devices, and this workflow.</p><label>Your description<textarea id="wf-description" placeholder="When it’s time for dinner, flash the two room lights red and yellow twice, then play a dinner bell at 50% volume."></textarea></label><div class="bar">${button("copy-prompt", "Copy AI prompt")}${button("show-prompt", "View prompt")}</div><textarea id="wf-prompt" class="wf-json" aria-label="AI authoring prompt" readonly hidden></textarea><hr><label>AI workflow draft (JSON)<textarea id="wf-import" class="wf-json" spellcheck="false" placeholder='{"schemaVersion": 1, …}'></textarea></label><div class="bar">${button("import", "Review draft on canvas", disabled)}</div><p id="wf-ai-feedback" role="status">Importing, validation, and simulation never operate devices. Saving changes what the button will run on its next press.</p></dialog>`;
  const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
  el<HTMLDetailsElement>("wf-advanced").open = !recognizeTemporaryOnWorkflow(workflow, bootstrap.targets);
  const feedback = (message: string, error = false) => { el("wf-feedback").textContent = message; el("wf-feedback").dataset.error = String(error); };
  const checkpoint = () => history.push(snapshot());
  function recipeDraft(): WorkflowDefinition {
    const card = el("wf-recipe");
    const target = recipeTargets.find(target => target.id === card.querySelector<HTMLSelectElement>('[data-recipe="target"]')!.value);
    if (!target) throw new Error("Choose a device with a readable on/off state.");
    const amount = card.querySelector<HTMLInputElement>('[data-recipe="duration"]')!.value;
    const unit = card.querySelector<HTMLSelectElement>('[data-recipe="unit"]')!.value;
    const onlyIfOff = card.querySelector<HTMLInputElement>('[data-recipe="onlyIfOff"]')!.checked;
    return compileTemporaryOnWorkflow({ name: workflow.name, target, durationMs: durationMilliseconds(amount, unit), onlyIfOff });
  }
  function stash() {
    try { localStorage.setItem(storageKey, JSON.stringify({ base: saved, workflow, presentation })); }
    catch { feedback("Browser draft storage is unavailable. Export JSON to keep your draft.", true); }
    const dirty = JSON.stringify(workflow) !== saved;
    el("wf-save-state").textContent = dirty ? "Unsaved draft · kept in this browser" : "Saved definition";
    el("wf-save-state").dataset.dirty = String(dirty);
    el<HTMLButtonElement>("wf-undo").disabled = !history.canUndo;
    el<HTMLButtonElement>("wf-redo").disabled = !history.canRedo;
  }
  Config.autoInsertCSS = false;
  const css = document.createElement("style"); css.nonce = bootstrap.nonce; css.textContent = x6Css; document.head.append(css);
  const canvas = new Graph({ container: el("wf-canvas"), autoResize: true, grid: { visible: true, size: 20 }, background: { color: "transparent" },
    panning: true, mousewheel: { enabled: true, modifiers: ["ctrl", "meta"], minScale: .25, maxScale: 2 },
    interacting: { edgeMovable: false, arrowheadMovable: bootstrap.canEdit, nodeMovable: true },
    connecting: { allowBlank: false, allowLoop: true, allowMulti: true, allowNode: false, allowEdge: false, snap: { radius: 24 },
      router: { name: "manhattan", args: { padding: 28 } }, connector: { name: "rounded", args: { radius: 8 } },
      validateMagnet: ({ magnet }) => bootstrap.canEdit && magnet.getAttribute("port-group") === "out",
      validateConnection: ({ sourcePort, targetPort }) => bootstrap.canEdit && Boolean(sourcePort && targetPort === "in"),
      createEdge: () => canvas.createEdge({ attrs: { line: { stroke: "#346689", strokeWidth: 2, targetMarker: "block" } } }),
    },
  });
  function detail(node: WorkflowNode): string {
    if (node.type === "action") return `${bootstrap.targets.find(t => t.id === node.action.target)?.name ?? node.action.target}\n${node.action.operation}`;
    if (node.type === "delay") return `${node.durationMs / 1000} seconds`;
    if (node.type === "condition" || node.type === "waitFor") return `${bootstrap.targets.find(t => t.id === node.predicate.target)?.name ?? node.predicate.target}\n${node.predicate.path.split("/").at(-1)} ${node.predicate.operator} ${JSON.stringify(node.predicate.value)}`;
    if (node.type === "parallel") return `${node.branches.length} branches · wait for all`;
    if (node.type === "repeat") return `${node.count} times · open body to edit`;
    return node.outcome === "success" ? "Complete this branch" : "Fail this branch";
  }
  function paint() {
    rendering = true; const graph = currentGraph();
    canvas.clearCells();
    for (const [index, node] of graph.nodes.entries()) {
      const key = `${scope}/${node.id}`; const pos = presentation.positions[key] ?? { x: 40 + index * 280, y: 120 };
      const active = JSON.stringify(workflow) === saved && run?.activeNodeIds?.includes(key);
      const color = node.type === "end" && node.outcome === "failure" ? "#a34b3c" : colors[node.type];
      const short = (text: string, length = 30) => text.length > length ? `${text.slice(0, length - 1)}…` : text;
      canvas.addNode({ id: node.id, x: pos.x, y: pos.y, width: 230, height: 104, shape: "rect",
        attrs: { body: { fill: getComputedStyle(root).getPropertyValue("--panel").trim() || "#fffdf7", stroke: active ? "#d1912f" : node.id === selected ? color : "#afa99b", strokeWidth: active || node.id === selected ? 3 : 1.2, rx: 5, ry: 5 },
          label: { text: `${graph.entry === node.id ? "▶  " : ""}${NODE_TITLES[node.type].toUpperCase()}  ·  ${short(node.label || node.id, 20)}\n\n${detail(node).split("\n").map(line => short(line)).join("\n")}`, fill: getComputedStyle(root).getPropertyValue("--fg").trim() || "#252827", fontSize: 12, fontFamily: "system-ui, sans-serif", lineHeight: 17 } },
        ports: { groups: { in: { position: "left", attrs: { circle: { r: 5, magnet: true, stroke: "#a09a8d", fill: "#fffdf7" } } }, out: { position: "right", attrs: { circle: { r: 5, magnet: true, stroke: color, fill: "#fffdf7" } } } }, items: [{ id: "in", group: "in" }, ...OUTLETS[node.type].map(outlet => ({ id: outlet, group: "out", attrs: { circle: { title: OUTLET_LABELS[outlet] } } }))] },
      });
    }
    for (const node of graph.nodes) for (const edge of transitions(node)) if (graph.nodes.some(n => n.id === edge.target)) {
      const error = ["onError", "onUnknown", "onTimeout"].includes(edge.outlet);
      canvas.addEdge({ id: `@edge:${node.id}:${edge.outlet}`, source: { cell: node.id, port: edge.outlet }, target: { cell: edge.target, port: "in" }, router: { name: "manhattan", args: { padding: 28 } }, connector: { name: "rounded", args: { radius: 8 } },
        attrs: { line: { stroke: error ? "#a34b3c" : "#346689", strokeWidth: 1.6, strokeDasharray: error ? "5 4" : "", targetMarker: { name: "block", size: 7 } } }, labels: [{ position: .35, attrs: { label: { text: OUTLET_LABELS[edge.outlet], fill: error ? "#a34b3c" : "#346689", fontSize: 11 }, body: { fill: getComputedStyle(root).getPropertyValue("--bg").trim() || "#fffdf7" } } }] });
    }
    rendering = false;
    inspector(); chrome(); stash();
  }
  function chrome() {
    const recipe = recognizeTemporaryOnWorkflow(workflow, bootstrap.targets);
    const recipeCard = el("wf-recipe");
    recipeCard.hidden = !recipe;
    recipeCard.innerHTML = recipe ? renderTemporaryOnCard(recipe, recipeTargets, bootstrap.canEdit) : "";
    if (!recipe) el<HTMLDetailsElement>("wf-advanced").open = true;
    const parts = scope.split("/"); const crumbs = [{ scope: "root", name: workflow.name }];
    for (let i = 1; i < parts.length; i += 2) crumbs.push({ scope: parts.slice(0, i + 2).join("/"), name: `${parts[i]} / ${parts[i + 1]}` });
    el("wf-breadcrumbs").innerHTML = crumbs.map(c => button(`scope:${c.scope}`, escape(c.name))).join("<span>›</span>");
    el("wf-outline").innerHTML = currentGraph().nodes.map(n => button(`select:${n.id}`, `${currentGraph().entry === n.id ? "▶ " : ""}${escape(n.label || n.id)} · ${NODE_TITLES[n.type]}`, `aria-pressed="${n.id === selected}"`)).join("");
    el("wf-settings").innerHTML = `<label>Name<input data-setting="name" value="${escape(workflow.name)}" ${disabled}></label><label>When already running<select data-setting="runPolicy" ${disabled}>${option("ignoreWhileRunning", "Ignore another press", workflow.runPolicy)}${option("replaceAfterCleanup", "Cancel, clean up, then replace", workflow.runPolicy)}</select></label><label class="full">Description<textarea data-setting="description" ${disabled}>${escape(workflow.description)}</textarea></label><label>Maximum steps<input type="number" min="1" max="10000" data-setting="maxSteps" value="${workflow.limits.maxSteps}" ${disabled}></label><label>Time limit (seconds)<input type="number" min="1" max="86400" data-setting="maxDurationMs" value="${workflow.limits.maxDurationMs / 1000}" ${disabled}></label>`;
  }
  function inspector() {
    const node = currentNode(); if (!node) { el("wf-inspector").innerHTML = "Select a step to edit it."; return; }
    const input = (name: string, label: string, value: unknown, type = "text", extra = "") => `<label>${label}<input data-field="${name}" value="${escape(value)}" type="${type}" ${extra} ${disabled}></label>`;
    const targetSelect = (id: string) => `<label>Device<select data-field="target" ${disabled}>${!bootstrap.targets.some(t => t.id === id) ? option(id, `Unresolved: ${id}`, id) : ""}${bootstrap.targets.map(t => option(t.id, t.name, id)).join("")}</select></label>`;
    let fields = input("label", "Step name", node.label || "");
    if (node.type === "action") {
      const target = bootstrap.targets.find(t => t.id === node.action.target); const operation = target?.operations.find(op => op.id === node.action.operation);
      fields += targetSelect(node.action.target) + `<label>Action<select data-field="operation" ${disabled}>${!operation ? option(node.action.operation, node.action.operation, node.action.operation) : ""}${target?.operations.map(op => option(op.id, op.label, node.action.operation)).join("") ?? ""}</select></label>`;
      if (operation) for (const [name, raw] of Object.entries((operation.inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>)) {
        const value = node.action.input[name]; const label = name === "value" ? "Value" : name.replace(/([A-Z])/g, " $1").replace(/^./, c => c.toUpperCase());
        if (raw.type === "boolean") fields += `<label>${label}<select data-param="${name}" data-kind="boolean" ${disabled}>${option("true", "Yes", String(value))}${option("false", "No", String(value))}</select></label>`;
        else if (["number", "integer", "string"].includes(String(raw.type))) fields += `<label>${label}<input data-param="${name}" data-kind="${raw.type}" type="${raw.type === "string" ? "text" : "number"}" value="${escape(value ?? "")}" ${typeof raw.minimum === "number" ? `min="${raw.minimum}"` : ""} ${typeof raw.maximum === "number" ? `max="${raw.maximum}"` : ""} step="${raw.type === "integer" ? "1" : "any"}" ${disabled}></label>`;
        else fields += `<label>${label} (JSON)<textarea data-param="${name}" data-kind="json" ${disabled}>${escape(JSON.stringify(value ?? null, null, 2))}</textarea></label>`;
      }
      if (node.action.operation === "speaker.playSound") fields += `<p class="small muted">Plays on a stopped, ungrouped speaker. Restores volume and mute afterwards. The current playback URI is replaced.</p>`;
      if (node.action.operation === "light.flash") fields += `<p class="small muted">Each cycle flashes every color in order. Original light states are restored after completion or cancellation.</p>`;
    }
    if (node.type === "delay") fields += input("durationMs", "Delay (seconds)", node.durationMs / 1000, "number", 'min="0.001" step="any"');
    if (node.type === "condition" || node.type === "waitFor") {
      fields += targetSelect(node.predicate.target) + input("path", "State path (JSON Pointer)", node.predicate.path, "text", 'list="wf-state-paths"') + `<datalist id="wf-state-paths">${bootstrap.targets.find(t => t.id === node.predicate.target)?.statePaths.map(path => `<option value="${escape(path)}"></option>`).join("") ?? ""}</datalist><label>Comparison<select data-field="operator" ${disabled}>${["equals", "notEquals", "greaterThan", "lessThan"].map(op => option(op, op.replace(/([A-Z])/g, " $1"), node.predicate.operator)).join("")}</select></label><label>Compare with (JSON)<textarea data-field="predicateValue" ${disabled}>${escape(JSON.stringify(node.predicate.value))}</textarea></label>`;
      if (node.type === "waitFor") fields += input("timeoutMs", "Timeout (seconds)", node.timeoutMs / 1000, "number", 'min="0.001" step="any"');
    }
    if (node.type === "repeat") fields += input("count", "Repeat count", node.count, "number", 'min="1" max="100"');
    if (node.type === "end") fields += `<label>Outcome<select data-field="outcome" ${disabled}>${option("success", "Success", node.outcome)}${option("failure", "Failure", node.outcome)}</select></label>`;
    for (const child of childGraphs(node)) {
      fields += button(`scope:${scope}/${node.id}/${child.key}`, `Open ${child.key === "body" ? "repeat body" : child.key.replace("-", " ")} →`, 'class="wf-branch"');
      if (node.type === "parallel" && node.branches.length > 2) fields += button(`remove-branch:${child.key}`, `Remove ${child.key.replace("-", " ")}`, disabled);
    }
    if (node.type === "parallel") fields += button("add-branch", "＋ Add branch", `${disabled} ${node.branches.length >= 16 ? "disabled" : ""}`);
    if (transitions(node).length) fields += `<hr><span class="wf-eyebrow">Connections</span>${transitions(node).map(edge => `<label>${OUTLET_LABELS[edge.outlet]}<select data-outlet="${edge.outlet}" ${disabled}>${currentGraph().nodes.map(n => option(n.id, n.label || n.id, edge.target)).join("")}</select></label>`).join("")}`;
    el("wf-inspector").innerHTML = `<span class="wf-eyebrow">${NODE_TITLES[node.type]}${currentGraph().entry === node.id ? " · entry" : ""}</span><h3>${escape(node.label || node.id)}</h3>${fields}<hr><div class="bar">${button("entry", "Start here", disabled)}${button("delete", "Delete step", `${disabled} ${currentGraph().nodes.length === 1 ? "disabled" : ""}`)}</div><p class="wf-node-id">${escape(scope + "/" + node.id)}</p>`;
  }
  async function layout(record = true) {
    const graph = currentGraph(); const requestedScope = scope; const requestedWorkflow = JSON.stringify(workflow);
    const result = await elk.layout({ id: "root", layoutOptions: { "elk.algorithm": "layered", "elk.direction": "RIGHT", "elk.spacing.nodeNode": "65", "elk.layered.spacing.nodeNodeBetweenLayers": "100", "elk.edgeRouting": "ORTHOGONAL" }, children: graph.nodes.map(n => ({ id: n.id, width: 230, height: 104 })), edges: graph.nodes.flatMap(n => transitions(n).map(e => ({ id: `${n.id}:${e.outlet}`, sources: [n.id], targets: [e.target] }))) });
    if (scope !== requestedScope || JSON.stringify(workflow) !== requestedWorkflow) return;
    if (record) checkpoint();
    for (const child of result.children ?? []) presentation.positions[`${scope}/${child.id}`] = { x: child.x ?? 0, y: child.y ?? 0 };
    paint(); canvas.zoomToFit({ padding: 60, maxScale: 1 });
  }
  canvas.on("node:click", ({ node }) => { selected = node.id; paint(); });
  let dragSnapshot: EditorSnapshot | undefined;
  canvas.on("node:mousedown", () => { dragSnapshot = structuredClone(snapshot()); });
  canvas.on("node:moved", ({ node }: { node: CanvasNode }) => {
    if (rendering) return; if (dragSnapshot) history.push(dragSnapshot); dragSnapshot = undefined;
    presentation.positions[`${scope}/${node.id}`] = node.position(); stash();
  });
  canvas.on("edge:connected", ({ edge }) => {
    if (rendering) return;
    try { checkpoint(); connect(currentGraph(), edge.getSourceCellId(), edge.getSourcePortId() ?? "", edge.getTargetCellId()); paint(); }
    catch (error) { feedback(String(error), true); paint(); }
  });
  root.addEventListener("change", event => {
    const field = event.target as HTMLInputElement; if (!bootstrap.canEdit) return;
    try {
      const before = structuredClone(snapshot()); const node = currentNode();
      const setting = field.dataset.setting;
      if (field.dataset.recipe) {
        const recipe = recognizeTemporaryOnWorkflow(workflow, bootstrap.targets);
        if (!recipe) return;
        workflow = recipeDraft();
        scope = "root"; selected = workflow.graph.entry;
      } else if (setting) {
        if (setting === "name" || setting === "description") workflow[setting] = field.value;
        else if (setting === "runPolicy") workflow.runPolicy = field.value as WorkflowDefinition["runPolicy"];
        else if (setting === "maxSteps") workflow.limits.maxSteps = Number(field.value);
        else workflow.limits.maxDurationMs = Math.round(Number(field.value) * 1000);
      } else if (node && field.dataset.outlet) connect(currentGraph(), node.id, field.dataset.outlet, field.value);
      else if (node?.type === "action" && field.dataset.param) {
        const kind = field.dataset.kind;
        node.action.input[field.dataset.param] = kind === "json" ? JSON.parse(field.value) : kind === "boolean" ? field.value === "true" : kind === "number" || kind === "integer" ? Number(field.value) : field.value;
      } else if (node && field.dataset.field) {
        const name = field.dataset.field;
        if (name === "label") { if (field.value) node.label = field.value; else delete node.label; }
        else if (node.type === "action") {
          if (name === "target") node.action.target = field.value;
          const target = bootstrap.targets.find(t => t.id === node.action.target);
          const operation = name === "operation" ? target?.operations.find(op => op.id === field.value) : target?.operations[0];
          if (operation) { node.action.operation = operation.id; node.action.input = defaultInput(operation.inputSchema); }
        } else if (node.type === "condition" || node.type === "waitFor") {
          if (name === "target" || name === "path") node.predicate[name] = field.value;
          else if (name === "operator") node.predicate.operator = field.value as typeof node.predicate.operator;
          else if (name === "predicateValue") node.predicate.value = JSON.parse(field.value);
          else if (name === "timeoutMs" && node.type === "waitFor") node.timeoutMs = Math.round(Number(field.value) * 1000);
        } else if (name === "durationMs" && node.type === "delay") node.durationMs = Math.round(Number(field.value) * 1000);
        else if (name === "count" && node.type === "repeat") node.count = Number(field.value);
        else if (name === "outcome" && node.type === "end") node.outcome = field.value as "success" | "failure";
      } else return;
      history.push(before); paint(); feedback("");
    } catch (error) { feedback(`Check this value: ${error instanceof Error ? error.message : error}`, true); }
  });
  function authoringPrompt() {
    return `Create a HomeTruth workflow draft from the description below. Return ONLY a JSON document matching the supplied JSON Schema. This is a draft for review; never call any device, execution, save, or control API. Use only exact target IDs and operations in the catalogue. Validate action input against its operation inputSchema. Do not invent missing devices, media URLs, or capabilities: ask a clarification question instead. Spell out unresolved timing assumptions in description. Transitions must reference nodes in the same graph; all nodes must be reachable and have a path to an end. Use explicit onError/onUnknown branches ending in failure. Parallel waits for all branches, and repeat has a nested body. There are at most 200 nodes, 8 nesting levels. No X6, layout, credentials, runtime state, JavaScript, expressions, or confirmation flags in JSON. Keep the existing workflow if modifying it, changing only requested behavior.\n\nUSER DESCRIPTION:\n${el<HTMLTextAreaElement>("wf-description").value}\n\nSCHEMA:\n${JSON.stringify(bootstrap.schema)}\n\nDEVICE AND OPERATION CATALOGUE:\n${JSON.stringify(bootstrap.targets)}\n\nCURRENT WORKFLOW:\n${JSON.stringify(workflow)}`;
  }
  root.addEventListener("click", event => {
    const target = (event.target as Element).closest<HTMLButtonElement>("button[data-command]"); if (!target || target.disabled) return;
    void command(target.dataset.command!).catch(error => { const message = error instanceof Error ? error.message : String(error); feedback(message, true); el("wf-ai-feedback").textContent = message; });
  });
  async function command(command: string) {
    const [action, ...args] = command.split(":"); const arg = args.join(":");
    if (action === "show-advanced") { el<HTMLDetailsElement>("wf-advanced").open = true; await layout(false); el("wf-advanced").scrollIntoView({ block: "start", behavior: "smooth" }); return; }
    if (action === "select") { selected = arg; paint(); return; }
    if (action === "scope") { scope = arg; selected = currentGraph().entry; paint(); if (currentGraph().nodes.some(n => !presentation.positions[`${scope}/${n.id}`])) await layout(false); else canvas.zoomToFit({ padding: 60, maxScale: 1 }); return; }
    if (action === "fit") { canvas.zoomToFit({ padding: 60, maxScale: 1 }); return; }
    if (action === "zoom-in" || action === "zoom-out") { canvas.zoom(action === "zoom-in" ? .15 : -.15); return; }
    if (action === "layout") { await layout(); return; }
    if (action === "close-ai") { el<HTMLDialogElement>("wf-ai").close(); return; }
    if (action === "ai") { el<HTMLTextAreaElement>("wf-description").value = workflow.description; el<HTMLDialogElement>("wf-ai").showModal(); return; }
    if (action === "copy-prompt" || action === "show-prompt") {
      const prompt = authoringPrompt(); const area = el<HTMLTextAreaElement>("wf-prompt"); area.value = prompt; area.hidden = false;
      if (action === "copy-prompt") { try { await navigator.clipboard.writeText(prompt); el("wf-ai-feedback").textContent = "Prompt copied. Paste it into your AI agent, then bring the JSON draft back here."; } catch { area.focus(); area.select(); el("wf-ai-feedback").textContent = "Select and copy the prompt above."; } } return;
    }
    if (action === "export") {
      const link = document.createElement("a"); const url = URL.createObjectURL(new Blob([JSON.stringify(workflow, null, 2) + "\n"], { type: "application/json" }));
      link.href = url; link.download = `${bootstrap.id}.workflow.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); return;
    }
    if (action === "validate" || action === "simulate") {
      const result = await post("/preview", { workflow, ...(action === "simulate" ? { assumption: el<HTMLSelectElement>("wf-assumption").value } : {}) });
      if (result.simulation) {
        const sim = result.simulation; const trace = sim.run.trace.map((entry: { node: string; phase: string }) => `${entry.phase === "entered" ? "→" : entry.phase === "failed" ? "!" : "✓"} ${entry.node}`).join("\n");
        feedback(`Simulation: ${sim.run.status} · ${sim.run.steps} steps. No device calls.\n${sim.run.error ?? ""}\n${trace}\n\nRecorded actions:\n${sim.actions.join("\n")}`, sim.run.status !== "complete");
      } else feedback("Valid workflow. All connections and action inputs check out. Nothing has run."); return;
    }
    if (!bootstrap.canEdit && action !== "undo" && action !== "redo") return;
    if (action === "temporary-on") {
      const recognized = recognizeTemporaryOnWorkflow(workflow, bootstrap.targets);
      if (!recognized) {
        const existingTarget = walkNodes(workflow.graph).find(({ node }) => node.type === "action" && recipeTargets.some(target => target.id === node.action.target))?.node;
        const target = recipeTargets.find(target => existingTarget?.type === "action" && target.id === existingTarget.action.target) ?? recipeTargets[0];
        if (!target) throw new Error("Add a device with a readable on/off state to use this recipe.");
        checkpoint(); workflow = compileTemporaryOnWorkflow({ name: workflow.name, target, durationMs: 300000, onlyIfOff: true });
        presentation = { positions: {} }; scope = "root"; selected = workflow.graph.entry;
      }
      el<HTMLDetailsElement>("wf-advanced").open = false; paint();
      feedback(recognized ? "Edit the device and duration, then save the workflow." : "Recipe draft ready. Choose the device and duration, then save. Undo restores your previous flow.");
      el("wf-recipe").querySelector<HTMLSelectElement>("select")?.focus(); return;
    }
    if (action === "save" || action === "import") {
      if (busy) return; busy = true;
      try {
        if (action === "import") {
          const draft = JSON.parse(el<HTMLTextAreaElement>("wf-import").value.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
          await post("/preview", { workflow: draft }); checkpoint(); workflow = draft; scope = "root"; selected = workflow.graph.entry; presentation = { positions: {} };
          el<HTMLDialogElement>("wf-ai").close(); await layout(false); feedback("Draft imported for review. Inspect the graph and simulate its paths before saving.");
        } else {
          // Recheck visible recipe fields so an invalid, unblurred edit cannot save the prior duration.
          if (!el("wf-recipe").hidden) {
            const draft = recipeDraft();
            if (JSON.stringify(draft) !== JSON.stringify(workflow)) { checkpoint(); workflow = draft; }
          }
          const submitted = structuredClone(workflow);
          await request(api, { method: "PUT", body: JSON.stringify({ workflow: submitted }) }); saved = JSON.stringify(submitted); stash();
          feedback("Workflow saved. It will run when the button is pressed. Nothing has run now.");
        }
      } finally { busy = false; } return;
    }
    if (action === "undo" || action === "redo") {
      const restored = action === "undo" ? history.undo(snapshot()) : history.redo(snapshot()); if (restored) { workflow = restored.workflow; presentation = restored.presentation; try { currentGraph(); } catch { scope = "root"; } selected = currentGraph().entry; paint(); } return;
    }
    if (action === "add") { checkpoint(); selected = insertNode(currentGraph(), arg as WorkflowNode["type"], selected, bootstrap.targets).id; await layout(false); return; }
    const node = currentNode(); if (!node) return;
    if (action === "entry") { checkpoint(); currentGraph().entry = node.id; paint(); }
    if (action === "add-branch" && node.type === "parallel" && node.branches.length < 16) { checkpoint(); node.branches.push(emptyGraph()); paint(); }
    if (action === "remove-branch" && node.type === "parallel" && node.branches.length > 2) { checkpoint(); node.branches.splice(Number(arg.slice("branch-".length)) - 1, 1); paint(); }
    if (action === "delete" && currentGraph().nodes.length > 1) {
      checkpoint(); const graph = currentGraph(); const next = transitions(node).find(e => e.target !== node.id)?.target ?? graph.nodes.find(n => n !== node)!.id;
      graph.nodes = graph.nodes.filter(n => n !== node); for (const other of graph.nodes) for (const edge of transitions(other)) if (edge.target === node.id) connect(graph, other.id, edge.outlet, next);
      if (graph.entry === node.id) graph.entry = next; selected = next; paint();
    }
  }
  const cancel = document.getElementById("wf-cancel") as HTMLButtonElement;
  cancel.addEventListener("click", () => { void post("/cancel", {}).then(() => refreshRun()).catch(error => feedback(String(error), true)); });
  async function refreshRun() {
    if (document.hidden) return;
    try {
      const result = await request(api); const changed = JSON.stringify(run) !== JSON.stringify(result.run); run = result.run;
      const label = document.querySelector("[data-workflow-run]")!; label.textContent = run.status;
      document.querySelector("[data-run-detail]")!.textContent = run.error ?? (run.activeNodeIds.length ? run.activeNodeIds.join(", ") : "");
      cancel.hidden = run.status !== "running";
      if (changed) for (const node of currentGraph().nodes) {
        const active = JSON.stringify(workflow) === saved && run.activeNodeIds.includes(`${scope}/${node.id}`);
        const color = node.type === "end" && node.outcome === "failure" ? "#a34b3c" : colors[node.type];
        canvas.getCellById(node.id)?.attr({ body: { stroke: active ? "#d1912f" : node.id === selected ? color : "#afa99b", strokeWidth: active || node.id === selected ? 3 : 1.2 } });
      }
    } catch { /* Keep editor usable while the configuration reloads. */ }
  }
  // Reload a browser draft only if its base still matches the saved definition.
  try {
    const raw = localStorage.getItem(storageKey); const draft = raw ? JSON.parse(raw) : undefined;
    if (draft?.base === saved && draft.workflow) {
      // Drafts can be invalid while edited. Only accept bounded, structurally shaped documents.
      const definition = draft.workflow as WorkflowDefinition;
      if (definition.schemaVersion === 1 && definition.graph && JSON.stringify(definition).length < 250000) {
        try { await post("/preview", { workflow: definition, draft: true }); workflow = definition; selected = workflow.graph.entry; }
        catch { feedback("An unfinished draft is available below. Fix its validation errors and import it to resume.", true); el<HTMLTextAreaElement>("wf-import").value = JSON.stringify(definition, null, 2); }
      }
      if (draft.presentation?.positions && typeof draft.presentation.positions === "object") for (const [key, position] of Object.entries(draft.presentation.positions) as Array<[string, {x: number; y: number}]>) if (key.startsWith("root/") && key.length < 1600 && position && Number.isFinite(position.x) && Number.isFinite(position.y) && Math.abs(position.x) <= 100000 && Math.abs(position.y) <= 100000) presentation.positions[key] = position;
    } else if (draft?.workflow && JSON.stringify(draft.workflow) !== saved) { el<HTMLTextAreaElement>("wf-import").value = JSON.stringify(draft.workflow, null, 2); feedback("The saved workflow changed since this browser draft. The earlier draft is in the AI import panel for review."); }
  } catch { /* Storage may be unavailable; stash reports it after rendering. */ }
  el<HTMLDetailsElement>("wf-advanced").open = !recognizeTemporaryOnWorkflow(workflow, bootstrap.targets);
  paint(); if (el<HTMLDetailsElement>("wf-advanced").open) {
    if (currentGraph().nodes.some(n => !presentation.positions[`${scope}/${n.id}`])) await layout(false); else canvas.zoomToFit({ padding: 60, maxScale: 1 });
  }
  el("wf-advanced").addEventListener("toggle", () => {
    if (el<HTMLDetailsElement>("wf-advanced").open) void layout(false).catch(error => feedback(String(error), true));
  });
  const timer = setInterval(() => { void refreshRun(); }, 2500);
  window.addEventListener("pagehide", () => { clearInterval(timer); canvas.dispose(); elk.terminateWorker(); }, { once: true });
  window.addEventListener("beforeunload", event => { if (JSON.stringify(workflow) !== saved) { event.preventDefault(); } });
  root.addEventListener("keydown", event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) { event.preventDefault(); void command(event.shiftKey ? "redo" : "undo"); } });
}
void start().catch(error => { const root = document.getElementById("workflow-editor"); if (root) root.textContent = `The workflow editor could not load: ${error instanceof Error ? error.message : error}`; console.error(error); });
