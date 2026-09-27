/**
 * Euclid's browser entry: install the page's one state client if no entry
 * has yet, then define every `ht-*` tag. Elements subscribe on connect, so
 * the client must exist before the first `define` upgrades a server-rendered
 * element. `define` is idempotent: a page that loads two entries keeps the
 * first definition of each tag.
 */
import { define } from "../../browser/dom.ts";
import { ht } from "../../browser/runtime.ts";
import { createStateClient, readSeed } from "../../browser/state.ts";
import { EuclidButton } from "./button.ts";
import { EuclidLight } from "./light.ts";
import { EuclidSensor, EuclidSensorRow } from "./sensor.ts";
import { EuclidStatus } from "./status.ts";
import { EuclidTelevision } from "./television.ts";
import { EuclidSwitchRow } from "./switch-row.ts";
import { EuclidSwitch } from "./switch.ts";

ht.state ??= createStateClient({
  EventSource,
  // Wrapped: a platform function called as a method of the deps object would be an illegal invocation.
  fetch: (url, init) => fetch(url, init),
  document,
  window,
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (handle) => window.clearTimeout(handle),
  seed: readSeed(document),
});

/** Tag → class, in the order the theme's `components` lists them. */
export const ELEMENTS = {
  "ht-switch": EuclidSwitch,
  "ht-switch-row": EuclidSwitchRow,
  "ht-button": EuclidButton,
  "ht-light": EuclidLight,
  "ht-status": EuclidStatus,
  "ht-sensor": EuclidSensor,
  "ht-sensor-row": EuclidSensorRow,
  "ht-television": EuclidTelevision,
} as const;

for (const [tag, cls] of Object.entries(ELEMENTS)) define(tag, cls);
