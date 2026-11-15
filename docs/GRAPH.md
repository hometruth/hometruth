# Graph and observed state

HomeTruth exposes relationships between its schemas, configured objects and
tags. It also maintains a state graph for live observations. These structures
serve different purposes: relationships explain what an element is connected
to; state records say what was observed and when.

## Relationship graph

[`src/graph/types.ts`](../src/graph/types.ts) defines nodes, edges and relations.
The graph has three sides:

| Side | Contains |
| --- | --- |
| Schema | Models, capability definitions, schemas, controls, properties and event types |
| Instance | The configured site, devices, capabilities, groups, services and other addressable elements |
| Tag | Tag names and values, including rooms |

`instanceOf` joins configured objects to schema definitions. `tagged` connects
a tag value to the elements carrying it. Other relations express containment,
membership, dependencies, service ownership and observation sources. Each edge
has one canonical direction and an inverse name for traversal from either end.
Its origin records whether it came from structure, provisioning, site-level
configuration, schema traversal or a state source.

Builders work from in-memory snapshots; building a graph does not probe hardware.
The store reconciles natural element keys with persistent node identities and
retains referenced absent nodes as appropriate. Do not use a display name,
config array position or transient observation as a durable identity.

The graph has one page, `/graph`, with three views:

- **Home** groups devices and other operational elements by room or kind. Group
  counts make omitted members explicit, and expansion reveals more members.
- **Dependencies** follows the focused element's configured relationships in
  separate incoming and outgoing directions, preserving each edge's role and
  provenance. A shared target does not pull its other users into the default
  view. Explicit expansion can reveal its immediate neighbours.
- **Model** explores definitions, instances and tags with typed relationships.

Dependencies defaults to `uses` for ordinary elements, `members` and
`groupSwitch` for groups and group switches, and `services` and `sourcedBy` for
services. An explicit relation filter replaces these defaults; the available
operational relations are `uses`, `members`, `groupSwitch`, `services` and
`sourcedBy`. Group membership, service ownership and observation sources do not
imply command causality. Neither containment nor unrelated infrastructure is
added to an action chain.

The default dependency scene contains at most 12 nodes. Each reachable,
explicitly expanded node adds 12 places, up to 48 nodes. Unreachable expansion
values do not enlarge the scene. Nearby elements take priority, and a selected
element retains its connecting path when that path fits within the limit.
Search keeps only matching names or context. Model retains its separate
160-node limit. Counts describe the eligible scope around the focus, search
matches within that scope and matches omitted by display limits; they do not
describe the entire topology.

Search, selection, grouping, depth, relation filters and expansion are encoded
in the URL. `focus`, `selected` and repeated `expand` parameters use current
public element addresses, for example
`/graph?view=dependencies&focus=desk-switch&selected=desk-radio&expand=desk-radio`.
The response resolves these to canonical graph identities. Home expansion also
accepts group descriptors: `["room","<current room address>"]`,
`["kind","device"]` or `["unassigned"]`, encoded as one `expand` value.
Repeated `relation` parameters select relation kinds. `depth` defaults to 2 and
is bounded from 0 to 3; expansions add one hop from each reached expansion node
without changing focus or relation filters. Device and element pages link to
this canonical page. Removed graph subpage URLs and historical element addresses
return 404.

`GET /api/graph` returns the raw topology, optionally filtered by `side` and
`kind`. `GET /api/graph/scene` accepts the page's query parameters and returns
exactly the projected, positioned scene the page draws. Scene occurrence IDs
allow a device to appear in multiple rooms without duplicating its canonical
identity. Counts distinguish scoped elements, search matches and omitted matches.
Unknown element selectors return 404; layout failure returns 503.

The CLI exposes `ht graph <address> --depth 2 --explain`. It resolves the current
public address, requests the corresponding dependency or model scene, and prints
its connections. `--explain` adds edge provenance; `--json` returns the scene.
The depth flag retains the same display limit. Use the page or scene API for
explicit expansion and relation filters.
The graph does not create a second source of device configuration: model and
inventory declarations remain authoritative.

## State graph

[`src/state/graph.ts`](../src/state/graph.ts) stores one record per observed or
derived node. Structural changes advance versions; unchanged successful reads
refresh observation time. A flush coalesces notifications and recomputes derived
values in dependency order.

The observer polls according to demand and model limits, and subscribes to push
sources where available. Commands invalidate related state; a push observation
refreshes the affected device and dependents. A successful command alone is not
proof that every derived value has been observed again.

Pages use `GET /api/state/stream` for selected nodes. The stream begins with a
snapshot and then delivers changed state and unchanged-observation signals.
[State rendering](STATE_RENDERING.md) describes the browser component contract.
Persisted observations are dated evidence, not a substitute for device
reachability after startup.

## Source map

- `src/graph/schema-graph.ts`, `instance-graph.ts`, `tag-graph.ts`: graph builders.
- `src/graph/store.ts`: persistent identities and reconciliation.
- `src/tags/`: names, assignments, export and element identity.
- `src/state/`: observation, derivation, persistence and subscriptions.
- `src/server/state-routes.ts`: state-stream boundary.
- `src/graph/scene.ts`: deterministic, bounded graph projection and URL state.
- `src/graph/scene-layout.ts`: server layout shared by the page and scene API.
- `src/ui/graph-page.ts`, `src/ui/browser/graph.ts`: graph rendering and interaction.

All persisted graph, tag and observation data belongs in the private runtime
directory. Public tests use synthetic configurations and fixtures.
