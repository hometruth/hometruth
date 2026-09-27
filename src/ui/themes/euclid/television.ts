/**
 * Euclid's `<ht-television>`: the phase word and reading detail, then power,
 * art mode, the input picker, and a remote laid out the way a remote is —
 * a direction pad with its cluster around it, transport under that, volume
 * and channel last. The template is structure only; `HtTelevision.render()`
 * writes every word from the catalog and hides each button the set does not
 * declare, so a plain television and a Frame use the same template with the
 * art part simply absent on the plain one.
 *
 * Theme character reaches shadow roots only through custom properties, so
 * what a theme may retune is read here from `--ht-tv-*` with token fallbacks.
 */
import { sheet, template, vocabularySheet } from "../../browser/dom.ts";
import { HtTelevision } from "../../browser/kinds/television.ts";

const keyButton = (key: string, part: string) =>
  `<button type="button" class="btn" data-action="key" data-key="${key}" part="action key ${part}" hidden></button>`;

const TEMPLATE = template(`
  <div class="state" part="state" aria-live="polite">
    <span class="state-value" part="value" hidden></span>
    <span class="state-detail" part="detail" hidden></span>
  </div>
  <div class="bar" part="actions">
    <button type="button" class="btn" data-action="turnOn" part="action turn-on" hidden></button>
    <button type="button" class="btn" data-action="turnOff" part="action turn-off" hidden></button>
    <button type="button" class="btn" data-action="getState" part="action get-state" hidden></button>
  </div>
  <div class="bar" part="art" hidden>
    <button type="button" class="btn" data-action="artOn" part="action art-on" hidden></button>
    <button type="button" class="btn" data-action="artOff" part="action art-off" hidden></button>
  </div>
  <div class="field" part="input-field" hidden>
    <label for="tv-input" part="input-label"></label>
    <select id="tv-input" part="input"></select>
  </div>
  <div class="pad" part="keys">
    ${keyButton("up", "key-up")}
    ${keyButton("left", "key-left")}
    ${keyButton("select", "key-select")}
    ${keyButton("right", "key-right")}
    ${keyButton("down", "key-down")}
  </div>
  <div class="bar" part="cluster">
    ${keyButton("back", "key-back")}
    ${keyButton("home", "key-home")}
    ${keyButton("menu", "key-menu")}
    ${keyButton("info", "key-info")}
    ${keyButton("exit", "key-exit")}
    ${keyButton("source", "key-source")}
  </div>
  <div class="bar" part="transport">
    ${keyButton("rewind", "key-rewind")}
    ${keyButton("play", "key-play")}
    ${keyButton("pause", "key-pause")}
    ${keyButton("stop", "key-stop")}
    ${keyButton("fastForward", "key-fast-forward")}
  </div>
  <div class="bar" part="volume">
    <button type="button" class="btn" data-action="volumeDown" part="action volume-down" hidden></button>
    <button type="button" class="btn" data-action="toggleMute" part="action mute" hidden></button>
    <button type="button" class="btn" data-action="volumeUp" part="action volume-up" hidden></button>
    ${keyButton("channelDown", "key-channel-down")}
    ${keyButton("channelUp", "key-channel-up")}
  </div>
  <p class="feedback" part="feedback" role="status" aria-live="polite"></p>
`);

const STYLES = sheet(`
  :host {
    display: block;
    /* The theme contract: each hook a theme may set on the page, over the vocabulary's token. */
    --_rule: var(--ht-tv-rule, var(--rule));
    --_rule-w: var(--ht-tv-rule-w, var(--rule-w));
    --_value-size: var(--ht-tv-value-size, 1.75rem);
    --_value-weight: var(--ht-tv-value-weight, 400);
    --_value-tracking: var(--ht-tv-value-tracking, 0);
    --_art: var(--ht-tv-art, var(--accent));
    --_offline: var(--ht-tv-offline, var(--bad));
  }
  [part~="state"] { border-block: var(--_rule-w) solid var(--_rule); }
  [part~="value"] { font-size: var(--_value-size); font-weight: var(--_value-weight); letter-spacing: var(--_value-tracking); }
  [part~="state"][data-phase="art"] [part~="value"] { color: var(--_art); }
  [part~="state"][data-phase="offline"] [part~="value"], [part~="state"][data-phase="gone"] [part~="value"] { color: var(--_offline); }
  /* The direction pad keeps its cross whichever keys a set declares: an absent
     key leaves its cell empty rather than collapsing the cross into a row. */
  [part~="keys"] {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 4.5rem));
    gap: var(--s2);
    justify-content: start;
    margin-block: var(--s4);
  }
  [part~="key-up"] { grid-area: 1 / 2; }
  [part~="key-left"] { grid-area: 2 / 1; }
  [part~="key-select"] { grid-area: 2 / 2; }
  [part~="key-right"] { grid-area: 2 / 3; }
  [part~="key-down"] { grid-area: 3 / 2; }
  [part~="keys"] [hidden] { display: none; }
  [part~="input-field"] { margin-block: var(--s4); }
`);

export class EuclidTelevision extends HtTelevision {
  constructor() {
    super([vocabularySheet(), STYLES], TEMPLATE, "live");
  }
}
