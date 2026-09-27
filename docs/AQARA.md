# Aqara devices

Configuration and runtime paths in this guide are relative to your private
installation directory. Examples use fictional device names and addresses.
See [repository layout](REPOSITORIES.md) for command and storage conventions.

HomeTruth supports three Aqara models:

| Model id | Local observations |
| --- | --- |
| `aqara-hub-m2` | Matter or HomeKit bridge inventory; security system state via HomeKit only |
| `aqara-presence-sensor-fp2` | Occupancy per exposed zone, combined occupancy, illuminance |
| `aqara-door-window-sensor` | Contact open/closed, battery, and tamper when exposed by the M2 |

The door sensor uses its hub's connection. Its configured serial number must
match the bridge's reported serial number; accessory ids and names
are not stable enough to identify it. The FP2 is a separate Wi-Fi device, not an M2 child.

## Connection setup

Add the device entries to `devices.yml` using the examples in
`devices.example.yml`. For the M2 and FP2, use their `_hap._tcp` advertised
address, port, and HomeKit id. A HomeKit id is not necessarily the network MAC.
The port may change after a device reboot; update it from discovery if needed.

Each device gets a page, Settings, Log, and the ordinary
`GET /api/devices/<id>` document. Pages read sensors every five seconds while
visible. The M2 and its children share one cached read per five seconds.
Observation delivery depends on the selected transport. Inspect the current
instance document for its read-only sensor capabilities.

Before pairing, the page reports **Pairing required** and does not claim a
sensor state. On an available accessory, enter its HomeKit code in the page's
pairing form. The M2 is paired once for itself and its child sensors; the FP2
is paired separately. Pairing codes are sent to the local server, never put
in a URL, log, or browser storage. Long-term keys are stored in owner-only
files under `.hometruth/aqara/pairings/`, separate from the public config.
They are reread automatically without a server restart.

An accessory already paired with Apple Home cannot perform another initial
HomeKit pairing. **Do not remove it merely to diagnose connectivity.** Moving
its pairing requires an explicit decision because it removes its current
Apple Home accessories and can affect automations. HomeTruth does not
automatically unpair, reset, or re-export these sensors to Apple Home.
Authorized existing controller credentials in `hap-controller` format can
instead be imported with `AqaraPairingStore.save(deviceId, data)`; HomeTruth
verifies that the saved accessory id matches the configured target before
using them. Do not copy another controller's credentials unless that access
has been authorized.

### Direct Matter for the M2

The M2 can instead use `config: { host: "192.168.50.20", matterPeerId: "peer1" }`.
The host is for display; encrypted Matter discovery uses the saved peer identity.
This route requires an already commissioned HomeTruth Matter controller and
its saved peer id. The current public release does not include a commissioning
CLI for the M2.
Use the supported HomeKit pairing flow above for a new installation. Do not
put setup codes or controller credentials in the device YAML.

The controller's credentials live under `.hometruth/aqara/matter-controller/`
with owner-only permissions. Keep this directory: it is the durable identity
used to reconnect without a new code. Reads run in an isolated Node 24+
process (`node` on PATH, or `HOMETRUTH_NODE_BINARY`), with a controller lock,
an eight-second deadline and bounded shutdown. No additional dev server is started.
The hub and door share fresh reads cached for five seconds. Failed reads
discard prior observations. Matter's persisted attribute cache is never
presented as a fresh reading; child reachability must explicitly be true.

The FP2 still uses its separate local HAP connection. Neither path uses Apple
Home as an intermediary. HomeTruth's existing Matter exporter supports
switches only; exporting these sensors to Apple Home is separate future work.

## Observation semantics

- HAP reads use authenticated, encrypted local connections. A failed read
  discards the previous snapshot and reports a degraded connection.
- Pairing/authentication failures never trigger automatic Wi-Fi recovery.
- Closed/clear is only reported from an explicit valid reading. An unknown
  or faulted zone cannot make an entire room appear empty.
- The hub's accessory list is inventory, not a claim that every child is
  currently online. Vendor-specific child health not exposed through HomeKit
  is unavailable.
- Zone configuration, FP2 calibration, hub IR, alarm writes, and firmware
  updates remain in Aqara Home; this integration only reads observations.

## Validation status

Protocol/model tests use synthetic fixtures. Hardware validation remains
incomplete: authenticated HAP reads and physical door open/close transitions
still need verification. Saved-controller Matter reads have been exercised;
installation-specific observations are retained in private research.

Protocol references:
[hap-controller](https://github.com/Apollon77/hap-controller-node),
[Home Assistant HomeKit pairing guidance](https://www.home-assistant.io/integrations/homekit_controller),
[Aqara FP2](https://www.aqara.com/us/product/presence-sensor-fp2),
[Aqara M2 Matter bridge](https://www.aqara.com/en/aqara-hub-m2-matter-update-has-started-to-roll-out/).
