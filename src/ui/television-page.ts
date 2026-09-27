import type { RegisteredDevice } from "../site";
import { deviceNode } from "../state/protocol";
import { deviceNav, htElement, renderDeviceHead, renderPage, type PageContext } from "./shell";

export interface TelevisionPageOptions {
  ctx: PageContext;
  device: RegisteredDevice;
}

/**
 * Full controls for a device whose schema is the Television document: one
 * `<ht-television>` bound to the device's node. The element reads power, art
 * mode, the declared keys, and the input list from the document's own actions
 * and sends every control through the generic capability route, so the page
 * carries no script and no CSS of its own.
 */
export function renderTelevisionPage({ ctx, device }: TelevisionPageOptions): string {
  const node = deviceNode(device.id);
  return renderPage({
    ctx,
    title: device.name,
    nav: deviceNav(device),
    body: `${renderDeviceHead(ctx, device, "controls")}
      ${htElement(ctx, "ht-television", node)}`,
    nodes: [node],
    messages: ["tv.", "state.", "status.", "action.", "summary."],
  });
}
