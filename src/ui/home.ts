import type { RegisteredDevice } from "../site";
import type { DeviceGroup as SavedDeviceGroup } from "../schemas";
import { groupPage } from "../page-urls";
import { deviceNode, type NodeId } from "../state/protocol";
import { deviceConnectionLabel, escapeHtml, htElement, renderPage, type PageContext } from "./shell";

export interface HomePageOptions {
  ctx: PageContext;
  devices: readonly RegisteredDevice[];
  /** Whether the server can look devices up by MAC on the managed network and rewrite their addresses. */
  canRescan?: boolean;
  canGroup?: boolean;
  deviceGroups?: readonly SavedDeviceGroup[];
}

export const HOME_API = { rescan: "/api/network/rescan" } as const;

/** A stable, URL-safe id for a group label, used in `/groups/:slug`. */
export function groupSlug(groupLabel: string): string {
  const slug = groupLabel.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
  return slug || "group";
}

export function groupPagePath(groupLabel: string): string {
  return `/groups/${encodeURIComponent(groupSlug(groupLabel))}`;
}

export interface DeviceGroup {
  readonly page?: string;
  readonly label: string;
  readonly slug: string;
  readonly members: readonly RegisteredDevice[];
  /** A device (e.g. a `sonos-group`) that controls this whole group by delegating to its live coordinator, when one is configured with a matching `group` label. Not itself one of `members`. */
  readonly controlDevice?: RegisteredDevice;
}

/**
 * Devices with no `groupLabel` stay standalone; devices sharing a
 * `groupLabel` collapse into one `DeviceGroup`, in the order their first
 * member appeared. A `groupLabel` whose slug collides with another
 * (different-cased or punctuated the same way) is treated as the same
 * group, since `/groups/:slug` can only address one page per slug. A
 * `kind: "speaker-group"` device becomes that group's `controlDevice`
 * rather than a member — it represents the group as a whole, so listing it
 * alongside its own members would double it up.
 */
export function partitionDevicesIntoGroups(devices: readonly RegisteredDevice[]): {
  standalone: readonly RegisteredDevice[];
  groups: readonly DeviceGroup[];
} {
  const standalone: RegisteredDevice[] = [];
  type MutableGroup = { label: string; slug: string; page?: string; members: RegisteredDevice[]; controlDevice?: RegisteredDevice };
  const groupsBySlug = new Map<string, MutableGroup>();
  const order: string[] = [];
  const groupFor = (device: RegisteredDevice): MutableGroup => {
    const slug = groupSlug(device.groupLabel!);
    const key = device.groupPage ?? slug;
    let group = groupsBySlug.get(key);
    if (!group) {
      group = { label: device.groupLabel!, slug, members: [], ...(device.groupPage ? { page: device.groupPage } : {}) };
      groupsBySlug.set(key, group);
      order.push(key);
    }
    return group;
  };
  for (const device of devices) {
    if (device.parent) continue;
    if (!device.groupLabel) {
      standalone.push(device);
      continue;
    }
    const group = groupFor(device);
    if (device.kind === "speaker-group") group.controlDevice = device;
    else group.members.push(device);
  }
  return { standalone, groups: order.map((slug) => groupsBySlug.get(slug)!) };
}

/** The home page's "Rescan network" control: one request, then the rows that moved show their new address. */
const RESCAN_SCRIPT = String.raw`
  (() => {
    const button = document.querySelector("[data-rescan]");
    const status = document.querySelector("[data-rescan-status]");
    const list = document.querySelector("[data-rescan-results]");
    if (!(button instanceof HTMLButtonElement) || !(list instanceof HTMLElement)) return;
    const line = (result) => {
      const values = { name: result.name, address: result.currentAddress || result.address, previous: result.address, mac: result.mac || "", detail: result.detail || "" };
      switch (result.outcome) {
        case "moved": return ht.t("rescan.moved", values);
        case "identified": return ht.t("rescan.identified", values);
        case "missing": return ht.t("rescan.missing", values);
        case "unidentified": return ht.t("rescan.unidentified", values);
        case "ambiguous": return ht.t("rescan.ambiguous", values);
        case "failed": return ht.t("rescan.failed", values);
        default: return "";
      }
    };
    button.addEventListener("click", async () => {
      button.disabled = true;
      list.replaceChildren();
      ht.say(status, ht.t("rescan.running"));
      try {
        const body = await ht.request(${JSON.stringify(HOME_API.rescan)}, { method: "POST", body: "{}" });
        const results = Array.isArray(body.results) ? body.results : [];
        const count = (outcome) => results.filter((result) => result.outcome === outcome).length;
        ht.say(status, ht.t("rescan.summary", { moved: count("moved"), identified: count("identified"), missing: count("missing") }), count("failed") > 0 ? "bad" : "ok");
        for (const result of results) {
          if (result.outcome === "unchanged") continue;
          const item = document.createElement("li");
          item.textContent = line(result);
          item.dataset.outcome = result.outcome;
          list.append(item);
          if (result.outcome !== "moved") continue;
          const host = document.querySelector('[data-device-id="' + CSS.escape(result.deviceId) + '"] .mono');
          if (host instanceof HTMLElement) host.textContent = result.currentAddress;
        }
      } catch (error) {
        ht.say(status, error instanceof Error && error.message ? error.message : ht.t("rescan.unavailable"), "bad");
      } finally {
        button.disabled = false;
      }
    });
  })();
`;

