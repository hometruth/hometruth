/**
 * Euclid's `<ht-light>`: the swatch, the state word (shown only for a phase
 * no button can say, e.g. "No longer configured…"), the power actions with
 * On as the page's one accent, then one field per control the document
 * declares — brightness and colour temperature as ranges with a live
 * output, a fixed-white button (with the string light's note) when the
 * temperature range is one value, a colour input when `setColor` exists.
 * Every power button's `data-state` is the only status this carries; there
 * is no dot and no "Turning on…"/"Checking…" text. The swatch is an SVG box:
 * `HtLight.render()` sets its `fill` attribute to the reported colour, so no
 * style attribute is ever written; the sheet colours it when the light is on
 * without a colour, and paints it panel when off. Field labels are the
 * template's only static words, written from the catalog on every render.
 */
import { sheet, template, vocabularySheet } from "../../browser/dom.ts";
import { HtLight } from "../../browser/kinds/light.ts";
import type { Key } from "../../browser/runtime.ts";

const TEMPLATE = template(`
  <div class="state" part="state" aria-live="polite">
    <svg part="swatch" data-on="false" viewBox="0 0 16 16" focusable="false" aria-hidden="true"><rect width="16" height="16"></rect></svg>
    <span class="state-value" part="value" hidden></span>
    <span class="state-detail" part="detail" hidden></span>
  </div>
  <div class="bar" part="actions">
    <button type="button" class="btn btn-primary" data-action="turnOn" part="action turn-on" hidden></button>
    <button type="button" class="btn" data-action="turnOff" part="action turn-off" hidden></button>
    <button type="button" class="btn" data-action="toggle" part="action toggle" hidden></button>
    <button type="button" class="btn" data-action="getState" part="action get-state" hidden></button>
  </div>
  <div class="field" part="brightness-field" hidden>
    <label class="field-value" for="brightness"><span part="brightness-label"></span><output part="brightness-value" for="brightness"></output></label>
    <input id="brightness" part="brightness" type="range">
  </div>
  <div class="field" part="temperature-field" hidden>
    <label class="field-value" for="temperature"><span part="temperature-label"></span><output part="temperature-value" for="temperature"></output></label>
    <input id="temperature" part="temperature" type="range">
  </div>
  <div class="field" part="white-field" hidden>
    <button type="button" class="btn" data-action="white" part="action white" hidden></button>
    <p class="note" part="white-help" hidden></p>
  </div>
  <div class="field" part="color-field" hidden>
    <label class="field-value" for="color"><span part="color-label"></span><output part="color-value" for="color"></output></label>
    <input id="color" part="color" type="color" value="#ffffff">
  </div>
`);

const STYLES = sheet(`
  :host {
    display: block;
    --_rule: var(--ht-light-rule, var(--ht-switch-rule, var(--rule)));
    --_rule-w: var(--ht-light-rule-w, var(--ht-switch-rule-w, var(--rule-w)));
    /* One typographic role, the state value, shared with the switch unless a theme sets the light's own. */
    --_value-size: var(--ht-light-value-size, var(--ht-switch-value-size, 1.75rem));
    --_value-weight: var(--ht-light-value-weight, var(--ht-switch-value-weight, 400));
    --_value-tracking: var(--ht-light-value-tracking, var(--ht-switch-value-tracking, 0));
    --_offline: var(--ht-light-offline, var(--ht-switch-offline, var(--bad)));
    --_swatch-on: var(--ht-light-swatch-on, var(--warn-mark));
    --_swatch-off: var(--ht-light-swatch-off, var(--panel));
  }
  [part~="state"] { border-block: var(--_rule-w) solid var(--_rule); }
  [part~="swatch"] { inline-size: 1.5rem; block-size: 1.5rem; flex: none; align-self: center; border: var(--_rule-w) solid var(--_rule); border-radius: var(--mark-radius); overflow: hidden; }
  /* A reported colour arrives as the fill attribute; the sheet stays out of its way and paints only the other two states. */
  [part~="swatch"]:not([data-color]) { fill: var(--_swatch-off); }
  [part~="swatch"][data-on="true"]:not([data-color]) { fill: var(--_swatch-on); }
  [part~="value"] { font-size: var(--_value-size); font-weight: var(--_value-weight); letter-spacing: var(--_value-tracking); }
  [part~="state"][data-phase="offline"] [part~="value"], [part~="state"][data-phase="gone"] [part~="value"] { color: var(--_offline); }
  [part~="white-field"] { justify-items: start; }
`);

export class EuclidLight extends HtLight {
  constructor() {
    super([vocabularySheet(), STYLES], TEMPLATE, "live");
  }

  protected override render(): void {
    super.render();
    // The kind shows or hides the fixed-white button; its field follows, so no empty field keeps its margin.
    const white = this.partNamed("white");
    const field = this.partNamed("white-field");
    if (white && field) field.hidden = white.hidden;
    this.#label("brightness-label", "light.brightness");
    this.#label("temperature-label", "light.colorTemperature");
    this.#label("color-label", "light.color");
  }

  #label(part: string, key: Key): void {
    const element = this.partNamed(part);
    if (element) element.textContent = this.t(key);
  }
}
