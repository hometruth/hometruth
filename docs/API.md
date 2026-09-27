# API, services and credentials

JSON Schema IDs use `https://hometruth.ai/schemas/`. The
[public schema host](PUBLIC_SCHEMAS.md) serves the same definitions used by
local validation, including device-model config schemas.

All configuration and runtime paths in this guide are relative to your private installation directory. Commands run from the public source checkout and use `../hometruth_private/`; use `bun run site <private-directory> <command>` for another location. Device names and addresses in examples are illustrative.

## Services

Services are shared runtime components with their own status and event logs.
The enabled set depends on the installation's configuration. Examples include
the embedded MQTT broker, optional vendor account/bridge connections, camera
services and the Hue proxy. A device does not need every service to be configured.

`GET /api/services` lists what the running installation exposes. The MQTT
broker mirrors normalized events to `hometruth/events/<subject>/<type>`.
Vendor-specific requirements and cloud dependencies belong to their respective
setup guides. A device may be the subject of events in several service logs;
filtering by its ID selects those events without creating a service per device.

### Events

Every event has a **type from a catalog** (`src/models/event-types.ts`), and
each type has a JSON Schema for its own fields. An event is not a log line
with a free-text blob: it names what happened (`type`), which device it
happened to (`subject`), and the facts (`data`), so a filter, a chart or a
rich view can key on it without parsing prose. `EventLog.record()` refuses an
unknown type or data that does not match its schema, which turns a typo at
the emitter into a loud failure rather than a row nothing can render.

Types are declared once and used everywhere: `motion` and `alarm` carry a
thumbnail and a clip length, `settings` carries the property codes that
changed, `cloud_request` carries method, host, path and status, `dns_lookup`
and `tls_attempt` and `connection` carry what an isolated device tried to
reach. `GET /api/event-types` returns the whole catalog with each type's
`payloadSchema`. The shared envelope is described by the Event schema.

[Filters](FILTERS.md) combine envelope fields, payload comparisons and local
time windows with `all`, `any`, and `not`. Event history and stream endpoints
accept a JSON-encoded Filter condition in `where`; it combines with subject,
type and label selections and applies before the result limit.

`GET /services` lists the running services; `GET /services/<id>` shows a live
tail (Server-Sent Events, not polling) with two filters, **device** and
**event**, both applied at the source so a filtered view never receives
anything else. Each row renders according to its type: a motion event shows
its thumbnail, a settings change lists the codes, a request shows its status.
The same log, filtered to one camera, is the **Events** tab on that camera's
own page.

`GET /services/mqtt-broker` is the unified view: it includes the broker's own
client activity plus events mirrored from every other service and every
HomeTruth control path. Source service logs and per-device logs remain in
place; the broker mirror is excluded when building a device's aggregate log
so the same event is not shown twice.

```sh
curl -fsS http://127.0.0.1:3000/api/services
curl -fsS http://127.0.0.1:3000/api/event-types
curl -fsS "http://127.0.0.1:3000/api/services/tkenpro-cloud-emulator/events?subject=example-camera&type=motion"
curl -N "http://127.0.0.1:3000/api/services/tkenpro-cloud-emulator/stream?subject=example-camera"
```

Ordinary service event logs are bounded in-memory buffers. Services with
explicit history stores, such as Frigate and the photo archive, can retain
records across restarts. Keep credentials and raw sensitive payloads out of logs. A service implements `src/models/service.ts`'s `Service` and takes
its dependencies through `SiteServices` declaration merging.

## The API, described

`/api-docs` lists every route this install serves, and `/api/openapi.json` is
the same thing as an OpenAPI 3.1 document. Neither is written down anywhere:
the paths are the routes Hono has actually registered in the running process,
the permissions are read back out of `src/auth/policy.ts`, the bodies are the
schemas named in `src/openapi/operations.ts`, and the schemas themselves are
`src/schema-catalog.ts` dropped in whole — OpenAPI 3.1 speaks JSON Schema
2020-12, which is the dialect every document in this project is already
written in. A description that is generated from the same documents the server
validates against reduces duplication. Coverage tests check that registered
routes declare their operations and schemas.

The path parameters describe the selected installation. `{id}` on a light route enumerates this install's lights by
id, with their names beside them; `{control}` enumerates the controls its
devices actually expose; `{kind}` enumerates the capability kinds. A caller
holding a narrow token sees narrow enumerations, because the principal that
decides "may I" also decides "which".

The page is the playground: open an operation, choose the device from the
list, edit the request body it offers (built from the request schema), and
send it against this server. Reads are one click; **Allow writes** must be
turned on before anything that is not a `GET` will send, because everything
else on that page may change configuration or act on a device.

```sh
curl -fsS http://127.0.0.1:3000/api/openapi.json | jq '.paths | keys | length'
```

Every element page also has **API**, **REST**, **CLI**, and **SKILL.md** tabs.
These enumerate schema properties and the controls the instance exposes, bind
its actual object ID, and include related REST operations. The API tab
uses one shared HomeTruth client and a sandboxed playground; the REST tab uses the
same OpenAPI playground as `/api-docs`. Nothing executes until you run it.

View state belongs in the URL. The shared tabs use `?tab=api`, `?tab=rest`,
`?tab=cli`, and `?tab=skill`; Controls, Graph, Log, and Settings keep their page
paths. Filters, selected examples, and expanded sections restore from a copied
URL, a reload, or Back/Forward. Page scripts use the shared `ht.pageState`
helper so changing one part of the view preserves the other query parameters.

