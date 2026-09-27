# Apple Home, Matter, and HomeKit

Configuration and runtime paths in this guide are relative to your private
installation directory. Examples use fictional device names and addresses.
See [repository layout](REPOSITORIES.md) for command and storage conventions.

HomeTruth meets Apple Home in two directions, and it is worth keeping them
apart:

| Direction | What | Protocol | Status |
| --- | --- | --- | --- |
| **HomeTruth → Apple Home** | HomeTruth's devices appear as accessories in the Home app | Matter (a local bridge HomeTruth runs) | switches today; see [what is exported](#what-is-exported) |
| **HomeKit/Matter devices → HomeTruth** | accessories that speak HomeKit or Matter are read by HomeTruth as devices | HAP (HomeKit) or Matter, HomeTruth as the controller | Aqara hub and sensors today |

Apple Home is never in the middle: HomeTruth talks to devices on the LAN
directly, and the bridge is a separate export of what HomeTruth already
knows. Nothing here needs an Apple developer account, a HomeKit MFi licence,
or the internet.

## HomeTruth → Apple Home (the Matter bridge)

HomeTruth starts and manages its Matter bridge with `bun run dev` or `bun run start`. Apple Home
commissions it once, and every exported HomeTruth device shows up as an
accessory of that bridge; devices added or removed in `devices.yml`
follow within 30 seconds without pairing again. Home talks to the bridge over
the LAN; the bridge talks to HomeTruth's HTTP API; HomeTruth talks to the
device. Commands from Home therefore go through the same validation and
readback as a click in the web UI, and Home shows the state the device
actually reports, not the state it was asked for.

### What is exported

Every configured device with the `binarySwitch` capability — physical relays
(Shelly), and the logical switches composed on the `/switches` page
(`synthetic-switch`, `optimistic-switch`). They appear in Home as Matter
*Mounted On/Off Control* accessories (with the older *On/Off Plug-in Unit*
type listed for clients that predate Matter 1.4, which may show them as
outlets).

Not exported yet: lights, cameras, sensors, speakers, buttons (a stateless
press has no readable on/off state, so it is deliberately not misrepresented
as a switch), treat dispensers, and vendor settings. These capabilities remain available through HomeTruth when supported by the
configured device; this bridge does not export them. Optional native vendor
integrations in Apple Home are configured separately.

### Requirements

- HomeTruth installed and running (`bun run dev` or `bun run start`).
- Node.js 22.18+ or 24+ on the same machine: the bridge uses `@matter/main`,
  which runs under Node, not Bun. `bun install` already installed it.
- An awake server host reachable from the Apple Home controller/hub: the bridge
  uses UDP 5540 and LAN mDNS (UDP 5353). Keep this traffic on the local network.
- An iPhone or iPad to scan the pairing code; the Mac's Home app cannot add
  accessories, but sees them once added.

### Set it up

The bridge normally runs on the same machine as HomeTruth, which is on the
local network, so it needs no token by default. Give it one of its own if you
have set `HOMETRUTH_TRUST_LAN=off`, or to hold it to just the switches it
exposes rather than the whole house:

```sh
ht tokens issue "Matter bridge" --can write --for group:automatic:switches
```

Put `HOMETRUTH_TOKEN` in the environment used to run HomeTruth when local-network
trust is disabled. The managed bridge inherits it.

```sh
bun run dev                # starts the web UI, device services, and Apple Home bridge
bun run matter:status      # inspect the managed bridge from another terminal
```

HomeTruth runs the Matter SDK in a Node child process, retries it if it exits,
and stops it when HomeTruth stops. Development reloads transfer ownership to the
new application process. Bridge startup never blocks the web UI or other services;
its state and errors appear as **Apple Home bridge** on the Services page.
Set `HOMETRUTH_NODE_BINARY` if Node is not on PATH, or
`HOMETRUTH_MATTER_ENABLED=0` to disable the bridge.

The bridge holds a process lock, so two copies cannot share one pairing store.
Pairing/fabric keys, switch inventory, `status.json`, `pairing.html`, and
`pairing.png` live in the git-ignored `.hometruth/matter/` (mode 0700).
Keep that directory; deleting it means pairing again. Logs go to HomeTruth's terminal.

### Pair it with Home

