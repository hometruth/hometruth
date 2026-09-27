# Hue devices

Configuration and runtime paths in this guide are relative to your private
installation directory. Examples use fictional device names and addresses.
See [repository layout](REPOSITORIES.md) for command and storage conventions.

To emulate a Hue bridge and mirror ordinary or Entertainment color changes to
other lights, run the separate [Hue bridge proxy service](HUE_PROXY.md).

HomeTruth uses the bridge's local CLIP v2 API. Bridge credentials remain in `.hometruth/secrets.yml` under `vendors.hue`. Optional Entertainment streaming can share the bridge with ordinary lighting controls.

Run `bun run hue:discover` to inventory all paired physical devices and their Hue room names. Add missing devices with `bun run hue:discover --apply`. Repeating discovery preserves existing device ids, names, and Entertainment channels. The running app reloads `devices.yml` automatically. Discovery reads the bridge inventory; it does not pair new Zigbee devices or change Hue rooms and automations.

- `hue-light`: ordinary bulbs, including lights outside an Entertainment area. Discovery records color and temperature support and each light's temperature bounds. White-only bulbs offer brightness without unsupported color controls.
- `hue-entertainment-light`: lights configured with Entertainment streaming channels. Ordinary color changes use CLIP; active streaming uses DTLS. Stop light sync before setting a white temperature.
- `hue-motion-sensor`: motion, temperature, illuminance, and battery readings, plus the motion-sensor capability.
- `hue-switch`: dimmers and tap dials, with battery and timestamped last button/dial reports. These are physical inputs, so they do not expose a simulated on/off or press action. Polling shows the latest report and is not a lossless event stream for automation triggers.

Light pages offer a color picker and use the light's actual white-temperature range. Kelvin values are converted to the bridge's integer mirek representation, so 2700 K reads back as approximately 2703 K. Color selection preserves the separate dimmer setting; black turns the light off. Colors outside a bulb's gamut are clipped by the bridge. Color readback is approximate and uses matched RGB/xy conversion matrices without dimmer-induced hue shifts. In color mode no white temperature is invented.

Dashboard reads share a short-lived bridge snapshot to avoid rate limiting with many lights. Successful writes invalidate it. Disconnected lights and accessories are shown as offline even when the bridge retains old state. Motion/light/temperature readings are only reported when the bridge marks them valid.
