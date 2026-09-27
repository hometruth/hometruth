/**
 * Euclid's `<ht-sensor>`: one door or presence sensor as a row of cells.
 *
 * The host is `display: contents`, so these cells are laid out by the grid on the list that holds
 * them, not by the element. A hub's nine sensors line up down the page because the list is one
 * grid; the same element alone on its own page is that grid with a single row. Nothing about the
 * element changes between the two.
 *
 * `ht-sensor` reads at the `live` tier for a device page, `ht-sensor-row` at `glance` for a list.
 * They are the same view — the tier is the only difference, exactly as `ht-switch` is to
 * `ht-switch-row`.
 */
import { sheet, template, vocabularySheet } from "../../browser/dom.ts";
import { HtSensor } from "../../browser/kinds/sensor.ts";

const TEMPLATE = template(`
  <span class="sensor-row" part="state">
    <a class="sensor-name" part="name"></a>
    <span class="sensor-reading" part="reading">
      <span class="mark" part="mark" aria-hidden="true"></span>
      <span part="value"></span>
    </span>
    <span class="sensor-cell" part="battery"></span>
    <span class="sensor-cell" part="age"></span>
    <span class="sensor-detail note" part="detail" hidden></span>
  </span>
`);

const STYLES = sheet(`
  :host { display: contents; }
  /*
   * The container is contents too: its children are the grid cells, so a row's four cells sit in
   * the list's columns rather than in a box of their own. The row rule comes from the list.
   */
  [part~="state"] { display: contents; }
  [part~="name"] { color: inherit; }
  [part~="name"]:not([href]) { text-decoration: none; }
  .sensor-reading { display: inline-flex; align-items: center; gap: var(--s2); }
  .sensor-cell { font-variant-numeric: tabular-nums; }
  /*
   * The cells carry their own rule and rhythm rather than the list drawing one, so a row looks
   * the same whether nine of them stack under a hub or one sits alone on its own page.
   */
  [part~="name"], [part~="reading"], [part~="battery"], [part~="age"] {
    padding-block: var(--s3); border-block-end: 1px solid var(--hair); align-self: stretch;
  }
  [part~="age"] { color: var(--ht-sensor-age, var(--fg-2)); font-size: .8125rem; }
  /* A reading nobody has confirmed lately is still the honest last reading; only its age dims. */
  [part~="state"][data-stale="true"] [part~="age"] { opacity: .7; }
  [part~="detail"] { grid-column: 1 / -1; color: var(--ht-sensor-detail, var(--bad)); font-size: .8125rem; }
  [part~="detail"][hidden] { display: none; }
`);

export class EuclidSensor extends HtSensor {
  constructor() {
    super([vocabularySheet(), STYLES], TEMPLATE, "live");
  }
}

export class EuclidSensorRow extends HtSensor {
  constructor() {
    super([vocabularySheet(), STYLES], TEMPLATE, "glance");
  }
}