Append `/SKILL.md` or `/openapi.json` to the element's current page URL
to retrieve its agent instructions or OpenAPI document.
For example, `/switches/exhaust-fan/SKILL.md`. Renaming the element changes these
URLs along with its page. Nested elements use `/elements/<key>/SKILL.md`.

Download the shared library once from `/ht.ts` (or import the package's
`@hometruth/tkenpro/client` entry point). Browser modules can import `/ht.js`.
The client discovers every accessible element from `/api/inventory`:

```ts
import ht from "./ht";

await ht.connect("http://127.0.0.1:3000"); // Optional second argument: { token }
console.log(ht.inventory); // Every element: UUID, object ID, kind, name and page.
console.log(await ht.elements.root.describe()); // The site itself.

await ht.devices["example-switch"].on();
await ht.devices["example-switch"].off();
await ht.devices["example-switch"].toggle();

console.log(await ht.elements["example-switch"].describe());
const element = ht.inventory.find(element => element.deviceId === "example-switch")!;
console.log(await ht.elements[element.uuid].describe());
```

`ht.devices` is keyed by device ID. `ht.elements` enumerates UUIDs and also
accepts unambiguous object IDs and inventory keys. Both lookups return the same
handle. The reserved name `root` always identifies the site: `ht.elements.root`,
`ht root help`, and `GET /api/elements/root`. The site's skill is `/SKILL.md`.
`describe()` lists public properties, methods and argument types;
`read()` retrieves current state. Method details are loaded on demand.
`connect()` loads metadata only and scopes the inventory to the caller's token.
Call `connect()` again to refresh it; handles from the previous connection then
expire. There are no per-device TypeScript modules.

The CLI tab supplies native, copyable commands: `ht example-switch on`,
`ht example-switch off`, `ht desk-light brightness 50`. Run `ht <id>` for
state and controls, or `ht <id> help` for every command and option. Settings,
events, tags and other schema operations have named commands too; inputs use
values and named options, without HTTP verbs or URLs. The CLI discovers this
vocabulary from the same schema used by the page and its SKILL.md tab. Set
`HOMETRUTH_URL` and, when required, `HOMETRUTH_TOKEN` to select an install.

## API tokens

Anyone on a private network (RFC 1918, loopback, link-local, IPv6 ULA) reaches
everything with no token at all; the address is read off the socket by the
supervisor, never from a header a client can set. Tailscale's `100.64/10` is
deliberately not included, so reaching the installation from outside still needs a
token. `HOMETRUTH_TRUST_LAN=off` requires one everywhere.

A token is what anything else presents — a script over the internet, or a
client you want to keep narrow even at home, since a presented token always
wins over the network it came from. The access levels are `read`, `write`,
and `admin`: write includes read, and admin includes write. These levels apply
only within the token’s scope. Reading includes state, media and events; writing
adds normal controls; admin adds configuration and meta-actions such as enabling
and disabling. A token reaches one device, every device, an existing group, or
a definition written in the group builder's own syntax — resolved by
the same code that decides what "All Cameras" means, so `room = Kitchen` keeps
meaning the kitchen as devices move into it.

```sh
bun run ht tokens                                                   # what exists, and when each was last used
bun run ht tokens issue "Kitchen tablet" --can write --for room:Kitchen
bun run ht tokens issue "Matter bridge" --can write --for group:automatic:switches
bun run ht tokens issue "Gate administrator" --can admin --for device:gate-relay
bun run ht tokens revoke <id>
```

The token is shown once and stored only as a SHA-256 hash; the server cannot
reproduce it. Browsers exchange one for an `HttpOnly` cookie at `/sign-in`, and
a browser that cannot paste (the Kindle) takes it once as `?token=…`, which is
moved to the cookie and stripped from the URL. `/settings/tokens` is the same
list in the UI. Full details, including what is deliberately not covered yet,
are in [docs/API_TOKENS.md](API_TOKENS.md).

## Secrets

Credentials never go in `devices.yml`, which is served by the API, or in
committed files. The normal local store is `.hometruth/secrets.yml`, mode 0600,
inside the private installation. Some integrations also accept protected
environment values; see [secret storage](REPOSITORIES.md#local-credentials).
This example shows the store's shape with placeholder values:

```yaml
schemaVersion: 1
devices:
  example-camera: { onvif: { username: admin, password: "…" } }
vendors:
  tkenpro: { account: { profile: cloudedge, email: "…", password: "…" } }
network:
  unifi: { apiKey: "…" }
api:
  cli: { token: "ht_…" }
```

A model declares what an instance needs (`secretsSchema`, shown by
`GET /api/models`), and the server validates each `devices.<id>` entry against
it at start-up, naming the entry when something is missing or misspelled. The
camera settings form saves the app account under `vendors.tkenpro` and the
ONVIF login under the camera the page is for. `GET /api/devices/<id>` reports
which secret keys an instance has, never their values.

```sh
bun run ht secrets list
bun run ht secrets set devices.example-camera.onvif.password   # value from a prompt or stdin
bun run ht secrets import   # one-time move from .env.local / camera-setup.json
```

The first start without a secrets file runs the import itself. After that the
`TKENPRO_*`, `ONVIF_*`, and `UNIFI_*` variables in `.env.local` are no longer
read by the server; delete them once you have checked the file.
