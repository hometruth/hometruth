import { createHash } from "node:crypto";
import type { DeviceGroup } from "./schemas";
import type { RegisteredDevice } from "./site";

export type PageSource = "device" | "group" | "group-switch" | "speaker-group" | "service";
export interface PageEntry { source: PageSource; id: string; name: string; page: string }
export interface GroupView extends DeviceGroup { page: string; switchPage: string }
export interface ElementLink { id: string; name: string; page: string; relation: "partOf" | "contains" | "memberOf" | "groupSwitch" | "members" | "uses" | "usedBy" | "services" }

export function nameSlug(name: string): string {
  return name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 90).replace(/-+$/, "") || "element";
}

export function devicePageType(device: Pick<RegisteredDevice, "kind" | "model">): string {
  if (device.model === "light-group" || device.kind === "speaker-group") return "groups";
  return ({ "binary-switch": "switches", light: "lights", "string-light": "string-lights", button: "buttons", camera: "cameras", "pet-camera": "cameras", sensor: "sensors", hub: "hubs", "ir-rf-blaster": "blasters", speaker: "speakers" } as Record<string, string>)[device.kind] ?? "devices";
}

interface Candidate extends Omit<PageEntry, "page"> { type: string; slug: string }
const pathFor = (type: string, slug: string) => `/${type}/${encodeURIComponent(slug)}`;
const identity = (entry: Pick<PageEntry, "source" | "id">) => `${entry.source}:${entry.id}`;

/** One directory drives current page routes, navigation, and API page fields. */
export class PageDirectory {
  readonly entries: PageEntry[];
  private readonly paths = new Map<string, PageEntry>();
  private readonly identities = new Map<string, PageEntry>();

  constructor(devices: readonly RegisteredDevice[], groups: readonly DeviceGroup[], services: readonly { id: string; title: string }[]) {
    const candidates: Candidate[] = devices.map(device => ({
      source: "device", id: device.id, name: device.name, type: devicePageType(device), slug: nameSlug(device.name),
    }));
    for (const group of groups) {
      const slug = nameSlug(group.name);
      candidates.push({ source: "group", id: group.id, name: group.name, type: "groups", slug });
      if (group.asSwitch) candidates.push({ source: "group-switch", id: group.id, name: group.name, type: "switches", slug });
    }
    const labels = new Set(devices.flatMap(device => device.groupLabel ? [device.groupLabel] : []));
    for (const label of labels) candidates.push({ source: "speaker-group", id: label, name: label, type: "groups", slug: nameSlug(label) });
    for (const service of services) candidates.push({ source: "service", id: service.id, name: service.title, type: "services", slug: nameSlug(service.title) });
    const unique = [...new Map(candidates.map(candidate => [identity(candidate), candidate])).values()];
    const reserved = new Set(["/groups/new"]);
    const counts = new Map<string, Candidate[]>();
    for (const candidate of unique) { const base = pathFor(candidate.type, candidate.slug); const matches = counts.get(base) ?? []; matches.push(candidate); counts.set(base, matches); }
    this.entries = [];
    for (const candidate of [...unique].sort((a, b) => identity(a).localeCompare(identity(b)))) {
      let page = pathFor(candidate.type, candidate.slug);
      const matches = counts.get(page)!;
      const groupSwitch = matches.filter(match => match.source === "group-switch");
      // A single group switch owns the short name; a same-named physical member remains distinct.
      const collision = matches.length > 1 && !(candidate.source === "group-switch" && groupSwitch.length === 1);
      if (collision || reserved.has(page) || this.paths.has(page)) {
        const hash = createHash("sha256").update(identity(candidate)).digest("hex");
        let length = 8;
        do { page = pathFor(candidate.type, `${candidate.slug}-${hash.slice(0, length++)}`); } while (reserved.has(page) || this.paths.has(page));
      }
      const entry: PageEntry = { source: candidate.source, id: candidate.id, name: candidate.name, page };
      this.entries.push(entry); this.paths.set(page, entry); this.identities.set(identity(entry), entry);
    }
  }

  page(source: PageSource, id: string): string | undefined { return this.identities.get(identity({ source, id }))?.page; }

  resolve(path: string): { entry: PageEntry; suffix: string } | undefined {
    for (const suffix of ["", "/settings", "/log", "/light-sync", "/graph", "/SKILL.md", "/openapi.json"]) {
      if (suffix && !path.endsWith(suffix)) continue;
      const base = suffix ? path.slice(0, -suffix.length) : path;
      const entry = this.paths.get(base);
      // A graph is drawable for anything with a page, not only a device.
      const allowed = entry && (entry.source === "device" || (["/graph", "/SKILL.md", "/openapi.json"].includes(suffix)) || (entry.source === "group-switch" && suffix === "/settings"));
      if (!entry || (suffix && !allowed)) continue;
      return { entry, suffix };
    }
    return undefined;
  }
}

export const groupPage = (group: DeviceGroup & Partial<GroupView>) => group.page ?? pathFor("groups", nameSlug(group.name));
export const groupSwitchPage = (group: DeviceGroup & Partial<GroupView>) => group.switchPage ?? pathFor("switches", nameSlug(group.name));
