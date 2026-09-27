import type { RegisteredDevice } from "../site";
import { deviceNode } from "../state/protocol";
import { renderDeviceRow } from "./home";
import { escapeHtml, renderPage, type PageContext } from "./shell";

export interface GroupPageOptions {
  ctx: PageContext;
  label: string;
  members: readonly RegisteredDevice[];
  controlDevice?: RegisteredDevice;
}

/**
 * A logical group of Sonos devices (a stereo pair, a home theater set)
 * sharing a `group` config label: one row per physical unit, each linking
 * into its own page. The group itself has no combined controls — a bonded
 * satellite often cannot answer AVTransport calls at all, so "control this
 * group" means "control its coordinator," which the member list makes
 * discoverable rather than second-guessed here.
 */
export function renderGroupPage({ ctx, label, members, controlDevice }: GroupPageOptions): string {
  const { t } = ctx.i18n;
  return renderPage({
    ctx,
    title: label,
    nav: "groups",
    body: `<h1>${escapeHtml(label)}</h1>
      <p class="note">${escapeHtml(t("group.note"))}</p>
      ${controlDevice ? `<p>${escapeHtml(t("relations.uses"))}: <a href="${escapeHtml(controlDevice.page)}">${escapeHtml(controlDevice.name)}</a></p>` : ""}
      <ul class="rows" id="members" aria-label="${escapeHtml(t("group.members"))}">${members.map((device) => renderDeviceRow(ctx, device)).join("")}</ul>`,
    nodes: members.map((device) => deviceNode(device.id)),
    messages: ["home.", "state.", "summary."],
  });
}
