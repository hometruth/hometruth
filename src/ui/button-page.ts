import type { RegisteredDevice } from "../site";
import { deviceNode } from "../state/protocol";
import type { WorkflowDefinition } from "../workflows/definition";
import type { WorkflowRunView } from "../workflows/runner";
import type { WorkflowTarget } from "../workflows/catalog";
import { workflowSchema } from "../workflows/schema";
import { escapeHtml, htElement, renderDeviceHead, renderPage, type PageContext } from "./shell";
import { WORKFLOW_CSS } from "./workflow-editor/styles";

export interface ButtonPageOptions {
  ctx: PageContext; device: RegisteredDevice; workflow?: WorkflowDefinition;
  workflowTargets?: readonly WorkflowTarget[]; workflowRun?: WorkflowRunView; canEditWorkflow?: boolean;
}
export const WORKFLOW_API = { document: "/api/buttons/:id/workflow", save: "/api/buttons/:id/workflow", preview: "/api/buttons/:id/workflow/preview", cancel: "/api/buttons/:id/workflow/cancel" } as const;
export function renderButtonPage({ ctx, device, workflow, workflowTargets = [], workflowRun, canEditWorkflow = false }: ButtonPageOptions): string {
  const node = deviceNode(device.id);
  const bootstrap = { id: device.id, workflow, targets: workflowTargets, run: workflowRun, canEdit: canEditWorkflow, schema: workflowSchema, nonce: ctx.nonce };
  const data = JSON.stringify(bootstrap).replace(/</g, "\\u003c");
  return renderPage({ ctx, title: device.name, nav: "buttons", wide: Boolean(workflow), css: workflow ? WORKFLOW_CSS : "",
    body: `${renderDeviceHead(ctx, device, "controls")}
      ${workflow ? `<div class="wf-runbar"><div><span class="wf-eyebrow">Saved workflow</span><strong data-workflow-run>${escapeHtml(workflowRun?.status ?? "idle")}</strong><span class="muted small" data-run-detail></span></div><div class="bar">${htElement(ctx, "ht-button", node)}<button class="btn" id="wf-cancel" type="button" hidden>Cancel run</button></div></div>
      <section id="workflow-editor" aria-label="Workflow editor"><p>Loading workflow graph…</p></section>
      <script type="application/json" id="workflow-data" nonce="${escapeHtml(ctx.nonce)}">${data}</script>
      <script type="module" nonce="${escapeHtml(ctx.nonce)}" src="/ui/${encodeURIComponent(ctx.assetVersion)}/workflow-editor.js"></script>` : htElement(ctx, "ht-button", node)}`,
    messages: ["button.", "state.", "summary."], nodes: [node],
  });
}
