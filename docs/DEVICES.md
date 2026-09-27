# Devices, groups and controls

All configuration and runtime paths in this guide are relative to your private installation directory. Commands run from the public source checkout and use `../hometruth_private/`; use `bun run site <private-directory> <command>` for another location. Device names and addresses in examples are illustrative.

## Configure an inventory

Start from the private template's empty `devices.yml`. Copy only the examples
for devices you intend to configure, replacing addresses and identifiers with
your own. Do not copy the entire example inventory. The
[supported-device catalog](SUPPORTED_DEVICES.md) describes implemented models;
`GET /api/models` and `ht ls model --json` expose exact configuration schemas.

```yaml
schemaVersion: 2
devices:
  - id: office-relay
    name: Office relay
    model: shelly-plus-1
    config: { host: 192.168.50.40 }
```

`model` selects an implementation and `config` contains nonsecret connection
settings. Credentials belong in the private secrets store. Local transports
validate LAN hosts; cloud adapters declare their own account and device fields.
See the [setup skill](../skills/hometruth-setup/SKILL.md) and
[object model](OBJECT_MODEL.md).

## Inspect and operate

- `GET /api/models` lists every model with its capabilities and config schema.
- `GET /api/devices` lists the provisioned instances with their model and status.
- `GET /switches` inventories every binary Switch, provides On/Off/Toggle
  controls, and can build an `optimistic-switch` by selecting two configured
  Buttons. Saved Broadlink commands also appear as Button choices; selecting
  one materializes it as an `action-button` device in the same atomic edit.
  `POST /api/switches` is the narrow JSON write path behind that builder; it
  validates and appends the new logical devices to `devices.yml`,
  preserving the rest of the human-authored YAML.
- `GET /api/devices/<id>` returns one instance as model + config + `controls`
  (the names it can be asked to do) + its current object document
  (`homeTruthObjectSchema`: state and actions per capability).
- Every device control page has an **Edit name** panel. It calls `POST
  /api/devices/<id>/name` with `{"name":"…"}`; the stable id is unchanged and
  the narrow writer updates only that entry in `devices.yml` before the
  live site reloads.
- `POST /api/devices/<id>/controls/<control>` with `{"value": …, "confirmed":
  true}` is the one write path. A device has one flat control namespace:
  `toggle`, `pan.left`, `dispense` by their bare names, and
  `<capability>.<control>` only when two capabilities on the same device share
  a name (`infraredBlaster.send` vs `radioFrequencyBlaster.send`; a bare `send`
  there answers `ambiguous_control`). The
  capability-specific route is also documented in the generated API. `POST /api/devices/<id>/reboot` restarts a device whose model can.
- `GET /api/switches/<id>/state` reads a binary switch's `availability`,
  `value`, and `observedAt` with read permission. The client method is
  `state()` and the CLI command is `ht <id> state`. Switch reads are not
  accepted by the POST control routes.
- `GET /api/devices/<id>/enabled` returns `true` or `false` without reading
  the hardware. `POST /api/devices/<id>/enable` and `POST
  /api/devices/<id>/disable` persist the setting and return the resulting
  boolean. The client methods are `enabled()`, `enable()`, and `disable()`;
  the CLI commands are `ht <id> enabled`, `ht <id> enable`, and `ht <id> disable`.
- `GET /api/devices/<id>/events` returns the newest 200 events about that
  device across HomeTruth and every service that tags events with its id.
  `GET /api/devices/<id>/events/stream` is the live SSE tail. Every device
  page has a **Log** tab at `<page>/log` (for example, `/switches/porch-relay/log`);
  the in-process device portion is a ring buffer and is intentionally cleared when the server restarts.
- Live state. `GET /api/state/stream?node=device/<id>&node=group/<id>&tier=live|glance`
  is one Server-Sent Events stream per page carrying the current record of
  each named node (`device/<id>` is the device's validated object document,
  `group/<id>` a group switch): a `hello` frame, the snapshot, then one
  `state` frame per changed node and one `observed` frame per flush for the
  polls that changed nothing. The server reads only nodes some stream names, at the
  `live` tier (5 s, device pages) or `glance` (20 s, lists), no faster than
  each capability kind's floor. A read that fails publishes a fault beside the
  last good value. Switch, light, button, home, and list pages render `ht-*`
  elements bound to those nodes and update without reloading.
- `GET /api/devices/<id>/network` finds the client in the managed Wi-Fi
  controller and reports its current address. When a device entry has a
  top-level `mac`, UniFi lookup uses that stable identity and the device page
  warns if the current address differs from `config.host`.
- `POST /api/devices/<id>/network/reconnect` drops that client's managed
  Wi-Fi association so it reconnects and requests its fixed DHCP address
  again. The same action is available as `ht reconnect <id>` and as a
  button on every device page.
