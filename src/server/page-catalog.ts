/** Presentation indexes over the state service's immutable domain topology. */
import type { StateHub } from "../state/hub";
import type { Graph } from "../graph/graph";
import { listElements, type Element } from "../tags/elements";
import { tagPage, type Tag } from "../tags/model";
import { addressesFor } from "../element-api/addresses";

export type TaggedElement = Element & { tagIds: string[] };
export interface TagPageData { tags: (Tag & { page: string })[]; elements: TaggedElement[] }
interface Catalog extends TagPageData {
  topology: Graph;
  revision: number;
  byKey: Map<string, TaggedElement>;
  byPage: Map<string, TaggedElement[]>;
}
const catalogs = new WeakMap<StateHub, Catalog>();
export function pageCatalog(hub: StateHub): Catalog {
  const topology = hub.data.topology(), store = hub.data.sources.tags;
  const existing = catalogs.get(hub);
  if (existing?.topology === topology && existing.revision === store.revision) return existing;
  const assignments = store.assignments();
  const addresses = addressesFor(hub);
  const elements = listElements(topology).map(element => ({ ...element, page: `/elements/${encodeURIComponent(addresses.address(element.key)!)}`, tagIds: assignments.get(element.key) ?? [] }));
  const byPage = new Map<string, TaggedElement[]>();
  for (const element of elements) if (element.sourcePage) {
    const list = byPage.get(element.sourcePage);
    if (list) list.push(element); else byPage.set(element.sourcePage, [element]);
  }
  const catalog = { topology, revision: store.revision, elements, tags: store.list().map(tag => ({ ...tag, page: tagPage(tag) })), byKey: new Map(elements.map(element => [element.key, element])), byPage };
  catalogs.set(hub, catalog);
  return catalog;
}