1. Open any exported switch in HomeTruth (`/switches/<name>/settings`) — the
   **Apple Home** card shows the bridge's QR code and manual code while it is
   unpaired. The same page is at `.hometruth/matter/pairing.html`, and
   `bun run matter:status` prints the manual code.
2. On an iPhone or iPad on the same Wi-Fi, in Home: **+ → Add Accessory**,
   scan the QR code (or **More Options…** and type the manual code). Choose
   the same home the hub is in.
3. Home warns that the accessory is **uncertified**. That is expected: the
   bridge uses Matter's development vendor and product ids, not a
   certification. Continue.
4. Name the accessories and assign rooms in Home. They then sync to every
   Apple device on the account.

Scanning once adds every exported switch, and the code disappears from the
settings page afterwards (it is kept behind a disclosure so it is not
mistaken for a per-device code). If the pairing window timed out before
Home connected, `bun run matter:pair` reopens it; once paired, that command
does nothing, and sharing the home with more people is Home's job.

### Rooms and names

HomeTruth's room (set on a device page or a switch card) is published to the
bridge as Matter *Fixed Label* metadata, but Apple's Home database can only
be changed by an authorised HomeKit app, which HomeTruth is not. So: set the
room in Home too. Renaming a device in HomeTruth keeps its accessory (the
identity is the device id, hashed); changing the id creates a new accessory
and orphans the old one in Home. Details: [MATTER_SWITCHES.md](MATTER_SWITCHES.md#rooms).

### How it behaves

- A command from Home is one HomeTruth request. If it fails, Home is told it
  failed; nothing is retried on its own.
- State is polled from HomeTruth every 2 s (`HOMETRUTH_MATTER_POLL_MS`) and
  the inventory every 30 s. An offline or unknown switch shows as
  **unreachable** with its last known value, never as a freshly observed Off.
- If HomeTruth is down when the bridge starts, the cached inventory lets the
  bridge come up with the accessories marked unreachable; they recover when
  the server answers.
- The server host must remain awake and running for the bridge to be reachable.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOMETRUTH_MATTER_ENABLED` | `1` | set to `0` to disable Apple Home export |
| `HOMETRUTH_NODE_BINARY` | `node` | Node executable for the managed bridge |
| `HOMETRUTH_MATTER_PORT` | `5540` | Matter UDP port |
| `HOMETRUTH_MATTER_STORAGE` | `.hometruth/matter` | pairing and status directory |
| `HOMETRUTH_MATTER_POLL_MS` | `2000` | state poll interval, 500–60000 |
| `MATTER_MDNS_NETWORKINTERFACE` | all interfaces | LAN interface used for Matter discovery and advertisements, such as `en0` on macOS or `eth0` on Linux |

If tunnel interfaces produce repeated `UdpMulticastServer` send timeouts,
set `MATTER_MDNS_NETWORKINTERFACE` to the interface connected to the Matter
devices' LAN. This uses Matter.js's existing mDNS setting and also applies to
HomeTruth's Matter controller. It leaves IPv6 enabled and does not change VPN
settings or suppress other networking errors. For example, when the LAN
interface is `en0`, use this on the next manual start:

```sh
MATTER_MDNS_NETWORKINTERFACE=en0 bun run dev
```

For a persistent setting, add it to the private installation's `.env.local`.
The development supervisor watches that file, so make this change while the
server is stopped if a restart would interrupt work. Use the interface name
for the installation; do not assume every host uses `en0`.

### Troubleshooting

| Symptom | Look at |
| --- | --- |
| Home cannot find the accessory while scanning | phone and server host on the same LAN/VLAN (mDNS does not cross VLANs without a repeater); the host awake; `bun run matter:status` says running and not yet commissioned; firewalls allowing UDP 5540/5353 |
| "Accessory not certified" | expected; continue |
| everything shows **No Response** | HomeTruth stopped or its Apple Home bridge service unavailable; a revoked or missing `HOMETRUTH_TOKEN` (the log says so, with the command to issue one); `bun run matter:status`; the Apple Home bridge service log and HomeTruth terminal |
| a switch shows as an outlet | the Home app chose the compatibility device type; choose the desired Display As setting in Apple Home |
| a new switch does not appear | wait 30 s; check `/api/devices` lists it with `binarySwitch`; the bridge log |
| pairing code missing from the settings page | already paired (`commissioned: true` in `status.json`) — that is fine |
| `The Matter bridge is already running as PID …` | another process owns the pairing store; stop that duplicate, then the managed bridge retries automatically |
| multicast send timeouts on `utun`/tunnel interfaces | set `MATTER_MDNS_NETWORKINTERFACE` to the LAN interface as described above; these messages alone do not establish a LAN or device failure |

Removing the bridge from Home (Home → the bridge accessory → Remove) clears
the fabric on the bridge; `bun run matter:pair` then makes it commissionable
again.

## HomeKit and Matter devices → HomeTruth

Some products expose their local state only through HomeKit (HAP over the
LAN) or Matter. HomeTruth can be the controller for those: it pairs with the
accessory itself and reads it directly, so Apple Home is not needed at all
(and, if present, is not used as a relay). Today this is how the Aqara
models work — `aqara-hub-m2`, `aqara-presence-sensor-fp2`, and, through the
hub, `aqara-door-window-sensor`. Full detail: [AQARA.md](AQARA.md).

### HomeKit (HAP) pairing

1. Find the accessory's local HAP endpoint: on macOS,
   `dns-sd -B _hap._tcp local.` lists names, and
   `dns-sd -L "<name>" _hap._tcp local.` shows the host, port, and the TXT
   `id=XX:XX:XX:XX:XX:XX` — that id is the `homekitId` (it is not necessarily
   the network MAC). The port can change after the accessory reboots.
2. Add the device to `devices.yml` with `config: { host, port, homekitId }`
   (see `devices.example.yml`).
3. Open the accessory from the HomeTruth device list; it reports **Pairing required**. Enter the
   accessory's HomeKit setup code (the `XXX-XX-XXX` on its label or in its
   vendor app) in the pairing form, or `POST /api/aqara/<id>/pair` with
   `{"pin":"XXX-XX-XXX"}`. The code goes to the local server only, never
   into a URL or a log.
4. The long-term keys are saved, owner-only, under `.hometruth/aqara/pairings/`
   and picked up without a restart. The hub's child sensors ride on the hub's
   pairing; the FP2 pairs separately.

**An accessory can hold only one initial HomeKit pairing.** If it is already
in Apple Home, HomeTruth cannot pair with it, and removing it from Home to
let HomeTruth in also deletes its Home automations. Decide that explicitly
with the user; never unpair a device to "test connectivity". If another
controller's credentials were legitimately exported (hap-controller format),
`AqaraPairingStore.save(deviceId, data)` imports them and HomeTruth checks
that they belong to the configured accessory before use.

### Matter commissioning

The Aqara M2 can instead be commissioned directly over Matter, which does not
consume its HomeKit pairing:

This requires an existing HomeTruth controller identity in
`.hometruth/aqara/matter-controller/` and its saved peer id. Configure the hub
as `config: { host: "192.168.50.20", matterPeerId: "peer1" }`. Reads run in a
short-lived Node process (`node` on `PATH`, or `HOMETRUTH_NODE_BINARY`).
The experimental M2 commissioning helpers are private research and are not
included in the public release. Use the supported HomeKit flow for a new
installation; never commit setup codes or controller state.

Reads are on demand (every 5 s while a page is open), cached briefly, and a
failed read discards the last snapshot rather than presenting stale state as
fresh. Writes (zone setup, alarms, firmware) stay in the vendor app; these
models are observation-only, and their only generic control is `getState`.

### Adding another HomeKit or Matter product

A product that speaks HAP or Matter is a candidate for a model that reuses
the same controller code (`src/protocols/homekit/`, `src/protocols/matter/`,
`src/vendors/aqara/` as the pattern) — the `hometruth-add-device` skill's
"write a new model" job. What it will be able to read is what the accessory
exposes over the protocol, which is not always everything the vendor app
shows.

## Living with both

- **Duplicates.** A Hue light or Sonos speaker that is in Home natively and
  also reached by HomeTruth is fine: HomeTruth does not export those kinds,
  so nothing appears twice. A relay exported by this bridge *and* by another
  bridge (Homebridge, Home Assistant) will appear twice; pick one.
- **Automations.** Home automations on exported switches work like any
  accessory. HomeTruth's own automations (`/automations`) run in HomeTruth
  and can act on every device, exported or not.
- **Siri.** Exported switches respond to Siri by their Home name. Nothing
  else in HomeTruth is reachable from Siri yet.
- **Privacy.** The bridge and the pairings are local. No setup code, key, or
  device state leaves the LAN, and none of it is in git.
