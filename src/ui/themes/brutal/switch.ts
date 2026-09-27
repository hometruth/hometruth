/**
 * Brutal's `<ht-switch>`: the same abstract switch as Euclid's, expressed as
 * a bordered block on a hard offset shadow — panel-yellow while on — then a
 * two-column rocker of On / Off and a bar with Toggle as the one accent and
 * Refresh. Every button's `data-state` (from the shared vocabulary) is the
 * only status any of this carries; the state word renders only for a phase
 * no button can say (Mixed, the group's gap sentence, "No longer
 * configured…"), hidden the rest of the time. Part names match Euclid's so
 * `HtBinarySwitch.render()` drives it unchanged with no theme-local override
 * needed.
 */
import { sheet, template, vocabularySheet } from "../../browser/dom.ts";
import { HtBinarySwitch } from "../../browser/kinds/switch.ts";

const TEMPLATE = template(`
  <div part="state" aria-live="polite">
    <span part="value" hidden></span>
    <span part="detail" hidden></span>
  </div>
  <p part="gaps" hidden></p>
  <div part="rocker">
    <button type="button" class="btn" data-action="turnOn" part="action turn-on" hidden></button>
    <button type="button" class="btn" data-action="turnOff" part="action turn-off" hidden></button>
  </div>
  <div class="bar" part="actions">
    <button type="button" class="btn btn-primary" data-action="toggle" part="action toggle" hidden></button>
    <button type="button" class="btn" data-action="getState" part="action get-state" hidden></button>
  </div>
`);

const STYLES = sheet(`
  :host { display: block; }
  [part~="state"] {
    display: grid; grid-template-columns: minmax(0, 1fr); row-gap: var(--s1); align-items: center;
    padding: var(--s4) var(--s5); border: var(--rule-w) solid var(--rule); border-radius: var(--radius); box-shadow: var(--shadow);
    background: var(--bg); transition: background var(--motion);
  }
  [part~="state"][data-phase="on"] { background: var(--panel); }
  [part~="value"] { font-size: 3rem; font-weight: 900; line-height: 1; text-transform: uppercase; letter-spacing: -.02em; overflow-wrap: anywhere; }
  [part~="state"][data-phase="offline"] [part~="value"], [part~="state"][data-phase="gone"] [part~="value"] { color: var(--bad); }
  [part~="state"][data-phase="mixed"] [part~="value"] { color: var(--warn); }
  [part~="detail"] { color: var(--fg-2); font-size: .875rem; }
  [part~="gaps"] { color: var(--bad); font-size: .875rem; margin-block: var(--s3) 0; max-width: var(--measure); }
  [part~="rocker"] { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--s3); margin-block: var(--s4); }
  [part~="rocker"] .btn { min-block-size: 3.5rem; font-size: 1.125rem; }
  /* The theme's button voice, restated because [data-theme] rules stop at the shadow boundary. */
  .btn { font-weight: 900; text-transform: uppercase; letter-spacing: .04em; transition: transform var(--motion), box-shadow var(--motion), background var(--motion), color var(--motion); }
  .btn:hover:not([aria-disabled="true"]), .btn:focus-visible { background: var(--panel); color: var(--fg); }
  .btn:active:not([aria-disabled="true"]) { transform: translate(.375rem, .375rem); box-shadow: none; }
  .btn-primary { border-color: var(--rule); }
  .btn-primary:hover:not([aria-disabled="true"]), .btn-primary:focus-visible { background: var(--accent); color: var(--accent-fg); }
`);

export class BrutalSwitch extends HtBinarySwitch {
  constructor() {
    super([vocabularySheet(), STYLES], TEMPLATE, "live");
  }
}
