/**
 * Euclid's `<ht-button>`: the state word (shown only for a phase the Press
 * button can't say — Offline, "No longer configured…"), the reading detail,
 * Press as the page's one accent carrying `data-state` (checking | unknown |
 * updating | failure — a press has no active/inactive side), and the hold
 * field that appears only when the document bounds a duration. No dot and no
 * "Pressing…"/"Pressed" text: the button's own state is the whole of it. The
 * hold label is the one static word the template needs, so `render()` writes
 * it from the catalog like everything else.
 */
import { sheet, template, vocabularySheet } from "../../browser/dom.ts";
import { HtButton } from "../../browser/kinds/button.ts";

const TEMPLATE = template(`
  <div class="state" part="state" aria-live="polite">
    <span class="state-value" part="value" hidden></span>
    <span class="state-detail" part="detail" hidden></span>
  </div>
  <div class="bar" part="actions">
    <button type="button" class="btn btn-primary" data-action="press" part="action press" hidden></button>
  </div>
  <label class="field" part="hold-field" hidden>
    <span part="hold-label"></span>
    <input class="num" part="hold" type="number" min="0" step="0.1" value="0" inputmode="decimal">
  </label>
`);

const STYLES = sheet(`
  :host {
    display: block;
    --_rule: var(--ht-button-rule, var(--ht-switch-rule, var(--rule)));
    --_rule-w: var(--ht-button-rule-w, var(--ht-switch-rule-w, var(--rule-w)));
    /* One typographic role, the state value, shared with the switch unless a theme sets the button's own. */
    --_value-size: var(--ht-button-value-size, var(--ht-switch-value-size, 1.75rem));
    --_value-weight: var(--ht-button-value-weight, var(--ht-switch-value-weight, 400));
    --_value-tracking: var(--ht-button-value-tracking, var(--ht-switch-value-tracking, 0));
    --_offline: var(--ht-button-offline, var(--ht-switch-offline, var(--bad)));
  }
  [part~="state"] { border-block: var(--_rule-w) solid var(--_rule); }
  [part~="value"] { font-size: var(--_value-size); font-weight: var(--_value-weight); letter-spacing: var(--_value-tracking); }
  [part~="state"][data-phase="offline"] [part~="value"], [part~="state"][data-phase="gone"] [part~="value"] { color: var(--_offline); }
  [part~="hold"] { inline-size: 8rem; text-align: end; }
`);

export class EuclidButton extends HtButton {
  constructor() {
    super([vocabularySheet(), STYLES], TEMPLATE, "live");
  }

  protected override render(): void {
    super.render();
    const label = this.partNamed("hold-label");
    if (label) label.textContent = this.t("button.hold");
  }
}
