import { expect, test } from "bun:test";
import { buttonSchema } from "../schemas";
import type { RegisteredDevice } from "../site";
import { emptyWorkflow } from "../workflows/definition";
import { renderButtonPage } from "./button-page";
import { testPageContext } from "./test-context";
const device: RegisteredDevice = { id: "routine", name: "Routine", kind: "button", model: "workflow-button", modelTitle: "Workflow Button", capabilities: ["button"], host: "", page: "/buttons/routine", schemaId: buttonSchema.$id, enabled: true };
test("plain buttons retain their state-driven control", () => {
  const html = renderButtonPage({ ctx: testPageContext(), device });
  expect(html).toContain('<ht-button node="device/routine">'); expect(html).not.toContain('id="workflow-editor"');
});
test("mounts an independently bundled, nonce-authorized graph editor with portable definition", () => {
  const workflow = emptyWorkflow("Example"); workflow.description = '</script><script>alert("x")</script>';
  const html = renderButtonPage({ ctx: testPageContext(), device, workflow, canEditWorkflow: true });
  expect(html).toContain('id="workflow-editor"'); expect(html).toContain('src="/ui/dev/workflow-editor.js"');
  expect(html).toContain('nonce="test-nonce"'); expect(html).toContain('"schemaVersion":1');
  expect(html).not.toContain('</script><script>alert'); expect(html).toContain('\\u003c/script>');
});
