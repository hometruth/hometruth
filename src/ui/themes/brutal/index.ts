/**
 * Brutal's browser entry: the same state client install as Euclid's, its own
 * `<ht-switch>`, and Euclid's classes for the other tags. It cannot
 * import Euclid's entry: imports are hoisted, so Euclid's `ht-switch` would
 * be defined first and `define` would keep it.
 */
import { define } from "../../browser/dom.ts";
import { ht } from "../../browser/runtime.ts";
import { createStateClient, readSeed } from "../../browser/state.ts";
import { EuclidButton } from "../euclid/button.ts";
import { EuclidLight } from "../euclid/light.ts";
import { EuclidSensor, EuclidSensorRow } from "../euclid/sensor.ts";
import { EuclidStatus } from "../euclid/status.ts";
import { EuclidTelevision } from "../euclid/television.ts";
import { EuclidSwitchRow } from "../euclid/switch-row.ts";
import { BrutalSwitch } from "./switch.ts";

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
  "ht-switch": BrutalSwitch,
  "ht-switch-row": EuclidSwitchRow,
  "ht-button": EuclidButton,
  "ht-light": EuclidLight,
  "ht-status": EuclidStatus,
  "ht-sensor": EuclidSensor,
  "ht-sensor-row": EuclidSensorRow,
  "ht-television": EuclidTelevision,
} as const;

for (const [tag, cls] of Object.entries(ELEMENTS)) define(tag, cls);