- `POST /api/network/rescan` looks every device with a LAN address up in the
  gateway's client table by its saved `mac`, on whatever subnet DHCP put it,
  and rewrites `config.host` in `devices.yml` to match. It makes no DHCP
  reservation, so a device that roams between networks is simply followed. A
  device with no saved `mac` that still answers at its address gets that
  client's MAC saved so the next move can be followed; one that has moved
  without a saved `mac` has to be picked on its Settings tab. The same action
  is `ht rescan` and the **Rescan network** button on the device list;
  `POST /api/devices/<id>/network/rescan`, `ht rescan <id>`, and
  **Find on network** on a device's Settings tab do it for one device.

When a device document first reports `offline`, HomeTruth automatically makes
one network-reconnect attempt and reads it once more after DHCP has had time to
settle. It will not repeatedly bounce a device that remains offline; a
successful read rearms one attempt for a later outage. On UniFi, current,
fixed, and last-known client addresses are matched as a compatibility fallback.
Adding the device's top-level `mac` is preferred: a device currently on a
self-assigned `169.254/16` address is then found without relying on its IP.

The home page at `/` lists the devices in that file; each links to a typed,
name-based page such as `/switches/porch-relay` or `/cameras/front-door`.
Groups use `/groups/<name>` and switches based on groups have their own
`/switches/<name>` page linked to the source group and its members. Name
collisions receive a short hash suffix. Only current page URLs are supported;
removed URLs return 404. See
[URLs and element relationships](URLS.md) for the full policy. Configured cameras are always probed during discovery and matched
to what discovery finds by address, so they keep their id and name.

```sh
bun run ht                 # which install, and what is in it
bun run ht ls              # every device, with status
bun run ht ls group        # or group, service, model, scene, signal, schema, …
bun run ht find kitchen    # anything whose id, name or room matches
bun run ht ls model
bun run ht shelly-relay
bun run ht shelly-relay toggle
bun run ht watch shelly-relay
bun run ht reconnect desk-keylight
bun run ht living-room-blaster infrared-blaster.send 'JgBS…'
curl -fsS http://127.0.0.1:3000/api/models
curl -fsS http://127.0.0.1:3000/api/devices/shelly-relay
curl -fsS -X POST -H 'content-type: application/json' -d '{}' http://127.0.0.1:3000/api/devices/shelly-relay/controls/toggle
```

Set `HOMETRUTH_DEVICES` to point at a different file.

### Use a device from TypeScript

A device is an ordinary class: instance (id and name) plus the model's config.
Its capabilities' public methods are forwarded onto it by their bare names, so
the object reads the way the CLI does, and the generic paths the server uses
are there too.

```ts
import { ShellyPlus1 } from "./src/devices/switches/shelly-plus-1";

const relay = new ShellyPlus1({ id: "example-relay", name: "Example relay" }, { host: "192.168.50.40" });

await relay.turnOn();                       // forwarded from relay.switch.turnOn()
await relay.getState();                     // "on" | "off"
await relay.invokeControl("toggle");        // the JSON control namespace; the CLI uses friendly command names
relay.controls();                           // ["turnOn", "turnOff", "toggle", "getState"]
(await relay.describe()).status;            // the validated object document
```

### Compose devices

Choose **Create group** on the Devices page, name the group, and select any
two or more devices. The preview lists their shared controls and properties
before saving. Key Light Airs share power, brightness, and color temperature;
lights and binary switches share power. Devices without common controls can
still be grouped to inspect their individual readings.

Saved groups show **Mixed** when members disagree, with each member's value
beside it. Unknown or offline readings stay unknown. Group controls use the
intersection of the members' supported ranges and report each failed member
separately. Toggle turns a fully-on group off and any other group on.
Device names in the shared-properties table open their individual device pages.
The **Groups** navigation item lists saved device groups and existing speaker
and light groups, with links to their pages and the group builder.

Open **Edit members** on a saved group to add or remove devices. Search by name,
model, room, or device ID; checked devices stay selected when filtered out.
Review the updated shared controls and properties, then **Save members**.
Selected groups require at least two devices. The group's name and room stay intact;
if a new selection loses switch support, the editor warns that saving will
remove the group from Switches.

On a saved group's page, assign a **Room** to place the group under that room
on the Devices page. Groups with shared power state and On, Off, and Toggle
controls can enable **Show on Switches**. Their Switches entry controls every
member and retains Mixed and unknown readings.

**Automatic groups** use matching criteria instead of a saved member list. The
Groups tab includes **All Switches**, **All Lights**, All Cameras, All Speakers,
All Buttons, All String Lights, All Sensors, and separate motion, occupancy,
contact sensor, and hub groups. Built-in membership is read-only and does not
need configuration.

