---
name: hometruth-cli
description: "Operate a HomeTruth installation from the shell with the `ht` CLI (bun run ht …). Use it whenever the user asks to list, inspect, or act on the devices in the selected installation — turn a light or relay on/off/toggle, set brightness or colour temperature, pan/tilt a camera, set privacy, dispense a treat, send an IR/RF code, reboot a camera, flip the camera DNS override, kick a camera onto the local hub, or check whether something is online — and whenever you need device state or capability names while writing code or tests. Also covers the `tkenpro` camera CLI it wraps. Prefer this CLI over curl or ad-hoc scripts for anything the CLI already does."
---

# Operating the site with `ht`

For UniFi client lookups, SSH, VLAN reachability, bridge discovery, port
probes, or packet capture, also use the project `hometruth-network` skill
(`skills/hometruth-network/SKILL.md`) before acting. It is the source of truth
for router-independent scripts, private site context, and provider setup.

`ht` is the HomeTruth client. It holds no list of devices, capabilities or
controls: it connects to one install and offers exactly the elements that
install publishes, so a model this build has never heard of is as usable as
one it ships with. Ordinary device commands go through the running server. The explicit local
and vendor commands below can contact hardware independently. There is no global binary: run it from the repo root as

```sh
bun run ht <command> …
# For another private directory:
bun run site <private-directory> ht <command> …
```

`bun run ht` on its own says which install it reached and what is in it.

## The rule: look, then act, then look again

1. `bun run ht ls` — which devices exist, their ids, and status.
2. `bun run ht <id>` — the element itself: its state, and every control it
   accepts with the bounds the install published (percent, kelvin, portions,
   lease ms) and `needs --confirm` where the action asks for it. Add `--json`
   for the raw document. Take both from the answer, not from memory.
3. `bun run ht <id> <control> [value] [--confirm]`.
4. The invocation prints the state it left behind; `bun run ht <id>` again to
   look once more, or `bun run ht watch <id>` to follow it live.

The element is the subject and the command is the verb: `ht example-relay on`.
Use `on`, `off`, `state`, `brightness`, `color-temperature`, and other names
printed by `ht <id>`. Shared control names retain a capability qualifier,
such as `infrared-blaster.send` and `radio-frequency-blaster.send`.
`ht <id> help` lists every schema operation and its options, including
settings, events and tags. These are native commands; do not construct HTTP
requests. Device, group and service IDs are accepted directly; other schema
elements use the object key printed in their page's CLI tab.
The site itself has the reserved ID `root`: use `ht root` to inspect it and
`ht root help` for its commands. Its skill is available at `/SKILL.md`.

Never guess an id or a control name; step 1 and 2 are cheap. Device ids
come from the `devices.yml` in the private repository and differ from the example file.

## Commands

