# URLs and element relationships

Element pages use `/type/name-with-hyphens`. The display name supplies the
slug. REST, the shared TypeScript client, and the CLI use current friendly
addresses. Stable configuration IDs remain internal references for saved groups,
automations, and Kindle widgets.

| Element | Page prefix |
| --- | --- |
| Physical or composed switch; switch based on a saved group | `/switches/` |
| Individual light | `/lights/` |
| Camera, including a camera with a treat dispenser | `/cameras/` |
| Button collection / editor | `/buttons` |
| Button | `/buttons/<name>` |
| Speaker | `/speakers/` |
| Device composed of typed sensors | `/devices/` |
| Sensor capability page | `/sensors/` |
| Hub | `/hubs/` |
| IR/RF blaster | `/blasters/` |
| Saved group, light group, or speaker group | `/groups/` |
| Service | `/services/` |
| Room | `/rooms/<name>` |

Device settings, device logs, and camera light-sync editors append `/settings`, `/log`,
and `/light-sync` to an element's page. A saved group's switch has controls
and settings pages; membership and room editing live on its source group.

## Names and collisions

Names are lowercased, accents normalized, and spaces/punctuation replaced
with hyphens. Non-Latin letters are retained and URL-encoded. Names that
normalize to the same slug within a type receive a deterministic eight-digit
hex suffix derived from the element's source and stable ID. Suffixes grow
if necessary. URLs do not depend on inventory ordering.

One saved group switch takes the short switch name when it shares a name
with individual devices. The individual devices receive suffixes. Group pages
use the current display name, independently of the configuration ID.
Reserved routes such as `/groups/new` cannot be claimed by an element's name.
Disabling a group's switch view removes it from the current page directory.
Collision suffixes are recalculated from the remaining current elements.

For a hypothetical group and relay both named Office Lights:

| Element | Canonical page |
| --- | --- |
| Switch controlling the saved group | `/switches/office-lights` |
| Source group containing a relay and two lights | `/groups/office-lights` |
| Individual relay (`example-relay`) | `/switches/office-lights-<identity-suffix>` |

The Lutron circuit and the group switch remain separate controls. Turning
on the individual circuit addresses that circuit; turning on the group
switch addresses every group member.

## Current URLs and renaming

HomeTruth is greenfield. Only current page URLs are supported. There are no
old-URL redirects, ID aliases, or historical name/hash lookups. Removed URLs,
unknown IDs, and unsupported subpages return 404.

A name change updates the page URL. API clients use the returned `page` value;
the rename form navigates to that value's settings page after saving. Callers,
fixtures, and documentation must be updated when a URL contract changes.

The inventory at `/api/inventory` publishes each element's current `address`.
Use it in REST paths, for example `/api/switches/exhaust-fan`, in the shared
client as `ht.devices["exhaust-fan"]`, and in commands such as
`ht exhaust-fan status`. Generic element metadata uses
`/api/elements/<address>` and its command guide uses `/elements/<address>`.
Internal IDs, graph keys and UUIDs in metadata are not alternate request targets.

Agent integrations use installation-wide URLs: `/mcp` for the MCP server and
`/SKILL.md` for the reusable HomeTruth skill. Element pages include the current
friendly address in their copyable installation prompts. They do not create
separate MCP servers or skill downloads. Element-specific schemas remain at
`<page>/openapi.json`.

Top-level addresses derive from the current page slug. Nested elements include
their owner context and kind; collisions are disambiguated deterministically.
Read the published address instead of guessing it. Renaming updates API
addresses as well as page URLs; the previous address returns 404. Page routes
come from `PageDirectory`; API addresses come from the current topology's
address directory.

## Relationship links

- A group switch identifies and links its source group and individual members.
- A saved group links its switch and members, including plain, non-underlined
  member links in the shared-properties table.
- Individual member pages link back to their groups and group switches.
- Composed switches, buttons, and light groups link their inputs; those inputs
  link back to the elements that use them.
- Speaker groups link their speakers and controller; sensors link their hub,
  and hubs link back to their sensors.
- Services link their subject devices, device pages link related services,
  and event subjects link to the relevant device page.
- Lists, network views, settings, and Kindle's element picker use canonical
  pages rather than constructing page URLs from IDs.

Route tests cover collisions, reserved paths, rejection of removed URLs, relationship
links, and the separate physical/group control targets. Browser checks cover
the linked pages and their behavior on desktop and mobile.

## Tags and primitive metadata

Unnamed tags use `/tags/<value-slug>`; named tags use
`/tags/<name>/<value-slug>`. Rooms are the special case: their index is `/rooms`
and their pages use `/rooms/<value-slug>`. The Tags list excludes rooms.
Tags retain an immutable UUID for stored assignments, and API operations use
the tag's published friendly address. Page slugs follow the name normalization
rules above. Renaming removes the old page URL. `/tags?view=elements` browses
the shared element catalog, and each
primitive has a metadata/tagging page at `/elements/<address>`. Its existing
control page remains linked from that metadata page. Stable nested keys remain
internal; public addresses include the owner's friendly context.

## Saved event filters

Event viewer pages use `?filter=<name-slug>` for a saved Filter and
`editing-filter=<name-slug>` for a draft based on it. Names follow the same
normalization rules as element pages. Colliding names receive deterministic
suffixes; renames remove old URLs without redirects or ID aliases. Filter API
responses provide the current `slug` separately from the stable Filter ID.
API operations and event API `filter` parameters continue to use IDs.
See [Filters](FILTERS.md) for daily time ranges and saved selections.
