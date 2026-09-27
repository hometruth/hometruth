# Object model

HomeTruth describes devices through models and capabilities. The same declared
state, actions and schemas drive the API, CLI and web UI.

## Models and instances

A model represents an implemented product or logical composition. Its registry
record declares a stable model ID, manufacturer/product metadata, capability
kinds, a configuration schema, an optional secrets schema and a factory.
[`src/registry.ts`](../src/registry.ts) lists the models a build can provision.

An instance is one entry in the private `devices.yml`. Its ID identifies it
across controls, logs and references from other devices. Display names and
network addresses are configuration, not credentials. Model-specific secrets
are supplied separately by the private secret store.

`Site.fromConfig` provisions instances with shared vendor services and validated
secrets. Composites resolve references to other configured devices through the
creation context. This records relationships for graph traversal and state
invalidation; missing references and cycles are errors.

## Capabilities

Capability classes in `src/models/` define reusable domains such as a switch,
light, camera, sensor or speaker. Product implementations provide transport and
state mapping. A device composes the capabilities it implements with `expose()`;
public methods can be forwarded to the device. When names collide, callers use
the qualified control name exposed by the API or CLI.

A capability's document declares readable state and available actions, including
argument shapes, units, bounds and confirmation requirements. A schema permits
a shape; it does not prove a particular device supports every optional action.
Use the instance's current action document before writing.

Reads distinguish online, offline, degraded and unknown states. Failed reads do
not manufacture an Off value. A command result must distinguish transport
acknowledgment, inferred state and observed device state.

## Controls, services and events

Controls use the capability invocation boundary, which validates values and
confirmation before dispatch. Protocol details belong in `src/protocols/`;
product mapping belongs in `src/devices/`. Shared vendor connections and account
services belong in `src/vendors/`, exposed through `SiteServices`.

Every device and service must answer `checkHealth()` and publish its `health`
answer. The [Health service](HEALTH.md) checks them hourly, collects immediate
error reports and retains observed uptime and problems. Health is a required
part of the object and service schemas, even when the truthful answer is unknown.

Services have status and event logs independently of device instances. Events
have a catalogued type, subject and schema-checked data. A device may be the
subject of events from several services. Logs describe what happened; the
[state graph](GRAPH.md) provides observed current values.

An Event has a general envelope schema; each event type declares a PayloadSchema
for its `data`. A [Filter](FILTERS.md) is a named predicate over those events,
combining envelope and payload comparisons with boolean logic and local time
windows. The same Filter condition selects history and live subscriptions.

## Extending HomeTruth

Follow the [add-device skill](../skills/hometruth-add-device/SKILL.md) and its
[new-model reference](../skills/hometruth-add-device/references/new-model.md).
Reuse a capability when its semantics fit. Add a new capability only when the
existing vocabulary cannot express the device truthfully. Keep firmware limits
in the product implementation and expose only supported actions.

Tests use injected transports and synthetic fixtures. Public docs describe
reusable contracts and compatibility limits; device research, actual inventories
and credentials remain in the private installation.