| Command | Needs server? | What it does |
| --- | --- | --- |
| *(nothing)* | yes | which install this reached, and how many devices, groups, services and models it has |
| `<id> [--json]` | yes | one device, group or service: what it is, what it reads now, and every control with its bounds |
| `<id> <command> [value] [options]` | yes | run a named command; controls print the state they left behind |
| `<id> help` | yes | every command and option, generated from this element’s schema |
| `ls [kind] [--side schema] [--json]` | yes | every element of a kind, and the one lister. `device` (the default), `group`, `service`, `model` and `schema` answer from their own endpoint, so they carry live status or the full schema; every other kind (`scene`, `preset`, `signal`, `capability`, `control`, `property`, `event-type`, `widget`, …) comes from the graph. A kind this install does not publish lists the ones it does |
| `find <text> [--json]` | yes | every element whose id, name or context matches — the way to find something when you know the room but not the id |
| `watch <id>… [--for <s>] [--json]` | yes | subscribe to the state stream and print each change as it happens. Nothing polls; Ctrl-C or `--for` ends it |
| `graph <id> [--depth <n>] [--explain]` | yes | what an element is connected to, and one level beyond |
| `tags [list\|export\|import [file]]` | yes | the ontology: tags and rooms, as a table or as YAML to keep and diff |
| `enable <id>` / `disable <id>` | yes | switch a device on or off without removing it from the inventory; disabled refuses controls and stops background polling/connections |
| `reboot <id> [--timeout <s>]` | yes | reboot through the server (only models that implement recovery) |
| `reconnect <id>` | yes | drop one managed Wi-Fi association so the device reconnects and renews DHCP |
| `rescan [id]` | yes | find every device (or one) by its saved `mac` in the gateway's client table, on any subnet, and rewrite its `config.host` to match; lists what moved, what was identified, and what is missing |
| `reboot <id\|ip> --direct [--locate] [--timeout <s>]` | no | find and reboot a camera without the server; `--locate` only reports where it is |
| `network on\|off\|kick` | yes | camera DNS override on/off; `kick` makes the cameras re-resolve and follow it |
| `isolation` / `isolate <id> on\|off` | yes | which devices are cut off from the public internet, and cutting one off or releasing it |
| `network accept-next <ssid> [--timeout <s>] [--dry-run]` | no | open a bounded router MAC admission window, add the next new wireless client on that SSID, and restore filtering; default 180 seconds |
| `network accept-next <ssid> --recover` | no | restore a saved MAC admission window after a worker/host failure |
| `tokens [list] [--json]` | yes | every API token: what it may do, what it reaches, when it was last used |
| `tokens issue <name> --can <perms> --for <reach> [--expires <date>]` | yes | issue one and print it **once**; `--can` from `read,write,admin`; `--for` is `all`, `device:<id>`, `group:<id>`, or `room:`/`schema:`/`tag:` parts |
| `tokens revoke <id>` | yes | stop a token working; its record stays |
| `tokens bootstrap [name]` | no | mint a full-access token straight into the database and save it for this client — the way back in when no token is to hand |
| `secrets list\|set <path>\|unset <path>\|import` | no | the secrets file on this machine; `list` prints paths, never values |
| `hub` | no | run the local cloud emulator on its own (foreground, blocks) |
| `tkenpro <args…>` | no | pass-through to the TKENPRO camera CLI (direct to a camera or the vendor cloud) |
| `help` | no | usage |

Everything in the "yes" rows is universal: point `HOMETRUTH_URL` at any
HomeTruth and the same commands work there, offering whatever *that* install
holds. The "no" rows read files or hardware on this machine and do not care
which install is running.

`--json` prints the server's response verbatim; use it whenever you will parse
the output. Without it you get a short table or summary.

Anyone on a private network reaches everything with no token, so from the same
machine (or the same LAN) the CLI just works. Set `HOMETRUTH_TRUST_LAN=off` on
the server and it needs one: taken from `HOMETRUTH_TOKEN`, or failing that
`api.cli.token` in `.hometruth/secrets.yml`. A `401`/`403` then means the token,
not the route — run `ht tokens bootstrap` if there is none. A token
issued with `tokens issue` is printed once and is not recoverable. Have the user
issue and save it through their terminal or a secure secret-store workflow;
never repeat a token in chat or commit it to either repository.

Environment: `HOMETRUTH_URL` (default `http://127.0.0.1:3000`),
`HOMETRUTH_TOKEN`, and
`HOMETRUTH_DEVICES` (the YAML `--direct` reads, default `devices.yml`).
If HomeTruth is not reachable, check `HOMETRUTH_URL` and the startup logs.
Agents may start, stop and restart development and production services as needed
for the requested work. Use `bun run site <private-directory> start` when startup
is needed, following the checkout's `AGENTS.md`.

## Values

The `[value]` argument is parsed as JSON when it parses, else taken as a raw
string: `50` → number, `true` → boolean, `'{"timeoutMs":20000}'` → object,
`JgBSAH…` → string. To force a string that would otherwise parse as JSON, quote
it as JSON: `'"123"'`. Omit the value for controls that take none.

## Controls by capability (see `references/controls.md` for full detail)

This table is a memory aid, not the source of truth: `ht <id>` prints the
controls that element really has, with the bounds it really published.

