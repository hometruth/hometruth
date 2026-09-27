# Bosch Home Connect over the LAN

Configuration and runtime paths in this guide are relative to your private
installation directory. Examples use fictional device names and addresses.
See [repository layout](REPOSITORIES.md) for command and storage conventions.

HomeTruth supports the **Bosch Benchmark NITP060UC** induction cooktop through
its encrypted local WebSocket protocol. The model is `bosch-nitp060uc` and its
capability is `cooktop`. This adapter covers that model only; other Home Connect
appliances require their own model and profile validation.

## Supported functions

| Function | HomeTruth | Apple Home through the current Matter bridge |
| --- | --- | --- |
| Power and four cooking-zone states | Read | Not exported |
| Zone heat level, boost, and residual heat | Read | Not exported |
| Left FlexInduction combined zone | Read when available | Not exported |
| Child lock | Read and set | Optional switch: On = locked, Off = unlocked |
| Kitchen alarm timer | Read, set 1–99 minutes, cancel | Not exported |
| Start heating or change a burner level | Not implemented | Not exported |

The kitchen timer is an alarm; it does not shut off a cooking zone. The child
lock accessory represents the control lock, not cooktop power. Controls are
allowed only while remote control and the appliance's dynamic access flags
permit them. A write is followed by a fresh read, and failure to confirm it is
reported as an error. Commands are never automatically replayed on reconnect.

## Setup

1. Pair the cooktop to Wi-Fi using the Home Connect app.
2. Use the community [Home Connect Profile Downloader](https://github.com/bruestel/homeconnect-profile-downloader)
   to sign in to the matching account region and download this appliance's
   profile. The profile must identify `NITP060UC` with `connectionType: AES`.
3. Add these entries to the private `devices.yml`, replacing the example
   host with the cooktop's LAN address. Reserve the address in your router.

```yaml
schemaVersion: 2
devices:
  - id: kitchen-cooktop
    name: Kitchen Cooktop
    room: Kitchen
    model: bosch-nitp060uc
    config: { host: 192.168.50.90 }
  - id: kitchen-cooktop-child-lock
    name: Cooktop child lock
    room: Kitchen
    model: cooktop-child-lock
    config: { cooktop: kitchen-cooktop }
```

4. Save the downloaded JSON's `key` and `iv` in the private secrets store as
   `devices.kitchen-cooktop.key` and `devices.kitchen-cooktop.iv`. Optionally
   save `serialNumber` there too. These are base64url values: a 32-byte key and
   16-byte IV. Keep the ZIP and extracted profile private; they contain keys.
   Use the device's Settings page or the existing secrets-store tools.
5. Open `/devices/kitchen-cooktop`. A successful read shows the appliance's
   actual state, including an observation time. Missing readings are unknown
   or degraded; failed connections are offline and do not fabricate Off.

Profile download requires a Bosch account and internet access. Normal reads
and controls connect directly to `ws://<cooktop>:80/homeconnect` using
AES-256-CBC encryption and chained HMAC authentication. HomeTruth does not
contact Bosch at runtime. This setup does not disable the appliance's own
cloud connection. Test any later internet isolation separately, retaining
LAN connectivity between HomeTruth and the appliance.

Each installation uses a stable client identity derived from its host, private
installation directory, and device ID. Development and production can therefore
observe the same cooktop without evicting each other's sessions. Keep launching
through `bun run site` so source releases do not change that identity.
The child-lock switch uses its confirmed lock reading even when an unrelated
burner or timer reading is missing; losing the connection or lock reading still
makes its state unavailable.

## Apple Home

The optional `cooktop-child-lock` device shares its parent's connection and
exports a `binarySwitch`. The existing Matter bridge discovers it with other
switches. See [Matter setup](MATTER_SWITCHES.md).

The bridge is managed by the main HomeTruth process when enabled. If HomeTruth
is stopped, start it from your terminal using the [operations guide](OPERATIONS.md).

An already commissioned bridge retains its pairing when restarted. New switch
inventory is refreshed every 30 seconds. Keep `.hometruth/matter/` to preserve
that pairing. If it has never been paired, use the switch's Settings page for
the shared bridge QR code. Apple Home does not currently receive the cooktop's
burner readings or timer through this bridge.

## Validation and references

The protocol and model tests use an in-memory appliance peer; they do not start
servers or touch a real appliance. They cover AES chaining and authentication,
service negotiation, access restrictions, readback, disconnects, state mapping,
and the child-lock accessory.

```sh
bun run typecheck
bun test src/protocols/homeconnect src/devices/appliances/bosch-nitp060uc
```

Hardware coverage is incomplete. Physical lock/timer changes and operation
with internet access blocked remain unverified. Automated protocol tests do
not establish those physical outcomes or compatibility with other appliances.

Protocol references: [hcpy](https://github.com/osresearch/hcpy) and
[homeconnect_websocket](https://github.com/chris-mc1/homeconnect_websocket).
Model behavior is mapped from its downloaded DeviceDescription and
FeatureMapping XML, with operating limits described in the
[Bosch NITP060UC manual](https://media3.bosch-home.com/Documents/9001444939_E.pdf).
