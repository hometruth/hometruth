import type { recognizeTemporaryOnWorkflow, timedSwitchTargets } from "../../workflows/temporary-on";
import { MAX_TEMPORARY_ON_DURATION_MS } from "../../workflows/temporary-on";

type Recipe = NonNullable<ReturnType<typeof recognizeTemporaryOnWorkflow>>;
type Target = ReturnType<typeof timedSwitchTargets>[number];
export type DurationUnit = "seconds" | "minutes" | "hours";
const units = { seconds: 1000, minutes: 60000, hours: 3600000 };
const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);

export function durationFields(durationMs: number): { amount: number; unit: DurationUnit } {
  const unit = durationMs % units.hours === 0 ? "hours" : durationMs % units.minutes === 0 ? "minutes" : "seconds";
  return { amount: durationMs / units[unit], unit };
}

export function durationMilliseconds(amount: string, unit: string): number {
  const value = Number(amount), multiplier = units[unit as DurationUnit];
  const milliseconds = value * multiplier;
  if (!amount.trim() || !Number.isFinite(milliseconds) || milliseconds < 1 || !Number.isSafeInteger(milliseconds)) {
    throw new Error("Enter a duration greater than zero.");
  }
  if (milliseconds > MAX_TEMPORARY_ON_DURATION_MS) throw new Error("Choose a duration of 23 hours and 59 minutes or less.");
  return milliseconds;
}

export function renderTemporaryOnCard(recipe: Recipe, targets: readonly Target[], canEdit: boolean): string {
  const { amount, unit } = durationFields(recipe.durationMs);
  const duration = `${amount} ${amount === 1 ? unit.slice(0, -1) : unit}`;
  const disabled = canEdit ? "" : "disabled";
  return `<header class="wf-recipe-heading"><div><span class="wf-eyebrow">Recipe</span><h3>Turn on temporarily</h3></div><button type="button" class="btn" data-command="show-advanced">Edit individual steps</button></header>
    <div class="wf-recipe-fields"><label>Device<select data-recipe="target" ${disabled}>${targets.map(target => `<option value="${escape(target.id)}"${target.id === recipe.target.id ? " selected" : ""}>${escape(target.name)}</option>`).join("")}</select></label>
    <fieldset class="wf-recipe-duration"><legend>Keep on for</legend><input data-recipe="duration" type="number" min="0.001" step="any" value="${amount}" aria-label="Duration" ${disabled}><select data-recipe="unit" aria-label="Duration unit" ${disabled}>${Object.keys(units).map(value => `<option value="${value}"${value === unit ? " selected" : ""}>${value}</option>`).join("")}</select></fieldset></div>
    <label class="wf-recipe-check"><input data-recipe="onlyIfOff" type="checkbox"${recipe.onlyIfOff ? " checked" : ""} ${disabled}><span>Leave on if already on</span></label>
    <div class="wf-recipe-explanation" aria-live="polite">${recipe.onlyIfOff
      ? `<p><strong>If off:</strong> Turn on, wait ${duration}, then turn off.</p><p><strong>If already on:</strong> Leave it on. No commands are sent.</p><p><strong>If its state is unavailable:</strong> Stop without switching it.</p>`
      : `<p>Turn on, wait ${duration}, then turn off—even if it was already on.</p>`}</div>
    <p class="wf-recipe-note">Another press while waiting is ignored. The original off time stays the same.</p>
    <p class="wf-recipe-note">HomeTruth must stay running during the wait. A restart or configuration reload cancels the timer.</p>
    <p class="wf-recipe-note">Save workflow to keep this rule. Saving does not operate the device.</p>`;
}