Choose **Create automatic group** from Groups, then choose **Tags to match**, a
**Room to match**, an **Element type / schema**, or a combination. Every selected
criterion must match, including every selected tag. For example, select the
Binary switch schema and `#foo` to group all switches with that tag; leave the
type blank to group all devices with that tag. The builder previews
matching devices and their shared controls; **Edit criteria** changes a saved
automatic group. Membership updates when devices are added, removed, moved
between rooms, change schemas, or gain or lose tags. Offline devices still belong. Empty and
single-device automatic groups are valid; empty groups have no controls.
Schema matching includes the device's object contract, capability contracts,
and individually typed sensors. All Lights matches the Light capability;
All Switches matches Binary switch. Light/speaker groups and synthetic scenes
are excluded from automatic selection to avoid controlling members twice.
Automatic groups do not hide their devices from the Devices page.
Tag matching uses the device's own assignments; tags on an individual control,
sensor, or parent group do not automatically tag its device. Criteria store tag
UUIDs, so renaming a tag preserves the rule. The picker shows its current slug.

These groups persist as a top-level `deviceGroups` list in `devices.yml`:

```yaml
deviceGroups:
  - id: desk-lights
    name: Desk lights
    members: [left-keylight, right-keylight]
    room: Office
    asSwitch: true
  - id: kitchen-lights
    name: All Lights in Kitchen
    criteria:
      room: Kitchen
      schemaId: https://hometruth.ai/schemas/light
  - id: tagged-switches
    name: Switches with foo
    criteria:
      schemaId: https://hometruth.ai/schemas/binary-switch
      tagIds: ["d91a5ac0-a44b-4b09-bd50-3fa221a4a6e2"] # Use an existing tag UUID.
```

Automatic definitions store `criteria` and never store `members`. The list API
returns the current resolved member IDs for all groups, including built-ins
whose IDs begin with the reserved `automatic:` prefix. Preview and creation
accept `criteria` in place of `members`; settings accept `criteria` to replace
an automatic group's matching rule. Room assignment (`room`) controls where the
group appears, while `criteria.room` controls which devices belong.
`criteria.tagIds` is a nonempty list of distinct existing tag UUIDs. Omit it to
match any tags. Preview, creation, and settings reject unknown tag references.

`POST /api/device-groups/preview` accepts `{ "members": ["id-1", "id-2"] }`.
`POST /api/device-groups` saves `{ "id", "name", "members" }`;
`GET /api/device-groups/:id` returns shared properties, available controls,
and individual readings. A reading carries `missingForSwitch` (any of
`power.on`, `power.turnOn`, `power.turnOff`, `power.toggle`) when that member
keeps the group from being a switch; `canSwitch` is false whenever one does.
Invoke a returned control id with
`POST /api/device-groups/:id/controls/:control` and `{ "value": ... }` when
needed (for example `power.turnOn` or `light.setBrightness`). Control responses
include `ok`, per-member `results`, and a refreshed `group` snapshot. Partial
failures return `ok: false`; successful members are not rolled back or retried.
`POST /api/device-groups/:id/settings` accepts `members` (2–100 unique device IDs),
`room` (a room name or `null` to clear it), and/or `asSwitch` (boolean).
Membership changes preserve other settings and clear `asSwitch` if the new
members are incompatible. Switch eligibility is checked before
enabling it. Enabled group switches expose their state at
`GET /api/device-groups/:id/switch` and accept `POST` to that path followed by
`/turn-on`, `/turn-off`, or `/toggle`. Once the members stop sharing every
switch control these answer `409` with `error.detail` naming the members that
fall short, and the switch page marks them in its member list.

Logical devices live in the same `devices.yml` inventory as physical
ones and may reference entries declared before or after them. A `light-group`
fans every method shared by all of its members out concurrently. For Hue
Entertainment lights, a grouped `setColor` is coalesced into one stream frame
containing all channels.

```yaml
  - id: studio-lights
    name: Studio lights
    model: light-group
    config:
      members: [hue-left, hue-center, hue-right]
```

A `synthetic-switch` maps its on and off states to independently chosen states
of two or more switch-like capabilities. Lights and binary switches are both
switch-like. `capability` may be omitted when a member has exactly one such
capability.

```yaml
  - id: recording-mode
    name: Recording mode
    model: synthetic-switch
    config:
      members:
        - { device: studio-lights, on: on,  off: off }
        - { device: tally-light,   on: on,  off: off }
        - { device: hallway-light, on: off, off: on  }
```

The synthetic switch reads as on only when every member matches its configured
`on` state. A partial or mixed scene reads as off; turning it off applies the
explicit `off` mapping. Composition cycles and missing device references are
rejected while provisioning.

