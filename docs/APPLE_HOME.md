# Apple Home bridges

Open **Bridges** in HomeTruth to create independently paired HomeKit and Matter
bridges. New bridges start empty. Each bridge has its own page:

- **In Apple Home** lists every accessory the bridge exports, grouped by the item
  it comes from. Edit **Name in Apple Home** to rename an accessory; clear the
  field to go back to the device's own name. **Shows as** changes the accessory
  type where another type carries the same characteristics, for example a plain
  on/off relay as a Switch, Outlet or Light. A dimmable light stays a Light.
  **Leave out** drops one accessory, such as a battery sensor, while the item's
  other accessories stay shared. **State** shows whether HomeTruth currently has
  the state Apple Home needs.
- **Add to Apple Home** lists what can still be shared, by room. Search by name,
  room or accessory type and choose **Add**. Capabilities of a device and items
  that need a custom mapping appear when you tick the option above the list.

An item may belong to several bridges. On an element's page, the **Apple Home**
section adds or removes it from each bridge. Pair each bridge once in Home on an
iPhone or iPad; its accessories then appear in Home. TVs and receivers use the
separate pairing codes shown on their bridge page.

Renaming, retyping or leaving out an accessory restarts only that bridge and
keeps its pairing and accessory identity. Apple Home may keep showing a name it
already has; if it does, rename the accessory in the Home app.

Bridge configuration and pairing codes require site administrator access. Keep
HomeTruth running on an awake host on the same local network as the Apple home.
Use Node.js 24 and the pinned dependencies. Cameras also require ffmpeg with
H.264 encoding and SRTP support. Each bridge runs in a separate supervised Node
process; device access uses a private parent/child channel, not a network API token.

## Accessory types

HomeKit mappings cover lights, switches, outlets, fans, air purifiers, heaters and
air conditioners, humidifiers and dehumidifiers, thermostats, locks, garage doors,
doors, windows, blinds, slats, faucets, valves and sprinklers, irrigation systems,
security systems, speakers, TVs/receivers, programmable buttons, doorbells, video
doorbells and cameras. Sensor profiles cover temperature, humidity, ambient light,
occupancy, motion, contact, leaks, smoke, carbon monoxide, carbon dioxide, air
quality, batteries and filter maintenance.

Matter mappings cover switches/outlets, temperature, humidity, ambient light,
contact, motion/occupancy, and robot vacuums/mops. Use HomeKit for the other
profiles. A bridge accepts only the profiles its protocol implements. The current
catalog contains 40 profiles; required characteristics, ranges and enums come from
the pinned HAP library, with additional momentary-button and Matter vacuum profiles.

