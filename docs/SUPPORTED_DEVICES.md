# Supported devices

HomeTruth has a limited inventory of implemented device models. This catalog
is a starting point, not a promise that every firmware version or related
product works. Check each model's configuration, supported actions and guide
before provisioning. Some features are experimental or require vendor accounts,
modified firmware, pairing, a bridge, or a particular host platform.

On a running installation, `bun run ht ls model --json` returns the model
registry, configuration schemas and secret-field names. The source registry is
[`src/registry.ts`](../src/registry.ts); [generic inventory examples](../devices.example.yml)
show configuration shapes. They contain no installation inventory.

| Device or integration | Model IDs | Setup and scope |
| --- | --- | --- |
| Bosch NITP060UC | `bosch-nitp060uc`, `cooktop-child-lock` | [Local Home Connect](BOSCH_HOME_CONNECT.md); appliance reads, bounded lock/timer controls, optional child-lock switch. |
| TKENPRO 2K pet camera/treat dispenser | `tkenpro-2k-pet-camera-treat-dispenser` | [Camera guide](TKENPRO.md); local and cloud paths have different prerequisites and limits. |
| Wyze Cam v3 | `wyze-cam-v3` | [Firmware and local access](WYZE.md); requires a supported local firmware route. |
| Local RTSP camera or stream | `rtsp-camera` | [RTSP setup](RTSP.md); browser video and JPEG snapshots through ffmpeg, with optional RTSP credentials. |
| Tactacam REVEAL | `tactacam-reveal` | [Photo archive](REVEAL.md); cloud account and polling, not a LAN live-video adapter. |
| Shelly Plus 1 | `shelly-plus-1` | Local relay RPC; see inventory examples. Other models require compatibility checks. |
| Lutron Caséta | `lutron-caseta-switch`, `lutron-caseta-dimmer` | Bridge/device addressing as declared in the model schemas and inventory examples. |
| Elgato Key Light Air | `elgato-key-light-air` | Local light control; see inventory examples. |
| Philips Hue lights and accessories | `hue-light`, `hue-entertainment-light`, `hue-motion-sensor`, `hue-switch` | [Hue setup](HUE.md); bridge registration, resource IDs and optional Entertainment configuration. |
| Govee H7021 string lights | `govee-h7021`, `govee-h7021-bulb` | [String-light guide](STRING_LIGHTS.md); per-bulb and effect support have limits. |
| Broadlink RM4 Pro | `broadlink-rm4-pro` | Local IR/RF learning and transmission; learned signals do not provide appliance state. |
| ESP32/nRF24 radio bridge | `esp32-nrf24-bridge` | Requires firmware implementing the declared bridge API; not a generic adapter for arbitrary RF devices. |
| Sonos | `sonos`, `sonos-group` | Local speaker/group control; capabilities depend on the device and group configuration. |
| Samsung The Frame | `samsung-frame` | [TV guide](SAMSUNG.md); local remote and art-mode channels require TV authorization. |
| Aqara | `aqara-hub-m2`, `aqara-presence-sensor-fp2`, `aqara-door-window-sensor` | [Aqara setup](AQARA.md); HomeKit or supported Matter pairing paths, with commissioning limits. |
| Ring bridge and smart lights | `ring-bridge`, `ring-smart-light` | [Ring setup](RING.md); requires the Ring cloud. |
| AirGradient ONE | `airgradient-one` | Local sensor readings; see inventory examples. |
| Govee H5075 | `govee-h5075` | [Bluetooth sensor guide](GOVEE.md); the current receiver requires macOS. |

Logical models combine configured devices: `light-group`, `synthetic-switch`,
`action-button`, `workflow-button` and `optimistic-switch`. See
[devices and composites](DEVICES.md). These are software capabilities, not
additional hardware support.

Use the [add-device skill](../skills/hometruth-add-device/SKILL.md) to configure
an existing model or implement a new one. If the protocol is undocumented, the
[investigation skill](../skills/reverse-engineer-iot-device/SKILL.md) helps assess
what is possible; it does not guarantee a local path. Keep raw research private
and publish only finished adapters, synthetic tests and reusable documentation.
