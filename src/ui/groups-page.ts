import type { DeviceGroup } from "../schemas";
import type { RegisteredDevice } from "../site";
import { groupPage } from "../page-urls";
import { groupPagePath, partitionDevicesIntoGroups } from "./home";
import { escapeHtml, renderPage, type PageContext } from "./shell";

export function renderGroupsPage({ ctx, groups, devices, canCreate }: {
  ctx: PageContext; groups: readonly DeviceGroup[]; devices: readonly RegisteredDevice[]; canCreate: boolean;
}): string {
  const { t } = ctx.i18n;
  const { groups: speakerGroups } = partitionDevicesIntoGroups(devices);
  const entries = [
    ...groups.map(group => ({ id: group.id, name: group.name, page: groupPage(group), room: group.room,
      detail: `${t("grouping.count", { count: group.members.length })}${group.criteria ? ` · ${t("grouping.automatic")}` : ""}${group.asSwitch ? ` · ${t("grouping.onSwitches")}` : ""}` })),
    ...speakerGroups.map(group => ({ id: group.slug, name: group.label, page: group.page ?? groupPagePath(group.label),
      room: group.controlDevice?.room ?? group.members[0]?.room, detail: t("home.speakers", { count: group.members.length }) })),
    ...devices.filter(device => device.model === "light-group" || device.model === "sonos-group" && !device.groupLabel)
      .map(device => ({ ...device, detail: device.modelTitle })),
  ];
  return renderPage({ ctx, title: t("nav.groups"), nav: "groups",
    body: `<h1>${escapeHtml(t("nav.groups"))}</h1>
      ${canCreate ? `<div class="bar"><a class="btn" href="/groups/new">${escapeHtml(t("grouping.create"))}</a><a class="btn" href="/groups/new?type=automatic">${escapeHtml(t("grouping.createAutomatic"))}</a></div>` : ""}
      ${entries.length ? `<ul class="rows">${entries.map(group => `<li><a class="row" href="${escapeHtml(group.page)}">
        <span class="row-name">${escapeHtml(group.name)}</span><span class="row-meta">${escapeHtml(group.detail)}${group.room ? ` · ${escapeHtml(group.room)}` : ""}</span>
        <span class="row-side mono small">${escapeHtml(group.id)}</span></a></li>`).join("")}</ul>` : `<p class="empty">${escapeHtml(t("grouping.empty"))}</p>`}`,
  });
}
