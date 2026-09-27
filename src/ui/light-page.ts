import type { RegisteredDevice } from "../site";
import { deviceNode } from "../state/protocol";
import { deviceNav, htElement, renderDeviceHead, renderPage, type PageContext } from "./shell";

export interface LightPageOptions {
  ctx: PageContext;
  device: RegisteredDevice;
  capability?: "light" | "stringLight";
  afterControls?: string;
  extraCss?: string;
  extraScript?: string;
}

/**
 * Full controls for a device whose schema is the Light document: one
 * `<ht-light>` bound to the device's node. The element reads power, the
 * brightness, temperature, and colour bounds from the document's actions and
 * sends every control through the generic capability route, so the page
 * carries no script or CSS of its own; a string light passes
 * `capability="stringLight"` and appends its scenes, shows, and bulb list.
 */
export function renderLightPage({ ctx, device, capability = "light", afterControls = "", extraCss = "", extraScript = "" }: LightPageOptions): string {
  const node = deviceNode(device.id);
  return renderPage({
    ctx,
    title: device.name,
    nav: deviceNav(device),
    css: extraCss,
    body: `${renderDeviceHead(ctx, device, "controls")}
      ${htElement(ctx, "ht-light", node, capability === "stringLight" ? 'capability="stringLight"' : "")}${afterControls}`,
    script: extraScript,
    nodes: [node],
    messages: ["light.", "stringLight.", "state.", "summary."],
  });
}
