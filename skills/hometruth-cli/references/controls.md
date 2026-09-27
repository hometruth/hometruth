# Control reference

These examples describe selected capability implementations. The current
instance document (`ht <id> --json`) is authoritative for available actions
and bounds; do not assume every product with that capability has these controls.

## Capability documents

`ht <id> --json` returns `{ id, name, page, model, config, secrets, controls, object }`.
`controls` contains the API's method IDs. In text mode, `ht <id>` prints their
friendly CLI names, and `ht <id> help` lists every command and option.
`object` is the `homeTruthObjectSchema` document: `status` (device availability)
and `capabilities.<kind>` each with `id`, `state`, and `actions`.

The tables below list CLI commands. If a name is shared, use the qualified
name shown by the install, such as `infrared-blaster.send`.

Availability values: `online`, `offline`, `degraded`, `unknown`. A device is
`degraded` when its capabilities disagree.

## binarySwitch (Shelly Plus 1)

| Control | Value | Notes |
| --- | --- | --- |
| `on` | none | |
| `off` | none | |
| `toggle` | none | |
| `state` | none | re-reads the relay; `state.value` is `"on"` or `"off"` |

Config: `host` (required), `channel` 0..15, `timeoutMs` 100..60000.

## light (Elgato Key Light Air)

| Control | Value | Notes |
| --- | --- | --- |
| `on` / `off` / `toggle` | none | |
| `state` | none | |
| `brightness` | number | percent within `actions.setBrightness.minimumPercent..maximumPercent` (0..100) |
| `color-temperature` | number | kelvin within `actions.setColorTemperature.minimumKelvin..maximumKelvin` (2900..7000) |

State: `on`, `brightnessPercent`, `colorTemperatureKelvin`. Setting brightness
on a light that is off does not turn it on.

Config: `host` (required), `port`, `timeoutMs`.

## camera (TKENPRO 2K Pet Camera Treat Dispenser, "Pet 3T")

| Control | Value | Notes |
| --- | --- | --- |
| `pan.left` / `pan.right` | integer ms, optional | lease within `actions.pan.<dir>.minLeaseMs..maxLeaseMs` (100..3000); omitted = max; the camera stops itself when the lease ends |
| `tilt.up` / `tilt.down` | integer ms, optional | same lease rule under `actions.tilt` |
| `stop-movement` | none | ends a lease early; harmless when nothing is moving |
| `pan.home` / `tilt.home` | none | only when `actions.pan.home` or `actions.tilt.home` is declared (firmware-dependent) |
| `privacy` | `true` / `false` | only when `actions.setPrivacy` is declared |

State: `availability`, `streamAvailable`, `snapshotAvailable`. `snapshot` is
listed under `actions` to advertise media types but is not an invokable
control; use `tkenpro snapshot` or the web page.

Config: `host` (required), `serialNumber` (digits, the cloud serial).

## treatDispenser (same device)

| Control | Value | Notes |
| --- | --- | --- |
| `dispense` | optional, `1` if given | one treat per call: `actions.dispense` bounds are 1..1 because the firmware's multi-portion action is not reliable on this hardware; any other number is `invalid_value`; `confirmation` is `"confirm"`, so `--confirm` is mandatory; call again for another treat |
| `play-call` | none | `not_supported` when the product has no call sound |

## infraredBlaster and radioFrequencyBlaster (Broadlink RM4 Pro)

Both capabilities offer the same two names, so on this device they are always
qualified: `infrared-blaster.send`, `radio-frequency-blaster.send`,
`infrared-blaster.learn`, `radio-frequency-blaster.learn`. A bare `send` is not a command on this device; use the qualified name.

| Control | Value | Notes |
| --- | --- | --- |
| `send` | non-empty string | a Broadlink-packet base64 code; repeat bounds are advertised (1..20) but the generic control sends once |
| `learn` | optional object | `{"timeoutMs": n, "frequencyHz": n}`; `frequencyHz` is RF-only; returns the learned signal; the user has to press the remote at the blaster while it runs |

Saved codes are not in the document. `GET /api/ir-rf-blasters/<id>` returns
`{ infrared, radioFrequency, codes: [{ id, name, channel, code, learnedAt }] }`.
Send a saved one by name by looking up its `code` and passing it to `send`, or
`POST /api/ir-rf-blasters/<id>/codes/<codeId>/send` with an empty JSON body.
Save a learned code with `POST /api/ir-rf-blasters/<id>/codes`
`{"name": …, "channel": "infrared"|"radioFrequency", "code": …}`.

Config: `host` (required), `devType`, `timeoutMs`.

## reboot

`POST /api/devices/<id>/reboot` (no body). Only models with a recovery flow
support it; see the selected model's recovery guide. The flow: ONVIF at the configured
address; if silent, ask the vendor cloud (saved app account) where the camera
last reported; verify the serial so the wrong camera is never rebooted; send
ONVIF `SystemReboot`; poll the address for up to the timeout and wait for the
camera to re-register with the local emulator. `--direct` does the same from
the CLI process using `devices.yml`, `.hometruth/camera-setup.json`, and
`.hometruth/discovered-cameras.json`; it also accepts a bare IP.

## network

| Command | Route | Effect |
| --- | --- | --- |
| `network on` | `POST /api/camera/network/dns-override {"action":"on"}` | Configured provider's DNS record for the vendor hostname points at this server; cameras that re-resolve join the local hub |
| `network off` | same with `"off"` | record removed; cameras go back to the vendor cloud |
| `network kick` | `POST /api/camera/network/reconnect` | kicks cameras on the wrong side so they re-resolve now (about 13 s); cameras already on the right side are skipped |

## tkenpro pass-through

`bun run ht tkenpro …` is identical to `bun run camera …`. Credentials
come only from the environment; flags name the variable, never the value.

Local (ONVIF, needs `--host` or `TKENPRO_CAMERA_HOST`, `ONVIF_USERNAME`
default `admin`, `ONVIF_PASSWORD`):

```
tkenpro discover [--host IP] [--cidr CIDR] [--json]      # no credentials needed
tkenpro info --host IP [--json]
tkenpro media --host IP [--json]                          # RTSP/snapshot URIs, password redacted
tkenpro snapshot --host IP --output FILE [--force]
tkenpro ptz <left|right|up|down|stop|home> --host IP
```

Cloud (vendor account, `TKENPRO_EMAIL` / `TKENPRO_PASSWORD`, `TKENPRO_PROFILE`
`tkenpro` or `cloudedge`, `TKENPRO_SERIAL` when the account has several cameras):

```
tkenpro status [--json]
tkenpro controls [--json]                                 # the 127-entry PET3T catalog with safety class
tkenpro get [CONTROL_ID] [--json]
tkenpro set CONTROL_ID VALUE [--confirm CONTROL_ID]       # caution controls need --confirm <id>
tkenpro set formatStorage … --confirm FORMAT_STORAGE      # destructive: exact literal from `controls`
```

Note: in local-hub mode the cameras are registered with this server's
emulator, not the vendor cloud, so cloud commands may not reach them. Prefer
the generic `control` path for anything it models.
