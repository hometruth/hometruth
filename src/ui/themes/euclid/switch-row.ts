/**
 * Euclid's `<ht-switch-row>`: one switch in a list — the state word (only for
 * a phase no button can say, e.g. Mixed) in tabular figures, and small
 * On / Off / Toggle buttons with no primary (a list has no one action). No
 * mark, no detail or gap line, and no Refresh: the list is observed at the
 * glance tier, and status lives entirely on the buttons' `data-state` —
 * active | inactive | unknown | checking | updating | failure — never as a
 * word or a dot. A failed command's sentence sits in the failing button's
 * `title`, for a hover or a screen reader, not as standing text.
 */
import { sheet, template, vocabularySheet } from "../../browser/dom.ts";
import { HtBinarySwitch } from "../../browser/kinds/switch.ts";

const TEMPLATE = template(`
  <span class="num" part="value"></span>
  <span part="actions">
    <button type="button" class="btn btn-small" data-action="turnOn" part="action turn-on" hidden></button>
    <button type="button" class="btn btn-small" data-action="turnOff" part="action turn-off" hidden></button>
    <button type="button" class="btn btn-small" data-action="toggle" part="action toggle" hidden></button>
  </span>
`);

const STYLES = sheet(`
  :host { display: inline-flex; align-items: center; gap: var(--s3); }
  [part~="value"] { min-inline-size: 4ch; text-align: end; color: var(--fg-2); }
  [part~="actions"] { display: inline-flex; gap: var(--s2); }
`);

export class EuclidSwitchRow extends HtBinarySwitch {
  constructor() {
    super([vocabularySheet(), STYLES], TEMPLATE, "glance");
  }
}
