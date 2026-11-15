/** Island materials around shared capabilities and compact power tiles. */
import { define } from "../../browser/dom.ts";
import { ht } from "../../browser/runtime.ts";
import { createStateClient, readSeed } from "../../browser/state.ts";
import { EuclidButton } from "../euclid/button.ts";
import { EuclidLight } from "../euclid/light.ts";
import { EuclidSensor, EuclidSensorRow } from "../euclid/sensor.ts";
import { EuclidStatus } from "../euclid/status.ts";
import { EuclidTelevision } from "../euclid/television.ts";
import { WrightSwitchRow } from "./switch-row.ts";
import { EuclidSwitch } from "../euclid/switch.ts";

ht.state ??= createStateClient({
  EventSource,
  apiPath: path => ht.apiPath(path),
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
  "ht-switch-row": WrightSwitchRow,
  "ht-button": EuclidButton,
  "ht-light": EuclidLight,
  "ht-status": EuclidStatus,
  "ht-sensor": EuclidSensor,
  "ht-sensor-row": EuclidSensorRow,
  "ht-television": EuclidTelevision,
} as const;

for (const [tag, cls] of Object.entries(ELEMENTS)) define(tag, cls);
