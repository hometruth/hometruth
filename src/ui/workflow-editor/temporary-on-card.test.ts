import { expect, test } from "bun:test";
import type { WorkflowTarget } from "../../workflows/catalog";
import { compileTemporaryOnWorkflow, recognizeTemporaryOnWorkflow, timedSwitchTargets } from "../../workflows/temporary-on";
import { durationFields, durationMilliseconds, renderTemporaryOnCard } from "./temporary-on-card";

const target: WorkflowTarget = { id: "technical-lamp-key", name: "Example lamp", statePaths: ["/capabilities/binarySwitch/state/value"],
  operations: ["binarySwitch.turnOn", "binarySwitch.turnOff"].map(id => ({ id, label: id, inputSchema: { type: "object" } })) };
function card(onlyIfOff = true, canEdit = true, chosen = target) {
  const workflow = compileTemporaryOnWorkflow({ name: "Example timer", target: chosen, durationMs: 300000, onlyIfOff });
  const recipe = recognizeTemporaryOnWorkflow(workflow, [chosen])!;
  return renderTemporaryOnCard(recipe, timedSwitchTargets([chosen]), canEdit);
}

test("recipe duration fields round trip useful time units and reject invalid or excessive waits", () => {
  for (const duration of [1, 1500, 300000, 3600000, 86340000]) {
    const fields = durationFields(duration);
    expect(durationMilliseconds(String(fields.amount), fields.unit)).toBe(duration);
  }
  expect(durationFields(300000)).toEqual({ amount: 5, unit: "minutes" });
  for (const [amount, unit] of [["", "minutes"], ["0", "minutes"], ["-1", "seconds"], ["NaN", "hours"], ["24", "hours"], ["5", "days"]]) {
    expect(() => durationMilliseconds(amount!, unit!)).toThrow();
  }
});

test("the recognized recipe explains each branch and its timer limits using device names", () => {
  const html = card(), text = html.replace(/<[^>]*>/g, " ");
  expect(html).toContain('data-recipe="onlyIfOff" type="checkbox" checked');
  expect(html).toContain('value="5"');
  expect(html).toContain('value="minutes" selected');
  for (const expected of ["Example lamp", "Leave on if already on", "wait 5 minutes", "No commands are sent", "Stop without switching", "original off time", "configuration reload cancels", "Saving does not operate"]) expect(text).toContain(expected);
  for (const hidden of [target.id, "binarySwitch.turnOn", "/capabilities/", "JSON"]) expect(text).not.toContain(hidden);
});

test("unconditional mode states that an already-on device will be turned off", () => {
  const html = card(false);
  expect(html).not.toContain('type="checkbox" checked');
  expect(html).toContain("then turn off—even if it was already on");
  expect(html).not.toContain("No commands are sent");
});

test("read-only cards disable every setting and escape device data", () => {
  const html = card(true, false, { ...target, id: 'example" autofocus', name: '<img src=x onerror="bad()">' });
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;img");
  expect(html).toContain("example&quot; autofocus");
  const fields = [...html.matchAll(/<(?:input|select)\b[^>]*>/g)];
  expect(fields).toHaveLength(4);
  for (const [field] of fields) expect(field).toContain("disabled");
});
