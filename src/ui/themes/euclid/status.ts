/**
 * Euclid's `<ht-status>`: a list row's status — what the object carries (On,
 * 45 % · 2700 K, a reading preview…), nothing else. No dot, no availability
 * word: this row has no button of its own to carry status, so the page
 * recolours the row's own name instead (see the runtime's `ht:frame`
 * listener in `shell.ts`), keyed off `data-availability` on the host.
 */
import { sheet, template, vocabularySheet } from "../../browser/dom.ts";
import { HtStatus } from "../../browser/kinds/status.ts";

const TEMPLATE = template(`
  <span class="status" part="state">
    <span part="summary" hidden></span>
  </span>
`);

const STYLES = sheet(`
  :host {
    display: inline-flex;
    align-items: center;
    --_summary: var(--ht-status-summary, var(--fg-2));
  }
  [part~="summary"] { color: var(--_summary); }
`);

export class EuclidStatus extends HtStatus {
  constructor() {
    super([vocabularySheet(), STYLES], TEMPLATE, "glance");
  }
}
