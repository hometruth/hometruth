import type { GroupView } from "../page-urls";
import type { RegisteredDevice } from "../site";
import { groupNode } from "../state/protocol";
import { escapeHtml as e, type PageContext } from "./shell";
import { renderSwitchPage } from "./switch-page";
import { SWITCH_DEFINITION_CSS } from "./switch-definition";

/**
 * A device group used as a switch: the same `<ht-switch>` as a device, bound
 * to the group's node, whose value is a `GroupSwitch` document. The element
 * shows Mixed while members disagree and names what any member lacks, so the
 * members line here is plain links.
 */
export function renderGroupSwitchPage({ ctx, group, members, definition, settingsView = false }: { ctx: PageContext; group: GroupView; members: readonly RegisteredDevice[]; definition: string; settingsView?: boolean }): string {
  const { t } = ctx.i18n;
  const header = `<h1>${e(group.name)}</h1><nav class="tabs" aria-label="${e(t("device.tabs.label"))}"><a href="${e(group.switchPage)}"${settingsView ? "" : ' aria-current="page"'}>${e(t("device.tabs.controls"))}</a><a href="${e(group.switchPage)}/settings"${settingsView ? ' aria-current="page"' : ""}>${e(t("settings.title"))}</a></nav>
    <p data-switch-source>${e(t("relations.basedOnGroup"))}: <a href="${e(group.page)}">${e(group.name)}</a></p>
    <p class="small" data-switch-members>${e(t("relations.members"))}: ${members.map(member => `<a href="${e(member.page)}" data-group-member="${e(member.id)}">${e(member.name)}</a>`).join(" · ")}</p>`;
  return renderSwitchPage({ ctx, device: { id: group.id, name: group.name, kind: "binary-switch", model: "device-group", modelTitle: t("grouping.group"), host: "", capabilities: ["binarySwitch"], page: group.switchPage, schemaId: "", enabled: true }, header,
    node: groupNode(group.id), settingsView, details: settingsView ? definition : "", css: SWITCH_DEFINITION_CSS });
}