Apple determines how each service appears in Home; some secondary services have
limited UI, and supported Matter types depend on the Apple OS and home hub.
These are software accessory adapters, not certified accessories. Apple may show
an uncertified-accessory notice during pairing. See Apple's
[accessory catalog](https://www.apple.com/home-app/accessories/),
[Matter support](https://support.apple.com/en-us/102135), and the
[HAP implementation documentation](https://developers.homebridge.io/HAP-NodeJS/).

This does not implement AirPlay media transport, Home Key credentials,
manufacturer-specific functions, camera two-way audio or HomeKit Secure Video
recording. Camera support is JPEG snapshots and H.264 live video. A camera with
only snapshots cannot provide a live stream. Camera sources must come from an
existing HomeTruth camera capability; arbitrary media URLs cannot be entered in
bridge mappings.

## Automatic settings

Automatic mappings use native light, switch, motion, occupancy, contact, camera,
TV and speaker capabilities, supported measurements, groups with shared controls,
and service/automation enable switches. Speakers expose playback and volume
controls; this does not make them AirPlay receivers.

HomeKit automatically shares buttons, including workflow buttons, as **Button
(tap to run)** tiles. Turn the tile on to press its button once. The tile returns
to Off after HomeTruth accepts the press; returning to Off does not send an Off
command to the device or cancel the workflow. The tile represents a trigger, so
its Off state does not report whether a device is off or a workflow has finished.
Any later actions and waits remain part of the workflow. Matter does not support
this button profile.

Temperature, humidity, battery, CO₂, PM2.5 and illuminance measurements map to
corresponding Apple services. Units must agree. VOC/NOx indexes are not pollutant
mass concentrations and are not silently converted. The automatic battery-low
threshold is 20%; the CO₂ alert threshold is 1000 ppm. PM2.5 air quality uses
breakpoints of 12, 35, 55 and 150 µg/m³. These are configurable product conventions,
not medical or life-safety assessments; use custom mappings for different
thresholds or a device's own alarm state. Do not substitute a software estimate
for a certified safety alarm.

Rooms remain independent in Apple Home. Assign the desired Apple Home room when
pairing an accessory or in its settings there. HomeTruth's room names do not
create or synchronize Apple Home rooms.

## Configurable mappings

Choose **Customize mapping** on a shared item (or **Set up mapping** in the add
list), select an Apple accessory type, and map its
required characteristics to HomeTruth properties and controls. Several accessory
mappings can belong to one element. Optional characteristics are opt-in. For each:

- For **Button (tap to run)**, choose the button to press. No state source or
  separate On/Off controls are needed.
- Choose a state source and, for an object source, its JSON Pointer path (for
  example `/currentTemperature`). A single property uses a blank path.
- Select the control that receives values, or use separate controls for enum
  values such as locked/unlocked or on/off. A blank per-value control argument
  calls that action without an argument.
- Configure numeric scaling, unit conversion or explicit value translations when
  the source and Apple use different representations. Read and write conversions
  are independent; enter the conversion in the direction each operation travels.
- Use fixed values only for configuration fields. Measured state cannot be fixed
  to make an unavailable device appear healthy.
- For **Programmable button** and doorbell events, choose a button capability as
  the event source. These forward successful presses to Apple Home automations,
  including repeated presses; they cannot be tapped in Home to run the button.
  For cameras and video doorbells, choose an existing camera media source.

Controls continue through HomeTruth's validation and confirmation requirements.
A control that requires interactive confirmation will fail through a bridge;
bridges do not silently bypass that requirement. Ordinary accessory commands are
followed by observed state; missing/invalid readings and unreachable devices
produce communication errors. Momentary buttons acknowledge the press and reset
their tile; they do not report physical device state. Creating or editing a
mapping never operates its controls.

## Persistence and operation

Nonsecret selections and mappings live in the installation's
`.hometruth/bridges.sqlite`. Each bridge's private keys and pairing state live in
`.hometruth/bridges/<bridge-id>/`, outside public source. Back up these paths with
the installation using encryption; never commit pairing state or pairing codes.
Renaming a bridge or accessory preserves its identity. Changing mappings restarts
only that bridge, preserving pairing. Deleting and recreating a bridge creates a
new identity; remove the deleted bridge from Apple Home as well.

A bridge supports up to 140 accessories. Create additional bridges for larger
installations (up to 32 bridges). HomeKit reserves a block of TCP ports starting
at 52100 for each bridge and its separately paired TVs. Matter uses separate UDP
ports starting at 5550. Bonjour/mDNS uses UDP 5353. Allow the relevant local
traffic between the host and home controllers; no public forwarding is needed.

HomeKit uses IPv4 and IPv6 by default. If an installation's IPv6 addresses are
advertised but unreachable from Apple Home controllers, set
`"HOMETRUTH_HOMEKIT_IPV4_ONLY": "true"` in the installation's `site.json`
`environment` and restart HomeTruth. Only the literal value `true` enables this
option. It binds every HomeKit bridge and separately paired accessory to IPv4
and suppresses their IPv6 advertisements. Matter is unaffected and still requires
working IPv6 connectivity.

Each bridge page shows connection state, per-accessory reachability, pairing
codes and shared items. It follows the bridge over `GET /api/bridges/:id/stream`,
an admin-only event stream that sends a `status` frame when anything changes; the
page does not poll. **Open pairing window** reopens initial Matter pairing; sharing an already
paired bridge is done in Apple Home. Disabling a bridge preserves its keys while
stopping advertisement and control. A missing mapped element stops that bridge
with a visible error until its mapping is fixed or removed. Other bridges remain
independent.

For development, run `bun test src/bridges` and
`node --test --test-force-exit tests/bridges/protocol.node.mjs`. Protocol tests
use temporary synthetic accessories, never installation devices. They cover
profile construction, command routing/failure, reachability, repeated events and
identity persistence. A real Apple Home pairing and each physical device's media
and control behavior still require installation verification.
