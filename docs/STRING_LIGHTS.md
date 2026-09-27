# StringLight devices

A `StringLight` is a physical linear array of `LightDevice` objects, ordered
from its controller to the tail. Each bulb is a separately provisioned device:
it has a stable ID, name, room, API document, control namespace, and page.
Renaming a bulb does not change its index or ID. It remains usable as a reference
from another device or automation.

The parent exposes a `stringLight` capability with whole-string power,
brightness, RGB color, fixed warm white, `getState`, and `getLights` methods.
It does not expose a `light` capability. In TypeScript, `string.lights[0]` and
`string.at(0)` return the first actual Light device, not a color value or a group.
`string.getLights()` returns ordered `{ id, name, index }` references for JSON
callers. `object.parent` on each child identifies the string and its zero-based
position. The UI numbers bulbs starting at 1 and links back to the parent.

## Govee H7021

Configure the number of bulbs actually present in your string. The inventory lists all
bulbs explicitly; shortened configurations are permitted. The order must agree
with every bulb's `stringId` and `index`. Missing, duplicate, or mismatched bulbs
are rejected when provisioning. All entries may appear in any file order.

```yaml
# Abbreviated two-bulb example. List every installed bulb in physical order.
devices:
  - id: patio-string
    name: Patio string lights
    model: govee-h7021
    config:
      host: 192.168.50.80
      deviceId: "AA:BB:CC:DD:EE:FF:00:11" # From the LAN scan, not the Wi-Fi MAC
      lights: [patio-bulb-01, patio-bulb-02]
  - id: patio-bulb-01
    name: Patio bulb 1
    model: govee-h7021-bulb
    config: { stringId: patio-string, index: 0 }
  - id: patio-bulb-02
    name: Patio bulb 2
    model: govee-h7021-bulb
    config: { stringId: patio-string, index: 1 }
```

Enable LAN Control in Govee Home if the controller does not answer. HomeTruth
sends discovery to UDP 4001 and controls/status queries to UDP 4003, and receives
replies on UDP 4002. Only private IPv4 controller addresses are accepted.
No cloud account or credentials are used. Discovery checks the configured SKU,
Govee device identity, and IP before controlling it. Writes are serialized and
followed by status checks for aggregate controls. Segment and scene commands
have no LAN acknowledgment, so their state is explicitly marked as commanded
or submitted, without claiming hardware confirmation.
Only the controller entry should carry the top-level Wi-Fi `mac`.

The parent page is `/string-lights/<name-slug>`; each bulb has a normal
`/lights/<name-slug>` page. The home page shows the parent, whose page lists its
bulbs. `/api/devices` and the CLI list all devices independently.

```sh
bun run ht patio-string get-lights
bun run ht patio-string state
bun run ht patio-string brightness 40
```

## White mode is separate from color

H7021 has fixed **2700K warm-white LEDs**, not a tunable white-temperature
range. The parent page offers an explicit “Set whole string to warm white”
button instead of a temperature slider. This replaces all bulb colors and
stops the current show. It does not warm or cool an existing RGB pattern.

The API retains `setColorTemperature(2700)` for selecting warm white. Its
advertised minimum and maximum are both 2700; other values are rejected
before any light command is sent or active sequence is cancelled. Govee can
echo arbitrary requested Kelvin values in status, but these are not evidence
of tunable white hardware; any white-mode read is normalized to 2700K.

## Individual bulb controls

H7021 RGB segment commands use the local `ptReal` envelope and a linear
address bitmask. Physical validation covers only a subset of bulb addresses;
do not assume complete-string verification from that coverage. Commands do not detect or repair failed bulbs. Inventory length and physical
response must be checked for the configured string; successful transmission
does not prove every bulb responded.

Each bulb supports `turnOn`, `turnOff`, `toggle`, `setColor`, `setBrightness`,
and `getState`. Brightness uses RGB attenuation relative to the whole string's
master brightness. The native segment brightness command at zero left a visible
glow in testing, so off sends RGB black. Per-bulb white temperature is not
advertised. A bulb's first command explicitly initializes its color to white
and relative brightness to 100%, except where that command specifies another
value. Subsequent commands preserve that bulb's last requested color and level.
Toggle is unavailable until there is a known last command.