The underlying grouping primitive is capability-independent: `groupMethods()`
accepts any two or more objects with a published `methods` list, exposes only
the intersection, and returns each member's result in member order. The
`light-group` model adds the light-specific state reduction and document on top.

### Tags on elements

Use **Tags** to organize devices, controls and other addressable elements.
Tags are name/value pairs with persistent UUIDs; rooms are single-valued tags
under the `room` name. Element pages provide assignment controls, and the CLI
can list, export and import the ontology. See [Tags](TAGS.md) for the current
contract, URLs and private storage policy.

### Buttons and optimistic switches

A `button` is a stateless press action. It has no on/off value and does not
claim that the appliance received or obeyed a command. An `action-button`
projects a fixed device control into that model. It can either invoke any
control with a fixed value, or refer to a Broadlink saved command by its stable
code id. Duration-aware buttons accept an optional hold per press; saved
commands use their saved default when no override is supplied.

```yaml
  - id: candles-on
    name: Candles on
    model: action-button
    config: { device: living-room-blaster, savedCodeId: "<saved-code-id>" }
  - id: candles-off
    name: Candles off
    model: action-button
    config: { device: living-room-blaster, savedCodeId: "<saved-code-id>" }
```

A `workflow-button` is also stateless, but its press starts a server-side
workflow. A workflow is a validated graph of action, delay, condition, and end
nodes. Edges are node ids, so a condition can branch and a workflow can loop;
the Button page shows the reachable graph as a nested state-machine view and
lets you edit it. A workflow may run actions on any configured device. Actions
that require the existing control-level confirmation gate can opt into that
gate with `confirmed: true`. For example:

```yaml
  - id: candles-cycle
    name: Candles cycle
    model: workflow-button
    config:
      workflow:
        start: on
        nodes:
          - { id: on, type: action, device: candles, control: turnOn, next: wait }
          - { id: wait, type: delay, durationMs: 300000, next: off }
          - { id: off, type: action, device: candles, control: turnOff, next: done }
          - { id: done, type: end }
```

Workflow runs are tracked separately from Button state. The default concurrency
policy replaces an active run when the Button is pressed again; `parallel` and
`ignore` are available in the workflow definition when a different policy is
needed. The **Buttons** page creates Workflow Buttons, and the Button page
exposes the workflow graph and editor.

The workflow API is `POST /api/buttons` to create one, `GET /api/buttons/<id>/workflow`
to read its graph and recent run status, and `PUT /api/buttons/<id>/workflow` to
replace the graph. The update path validates node ids, branch edges, target
devices, and target controls before it writes the inventory.

An `optimistic-switch` combines two Button devices. It remembers the last
successful button press, including a press made directly on either Button.
Before the first press its state is unknown unless `initialState` is configured.
Failed presses never update memory.

```yaml
  - id: candles
    name: Candles
    model: optimistic-switch
    config: { onButton: candles-on, offButton: candles-off, initialState: off }
```

Choose a **Room** on any device's page or on a card in **Switches**. Select an
existing room, choose **Add room…** and enter a name, or choose **No room**, then
save. Assignments are stored as `room` alongside `id`, `name`, and `model` in
`devices.yml`; the top-level `rooms` list keeps saved rooms available even
when empty. Room edits take effect after the live configuration reload.

Every switch's **Settings** page explains its definition: the exact requests
for On, Off, Toggle, and Refresh, the underlying hardware or member commands,
and links to the source devices and related groups. Button-pair switches show
their saved-command payloads and explain that Refresh reads remembered state.
Enabled group switches show their definition beneath the group’s switch
settings. The Switches list links directly to these settings.

The Matter bridge automatically publishes switch rooms as Fixed Label metadata
and refreshes it within 30 seconds. Apple Home room assignment is separate:
this bridge cannot create or move rooms in Apple's home database. Set the room
in Apple Home as well. See [room integration limits](MATTER_SWITCHES.md#rooms).

Because the result advertises the ordinary `binarySwitch` capability, the
Matter bridge discovers it automatically alongside physical relays and other
synthetic switches. Buttons remain HomeTruth actions rather than being
misrepresented as stateful Matter on/off endpoints.

A name two capabilities share is not forwarded (the RM4 Pro's `send` stays
`blaster.capabilities.infraredBlaster.send(…)`), and a device's own members
always win. A model wires this up with one line in its constructor,
`this.capabilities = this.expose({ binarySwitch: this.switch })`, plus an
interface merge (`export interface ShellyPlus1 extends CapabilityMethods<{
binarySwitch: ShellyGen2Switch }> {}`) so the forwarded methods are typed.
For a whole site, `Site.fromConfig(await loadDevicesConfig())` builds every
instance in `devices.yml` and `site.as("example-relay", ShellyPlus1)`
returns the typed device.
