/**
 * Euclid's `<ht-switch>`: a device page's state word — shown only for a
 * phase no button can say (Mixed, "No longer configured…") — the reading
 * detail, the group's gap sentence, and the four power actions in a bar.
 * Every button's `data-state` (active | inactive | unknown | checking |
 * updating | failure, from the shared vocabulary) is the only status this
 * carries; there is no dot and no "Turning on…"/"Checking…" text anywhere.
 * The template is structure only; `HtBinarySwitch.render()` writes every
 * word from the catalog. Theme character cannot reach into a shadow root, so
 * what a theme may retune is read here from `--ht-switch-*` custom
 * properties with token fallbacks (Swiss sets the value's weight, tracking,
 * and size from its tokens).
 */
import { sheet, template, vocabularySheet } from "../../browser/dom.ts";
import { HtBinarySwitch } from "../../browser/kinds/switch.ts";

const TEMPLATE = template(`
  <div class="state" part="state" aria-live="polite">
    <span class="state-value" part="value" hidden></span>
    <span class="state-detail" part="detail" hidden></span>
  </div>
  <p class="note" part="gaps" hidden></p>
  <div class="bar" part="actions">
    <button type="button" class="btn" data-action="turnOn" part="action turn-on" hidden></button>
    <button type="button" class="btn" data-action="turnOff" part="action turn-off" hidden></button>
    <button type="button" class="btn" data-action="toggle" part="action toggle" hidden></button>
    <button type="button" class="btn" data-action="getState" part="action get-state" hidden></button>
  </div>
`);

const STYLES = sheet(`
  :host {
    display: block;
    /* The theme contract: each hook a theme may set on the page, falling back to the vocabulary's token. */
    --_rule: var(--ht-switch-rule, var(--rule));
    --_rule-w: var(--ht-switch-rule-w, var(--rule-w));
    --_value-size: var(--ht-switch-value-size, 1.75rem);
    --_value-weight: var(--ht-switch-value-weight, 400);
    --_value-tracking: var(--ht-switch-value-tracking, 0);
    --_mixed: var(--ht-switch-mixed, var(--warn));
    --_offline: var(--ht-switch-offline, var(--bad));
  }
  [part~="state"] { border-block: var(--_rule-w) solid var(--_rule); }
  [part~="value"] { font-size: var(--_value-size); font-weight: var(--_value-weight); letter-spacing: var(--_value-tracking); }
  [part~="state"][data-phase="mixed"] [part~="value"] { color: var(--_mixed); }
  [part~="state"][data-phase="offline"] [part~="value"], [part~="state"][data-phase="gone"] [part~="value"] { color: var(--_offline); }
  [part~="gaps"] { color: var(--bad); margin-block: var(--s3) 0; }
`);

export class EuclidSwitch extends HtBinarySwitch {
  constructor() {
    super([vocabularySheet(), STYLES], TEMPLATE, "live");
  }
}
