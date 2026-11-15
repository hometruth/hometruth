import { sheet, template, vocabularySheet } from "../../browser/dom.ts";
import { HtBinarySwitch } from "../../browser/kinds/switch.ts";

const TEMPLATE = template(`
  <span part="value" hidden></span>
  <span part="actions">
    <button type="button" data-action="toggle" part="action toggle" hidden></button>
    <button type="button" data-action="turnOn" part="action turn-on" hidden></button>
    <button type="button" data-action="turnOff" part="action turn-off" hidden></button>
  </span>
  <span part="feedback" class="sr-only" role="status" hidden></span>
`);
const STYLES = sheet(`
  :host{display:inline-flex;align-items:center;gap:.5rem}
  [part~="actions"]{display:flex;gap:.35rem}
  button{border:0;border-radius:50%;width:2.8rem;height:2.8rem;background:var(--panel);color:var(--fg);cursor:pointer;font:600 .7rem var(--font-body)}
  button[data-action=toggle]{font-size:0}
  button[data-action=toggle]::before{content:"⏻";font-size:1.35rem}
  :host([data-phase=on]) button[data-action=toggle],button[data-state=active]{background:#f6cf73;color:#46351c}
  :host([data-phase=offline]) button{color:var(--bad)}
  button[data-state=updating]{opacity:.5;cursor:wait}
  button[data-state=failure]{outline:2px solid var(--bad)}
  button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
  [hidden]{display:none!important}
`);

/** Compact power control for a tile; all writes retain the capability model's guards. */
export class WrightSwitchRow extends HtBinarySwitch {
  constructor() { super([vocabularySheet(), STYLES], TEMPLATE, "glance"); }
  protected override render(): void {
    super.render();
    const toggle = this.document?.actions.toggle !== undefined;
    if (toggle) for (const button of this.actionButtons()) if (button.dataset.action !== "toggle") button.hidden = true;
    const button = this.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="toggle"]');
    if (button) button.setAttribute("aria-pressed", String(this.view.phase === "on"));
  }
}