| Capability | Controls (as you type them) | Value |
| --- | --- | --- |
| `binarySwitch` | `on` `off` `toggle` `state` | none |
| `light` | `on` `off` `toggle` `state` `brightness` `color-temperature` `color` | none / percent / kelvin / `#rrggbb` (`ht <id>` prints each one's bounds) |
| `camera` | `pan.left` `pan.right` `tilt.up` `tilt.down` `stop-movement` `pan.home` `privacy` | lease ms 100..3000 (default max) / none / `true`\|`false` |
| `treatDispenser` | `dispense` `play-call` | one treat per call (value omitted or `1`) and **`--confirm`**; run it again for another / none |
| `infraredBlaster`, `radioFrequencyBlaster` | `infrared-blaster.send` `radio-frequency-blaster.send` `infrared-blaster.learn` `radio-frequency-blaster.learn` (qualified because both blaster capabilities share the names) | base64 Broadlink code, or `{"code":…,"durationMs":…}` to hold (repeat) it for up to 60000 ms / optional `{"timeoutMs":…,"frequencyHz":…}` |

A control the device does not offer right now answers `not_supported`; an
unknown command prints the available names. Use the qualified command when
two capabilities share a name. Movement controls stop on their own when the lease
ends; `stop-movement` ends one early.

Examples below use fictional IDs. Substitute IDs returned by `ht ls`.
Read-only examples:

```sh
bun run ht ls model
bun run ht ls --json
bun run ht example-relay
bun run ht example-relay state
```

Examples that change something (do them when asked, not to "check"):

```sh
bun run ht example-relay toggle
bun run ht example-light brightness 40
bun run ht example-light color-temperature 3200
bun run ht example-camera pan.left 500
bun run ht example-camera privacy false
bun run ht example-camera dispense --confirm
bun run ht blaster infrared-blaster.send 'JgBSAHYO…'
bun run ht reboot example-camera
bun run ht reconnect example-light
```

## Safety and side effects

- **Physical actions are real.** Treats fall into a bowl, motors move, relays
  switch mains, IR codes turn real appliances on. Do these only when the user
  asked for that specific action. `dispense` refuses without `--confirm`;
  pass the flag only because the user asked to dispense, never to make an
  error go away.
- **`reboot` takes a camera offline for about two minutes** and the CLI waits
  for it to come back (default timeout 120 s, `--timeout 10..600`). Consult the model's recovery guide first; LED meanings and fallback networks
  are device-specific. Do not use reboot as a generic retry. `--direct` works when the
  server is down or the camera is on another subnet; `--locate` is read-only.
- **`network on|off` changes a network-wide DNS record** on the configured router
  and affects every camera at once. `network kick` bounces the cameras' Wi-Fi;
  it is only useful when a camera is registered on the wrong side, and the
  server already refuses to kick one that is where it should be.
- **`reconnect <id>` briefly drops one device's managed Wi-Fi association.**
  This is an explicit action; loading pages or reading device status never
  kicks a device. The device should reassociate and request its reserved DHCP address.
- **`hub`** starts a standalone server. Use it when deliberately choosing an
  emulator without the main server.
- **Never put secrets on the command line.** The tkenpro CLI takes credentials
  only from environment variables (`ONVIF_PASSWORD`, `TKENPRO_PASSWORD`, …)
  and never prints them; don't echo them either.

## Reading errors

| Output | Meaning | Do |
| --- | --- | --- |
| `HomeTruth is not reachable at …` | server down or wrong URL | check `HOMETRUTH_URL`; leave server startup to the user |
| `401 … Set HOMETRUTH_TOKEN` | no token, or a revoked/expired one | `ht tokens bootstrap`, or set `HOMETRUTH_TOKEN` |
| `403 forbidden: This token does not hold "…"` | the token lacks that permission, or the device is outside its reach | `ht tokens` to see its scope; ask the user before widening it |
| `404 not_found: No device with that id …` | wrong id (or a mistyped command taken as an id) | `ls` and use an id from there |
| `Error: Nothing here is called "…"` (exit 2) | no device, group or service with that id | `ls`, `ls group`, `ls service`, or `find <text>` |
| `404 unknown_control` | no such control on this device (or wrong qualifier) | use a name from the element's `controls` list |
| `400 ambiguous_control` | two capabilities share that bare name | use the qualified form the message names |
| `409 not_supported` | control exists but this device can't do it now | check `state.availability`; a camera on the wrong network will refuse movement |
| `409 confirmation_required` | needs `--confirm` | only if the user asked for the action |
| `400 invalid_request` / `invalid_value` | bad value shape or out of bounds | fix the value; bounds are printed beside the control, and in `actions` in the JSON |
| `Error: … needs …` (exit 2) | usage error | fix the arguments |

Exit codes: 0 ok, 1 server or device error, 2 usage.

## Media, vendor controls and configuration

- **Snapshots and video** are not controls. For a JPEG use
  `bun run ht tkenpro snapshot --host <ip> --output <file>` (needs
  `ONVIF_PASSWORD` in the environment) or the camera's page in the web UI.
- **Saved IR/RF codes** use the element commands listed by `ht <id> help`.
  The CLI tab provides copyable examples for listing, saving and sending them,
  including the code ID and optional hold duration.
- **Camera settings beyond the capability model** (status LED, motion
  detection, night vision, the 127-entry PET3T catalog) go through the vendor
  layer: `bun run ht tkenpro controls`, `tkenpro get <id>`,
  `tkenpro set <id> <value>`. Caution controls need `--confirm <id>`;
  destructive ones need the uppercase literal `tkenpro controls` shows.
- **Adding devices** is a YAML edit in `devices.yml`
  (`schemaVersion: 2`, `model` from `models`, `config` matching that model's
  schema); the running server reloads the file on save, no restart. The
  `hometruth-add-device` skill is the procedure. Renaming and rooms have
  narrow API writers (`POST /api/devices/<id>/name`, `…/room`) and UI forms.

## Writing code and tests

From TypeScript a device is a class with the same flat namespace: `new
ShellyPlus1({ id, name }, { host })` then `gate.turnOn()`, `gate.getState()`,
`gate.invokeControl("toggle")`, `gate.controls()`, `gate.describe()`. Each
capability's public methods are forwarded onto the device unless two
capabilities share the name (the blaster's `send`), and the product-typed
capability is still there (`gate.switch`). A new device model wires this with
`this.capabilities = this.expose({ … })` and an `interface X extends
CapabilityMethods<{ … }> {}` merge; see [Devices](../../docs/DEVICES.md#use-a-device-from-typescript).

The client is `src/ht/`: `index.ts` (commands), `client.ts` (one install over
HTTP and SSE), `elements.ts` (what an id names and what may be done to it),
`format.ts` (tables, elements, the graph), `local.ts` (this machine).
`runHt(argv, dependencies)` takes injected `fetch`, `env`, `stdout`, `stderr`,
`tkenpro`, `hub`, and `directReboot` so tests never touch the network (see
`src/ht/index.test.ts`).

Nothing in `src/ht/` imports the model registry or the capability list: a
control's bounds are read out of the action document the capability published
(`minimum…`/`maximum…` pairs become a range, an array becomes a set of
choices, `confirmation` becomes `needs --confirm`), so a capability that adds
a bound gets a useful line with no change to the client. Every
`<id> <control>` call goes to `POST /api/devices/<id>/controls/<control>` with
`{"value": …, "confirmed": true}`, falling back to the group or service route
when the install says there is no such device; the device resolves the name to
a capability with `resolveControl` in `src/models/device.ts`, using each
capability's static `controlIds`. A new capability class must declare
`controlIds` or nothing on it is reachable by name. The older
`POST /api/devices/<id>/capabilities/<kind>/controls/<control>` route still
exists. `ht ls model` reads `GET /api/models`, so it is the quick way to check
that a new model registered — with the server running.

For client inventory and fixed IPs, use the Network Tools script:
`bun run network clients`, then
`bun run network save <device-id> <mac> <ip>` for an enrolled device or
`bun run network reserve <mac> <ip>` for another network client.
The configured router provider implements these operations.