The LAN API has no individual bulb readback. Each bulb remains `unknown` in
hardware availability, even when commands succeed; a failed bulb must not be
shown as online. `stateSource: "commanded"` and `commandedAt` distinguish stored
requests from observations. The UI says “Last command.” App changes cannot
update these values. Setting a whole-string color or starting a show clears
stored bulb states. Child commands never substitute a whole-string write.

```sh
bun run ht patio-bulb-01 color '#ff6000'
bun run ht patio-bulb-01 brightness 30
bun run ht patio-bulb-01 off
```

## Static scenes and animated shows

HomeTruth distinguishes **Scenes**, which are static arrangements in physical
bulb order, from **Shows**, which change over time. The StringLight page previews
each static palette across the configured bulbs before **Apply scene** sends it.
Eight scenes repeat RGB colors: Candy cane, Holiday colors, Ocean colors, Sunset
colors, Forest colors, Lavender colors, Rainbow colors, and Warm glow. For example,
Candy cane sets bulbs 1, 3, 5, … red and bulbs 2, 4, 6, … white. RGB white in a
scene is separate from the whole-string warm-white mode.

`getScenes` returns `{ id, name, pattern: "repeat", colors }` definitions.
`applyScene` takes a scene ID, cancels pending show steps, turns the string on
if necessary, and sends one static arrangement without a timer. Master brightness
is retained. Equal colors share a bulb mask, so the arrangement fits in one LAN
datagram. Each child's state records its requested color at full relative
brightness; it remains explicitly commanded, not hardware-confirmed.

The **Shows** section contains 40 Govee presets whose SKU-specific definitions
include explicit animation speed metadata, plus six HomeTruth sequences: Seaside,
Stargazing, Enchanted garden, Four seasons, Winter holidays, and Haunted patio.
A native animation runs on the controller. A sequence loops through several
preset effects, with a configurable 10–600 seconds per step; this interval is
not animation speed. The server must remain running to advance sequences.
Bundled definitions need neither an API key nor a cloud connection to play.

Govee calls all 51 presets "scenes." Classification here uses the catalog's
`lightEffects[0].speedInfo.supSpeed` metadata, not preset names. Eleven presets
lack that flag and remain in **Other Govee presets**, with their motion explicitly
unclassified. Missing speed controls do not establish that a preset is static.
The binary parameters contain more information, including color, brightness and
movement fields, but this is not yet a complete, validated motion decoder for
H7021. Physical animation verification currently covers Wave only.
`getPresets` and `applyPreset` keep the unclassified presets accessible separately.

`getShows`, `playShow`, and `stopShow` belong to the parent `stringLight`
capability. Show definitions use `kind: "animation" | "sequence"`; sequences
list preset IDs in `steps`. Starting another show replaces the current sequence.
Stop restores the previous HomeTruth static scene when known, otherwise the last
reported solid color, master brightness and power from before the first show.
It cannot reconstruct an unknown prior app preset or arbitrary per-bulb pattern.
Whole-string brightness can be adjusted while a show runs. Applying a static
scene, a bulb command, whole-string color change, or power-off cancels further
sequence steps. Reconfiguration/shutdown stops an active show and restores its
saved settings; a static arrangement needs no running server. A network error
stops advancing a sequence and is shown on the page; an animation already running
on the controller may continue until a stop/manual command reaches it.

```sh
bun run ht patio-string get-scenes
bun run ht patio-string apply-scene candy-cane
bun run ht patio-string get-shows
bun run ht patio-string play-show wave
bun run ht patio-string play-show '{"id":"stargazing","stepSeconds":60}'
bun run ht patio-string stop-show
bun run ht patio-string get-presets
bun run ht patio-string apply-preset night
```

The API uses the standard control route, for example:
`POST /api/devices/:id/capabilities/stringLight/controls/applyScene` with body
`{"value":"candy-cane"}`, or `controls/playShow` with body
`{"value":{"id":"seaside","stepSeconds":45}}`.

`object.capabilities.stringLight.state.scene` reports a submitted static scene
in `sceneId`. `state.show` reports `showId` (or an unclassified `presetId`) and the
current `effectId`. `submitted` means the command was sent; `running` means
HomeTruth's sequence runner is active, not that each bulb acknowledged playback.

Packet formats and validation live in `src/protocols/govee/`. Personal
investigation journals and captures are excluded from the public release.
