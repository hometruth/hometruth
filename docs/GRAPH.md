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

The CLI exposes `ht graph <id> --explain` and element listings. UI graph views
show neighborhoods rather than requiring users to understand the entire graph.
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
- `src/graph/view.ts`: graph presentation.

All persisted graph, tag and observation data belongs in the private runtime
directory. Public tests use synthetic configurations and fixtures.