/** One device row: name, model and address, and an `<ht-status>` bound to the device's node. `data-device-id` lets the rescan script rewrite a moved address. */
export function renderDeviceRow(ctx: PageContext, device: RegisteredDevice): string {
  const connection = deviceConnectionLabel(ctx, device);
  return `<li><a class="row" href="${escapeHtml(device.page)}" data-device-id="${escapeHtml(device.id)}">
      <span class="row-name">${escapeHtml(device.name)}</span>
      <span class="row-meta">${escapeHtml(device.modelTitle)}${connection ? ` · ${escapeHtml(connection)}` : ""} · <span class="mono">${escapeHtml(device.host)}</span></span>
      <span class="row-side">${htElement(ctx, "ht-status", deviceNode(device.id))}</span>
    </a></li>`;
}

/**
 * The device whose status stands for a label group's row: its control
 * device (a `sonos-group` delegating to the live coordinator) when one is
 * configured, else its first member. A bonded Sonos set answers through one
 * unit, so one node says what the row needs.
 */
export function groupRowDevice(group: DeviceGroup): RegisteredDevice | undefined {
  return group.controlDevice ?? group.members[0];
}

function renderGroupRow(ctx: PageContext, group: DeviceGroup): string {
  const { t } = ctx.i18n;
  const device = groupRowDevice(group);
  return `<li><a class="row" href="${escapeHtml(group.page ?? groupPagePath(group.label))}">
      <span class="row-name">${escapeHtml(group.label)}</span>
      <span class="row-meta">${escapeHtml(t("home.speakers", { count: group.members.length }))}</span>
      <span class="row-side">${device ? htElement(ctx, "ht-status", deviceNode(device.id)) : ""}</span>
    </a></li>`;
}

/**
 * The root page. It is intentionally empty for now — the devices listing
 * moved to `/devices`, and nothing has taken the root's place yet, so it
 * carries the site chrome and no content of its own.
 */
export function renderRootPage(ctx: PageContext): string {
  return renderPage({ ctx, title: "", body: "" });
}

export function renderHomePage({ ctx, devices, canRescan = false, canGroup = false, deviceGroups = [] }: HomePageOptions): string {
  const { t } = ctx.i18n;
  const { standalone, groups } = partitionDevicesIntoGroups(devices);
  deviceGroups = deviceGroups.filter(group => !group.builtIn);
  const groupedIds = new Set(deviceGroups.filter(group => !group.criteria).flatMap(group => group.members));
  type Entry = { room: string | undefined; html: string; node?: NodeId };
  const entries: Entry[] = [
    ...deviceGroups.map(group => ({ room: group.room, html: `<li><a class="row" href="${escapeHtml(groupPage(group))}">
      <span class="row-name">${escapeHtml(group.name)}</span><span class="row-meta">${escapeHtml(t("grouping.count", { count: group.members.length }))}</span>
      <span class="row-side">${escapeHtml(t("grouping.group"))}</span></a></li>` })),
    ...groups.map((group) => {
      const device = groupRowDevice(group);
      return { room: group.members[0]?.room ?? group.controlDevice?.room, html: renderGroupRow(ctx, group), ...(device ? { node: deviceNode(device.id) } : {}) };
    }),
    ...standalone.filter(device => !groupedIds.has(device.id)).map((device) => ({ room: device.room, html: renderDeviceRow(ctx, device), node: deviceNode(device.id) })),
  ];
  const rooms = [...new Set(entries.map((entry) => entry.room).filter((room): room is string => Boolean(room)))];
  let list: string;
  if (rooms.length === 0) {
    list = `<ul class="rows" id="devices" aria-label="${escapeHtml(t("home.title"))}">${entries.map((entry) => entry.html).join("")}</ul>`;
  } else {
    const section = (heading: string, items: Entry[]) => items.length === 0 ? "" : `<section><h2>${escapeHtml(heading)}</h2><ul class="rows">${items.map((entry) => entry.html).join("")}</ul></section>`;
    list = `<div id="devices">${rooms.map((room) => section(room, entries.filter((entry) => entry.room === room))).join("")}${section(t("home.noRoom"), entries.filter((entry) => !entry.room))}</div>`;
  }
  const body = devices.length > 0
    ? list
    : `<p class="empty" id="devices">${escapeHtml(t("home.empty"))}</p>`;
  const rescan = canRescan && devices.length > 0
    ? `<div class="rescan"><button type="button" class="btn" data-rescan>${escapeHtml(t("rescan.all"))}</button><p class="feedback" role="status" data-rescan-status></p><ul class="rescan-results" data-rescan-results></ul></div>`
    : "";
  return renderPage({
    ctx,
    title: t("home.title"),
    nav: "devices",
    body: `<h1>${escapeHtml(t("home.title"))}</h1>${canGroup && devices.length >= 2 ? `<div class="bar"><a class="btn" href="/groups/new">${escapeHtml(t("grouping.create"))}</a></div>` : ""}${body}${rescan}`,
    script: rescan ? RESCAN_SCRIPT : "",
    nodes: entries.flatMap((entry) => entry.node ? [entry.node] : []),
    messages: ["home.", "rescan.", "state.", "summary."],
  });
}
