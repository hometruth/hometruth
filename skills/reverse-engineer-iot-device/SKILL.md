---
name: reverse-engineer-iot-device
description: Interactive, human-in-the-loop workflow for reverse-engineering a consumer IoT device (camera, feeder, plug, sensor, blaster, anything with an app and a cloud) that has no documented local API, to assess local control and implement verified capabilities, then modelling it as a HomeTruth device under src/devices/ on top of the generic capabilities in src/models/. Use this when the user wants to "get local control of", "figure out how X talks", "map the capabilities of", "sniff / decompile / emulate the cloud for" some gadget, or mentions a vendor app they want to replace — even if they do not say "reverse engineer" — and when hometruth-add-device found neither an existing model nor a documented local route. Also use it to resume a half-finished device investigation living in ../hometruth_private/research/{device}/.
---

# Reverse-engineering an IoT device into a HomeTruth model

All investigation material stays in the private installation workspace. The
paths below use the sibling convention `../hometruth_private/research/`;
substitute the user's chosen private directory. Public product source paths
are relative to the HomeTruth source checkout. Never commit credentials or raw
captures, even privately; do not copy research notebooks or helpers to public
docs or tools. See `docs/REPOSITORIES.md` for the boundary and checks.

Before any LAN discovery, UniFi SSH, VLAN, client-inventory, bridge-port, or
access-point capture work, load the project `hometruth-network` skill
(`skills/hometruth-network/SKILL.md`). Use its network layout and SSH
credential rules as the local source of truth, then use this skill's
`references/network-recon.md` for device-specific reconnaissance procedure.

Map the capabilities the user wants, distinguish verified local paths from
cloud dependencies and unknowns, and implement a `DeviceModel` in `src/devices/<kind>/<product>/` that composes the generic
capabilities in `src/models/`. Everything learned along the way is written to
`../hometruth_private/research/<device>/` so later work can reuse the evidence without assuming it applies elsewhere.

This is slow, deep, joint work with a human. The human owns the device, the
router, the vendor app, and the physical room; you own the probing, decoding,
decompiling, and code. Treat it as a conversation with long tool-heavy
stretches, not a script.

## Before starting

Read `AGENTS.md`. Agents may start, stop and restart HomeTruth development and
production services as needed for the requested investigation. Use
available tools and existing authorization; request additional access only
when a concrete investigation step needs it. Do not require a particular
agent vendor or model. Establish the user's scope for network changes,
physical commands and hardware access without repeatedly asking for actions
already authorized. Some devices have no feasible local route; report that
limit when evidence supports it.

## Phase 0: the brief (talk first)

Ask, and record in `../hometruth_private/research/<device>/00-brief.md`:

1. What is it? Brand, product name, model number, firmware version if visible,
   what the app is called, whether it has a cloud account, what it physically
   does. Photos of labels help; FCC IDs are gold (they lead to teardown photos).
2. Which capabilities matter? Enumerate everything the app can do, then mark
   which ones the user wants locally. "All of it" is a fine answer.
3. Which HomeTruth capabilities does that map onto? Read `src/models/capability.ts`
   for the current kinds (camera, treatDispenser, light, binarySwitch, blasters,
   motionSensor...). If the device needs a kind that does not exist yet, say so
   now; a new abstract capability in `src/models/` is part of the deliverable.
4. Safety envelope: what is destructive (factory reset, firmware update,
   unpair), what is physical (dispense, move, sound), what is merely noisy.
   Agree on what needs an explicit announcement before each use.
5. Network context: what router/controller (UniFi, OpenWrt, ISP box), whether
   the device is on its own VLAN, whether the user can SSH into the router and
   access points, whether there is double NAT upstream.

Create `../hometruth_private/research/<device>/` with the layout in
[references/research-layout.md](references/research-layout.md) and keep a
running `JOURNAL.md` there from the very first command. Every finding, dead
end, and byte offset goes in the journal with a date; the journal is what
keeps a multi-week investigation from repeating itself across sessions.

## Phase 1: community research before anything else

Do this before probing and again whenever you hit a wall. Cheap consumer
devices are rarely unique: the SoC vendor SDK, the P2P library, the cloud
protocol and public protocol constants may be shared across brands. Search for:

- The product, the brand, the OEM behind the brand (the app publisher, the FCC
  grantee), and the SoC (Ingenic, Hisilicon, Realtek, ESP32...).
- Home Assistant custom components, OpenHAB bindings, ioBroker adapters,
  Homebridge plugins, and `awesome-*` lists for the vendor or the P2P stack.
- Alternative firmware projects (Thingino, OpenIPC, Tasmota, ESPHome, OpenWrt)
  and their brand/board tables.
- Security disclosures and CVEs for the vendor or its SDK; they often spell out
  the exact key derivation or auth scheme.
- Teardowns, FCC internal photos, UART pinouts, flash dumps.

Clone anything relevant into `../hometruth_private/research/<device>/community/` and write a
one-paragraph summary of what each project already proves. Check reusable community findings before duplicating an investigation.
Verify applicability to the selected model and firmware. See [references/community-research.md](references/community-research.md).

## Phase 2: find it on the network

Work outward from what needs no credentials:

1. Confirm the device is on the LAN at all. If the vendor app has not set it
   up yet, the human does that first with the vendor app; note the exact
   onboarding flow (QR code, BLE, SoftAP) because that flow is itself a
   protocol worth capturing.
2. Identify it: ARP/DHCP lease from the router, MAC OUI, mDNS/SSDP/WS-Discovery
   answers, vendor UDP broadcast discovery, TCP/UDP port scan. Record the IP,
   MAC, hostname, open ports, and any banner in `../hometruth_private/research/<device>/network.md`.
3. Watch its DNS. Which hostnames does it resolve at boot and during each
   app action? Those are the cloud endpoints you will later need to capture,
   emulate, or redirect. Router-side DNS logs or a short capture on the
   gateway are enough.
4. Enable any standards-based surfaces the device supports (ONVIF, RTSP, MQTT,
   HTTP APIs) through the vendor app if that is the only way, and verify them
   directly. Standards-based control is the cheapest local path and often
   covers video, PTZ, and imaging with zero reverse engineering.

Tooling caveats and probing recipes live in
[references/network-recon.md](references/network-recon.md), including the
macOS Local Network privacy trap where one runtime gets `EHOSTUNREACH` on the
LAN while `curl` and `/usr/bin/python3` work fine. When discovery fails
instantly, suspect your own sandbox before the device.

## Phase 3: capture the app talking to the device

Where authorized and feasible, capture the official app performing the
requested action so you can compare behavior. Mark unobserved actions as such. Plan the
capture point carefully:

- App to device traffic may be LAN P2P, cloud relayed, or both, and it changes
  with conditions (same Wi-Fi vs. cellular). Do not assume.
- Modern gateways and access points offload flows to hardware, so `tcpdump`
  on the router can see nothing while traffic flows fine. The Wi-Fi access
  point the device is associated to, with hardware offload disabled for the
  duration, may expose traffic missing from a gateway capture. Confirm the interface and
  visibility on the selected hardware before changing offload settings.
- A device may hold two identities (a LAN address and an upstream or backup
  network address). If captures are inexplicably empty, check where the device
  actually thinks it is (its own IP/gateway config, the router's client list,
  a second SSID it was provisioned with).
- Name captures by action: `captures/2026-09-01-app-feed.pcap`,
  `captures/…-baseline-idle.pcap`. Always take an idle baseline.
- Ask the human to perform one action at a time, on cue, and log the wall
  clock time of each action so you can align it in the capture.

Full procedure, including UniFi and OpenWrt specifics, SSH capture streaming,
and TLS interception options, in
[references/packet-capture.md](references/packet-capture.md).

## Phase 4: decode the protocol

With captures in hand, work layer by layer and write a decoder script per
layer in `../hometruth_private/research/<device>/tools/`. Prefer small standalone scripts that read
a pcap and print structural facts (lengths, magic bytes, sequence numbers,
command IDs) over ad hoc hex staring; you will rerun them dozens of times.

- Identify framing first: magic bytes, length fields, checksums, sequence
  counters. Confirm each guess against every packet in the capture, not one.
- Separate transport (KCP, UDP reliability, TCP, WebSocket), envelope
  (vendor message header), and payload (JSON, protobuf, TLV, media frames).
- Look for encryption by statistics: repeated aligned blocks or identical prefixes suggest hypotheses about
  framing, plaintext repetition or encryption modes. Verify with known test
  vectors and multiple messages; those patterns alone do not identify a cipher.
- Keep a running catalog of command IDs, property IDs, and their observed
  values in `protocol.md`. The vendor app usually has a much larger catalog
  than this one device uses; record both, and mark which are confirmed.

Techniques and pitfalls in [references/protocol-decoding.md](references/protocol-decoding.md).

## Phase 5: decompile the app and its native libraries

When captures show the shape but not the semantics (what is command 0x131a,
how is the auth hash built, which key), go to the code:

- Android APK/XAPK via `jadx` for Java/Kotlin; look for the API client,
  request signing, property catalogs, and constants. The static catalog of
  every property the app knows is often extractable as JSON in one pass.
- Native `.so` libraries via Ghidra headless with small reusable Java scripts
  (decompile-at-address, string cross-references, call context). Keep the
  Ghidra project in `../hometruth_private/research/<device>/ghidra/` and the scripts in
  `../hometruth_private/research/<device>/tools/ghidra/`.
- Verify every decompiler finding against the wire. Decompiled code shows what
  a code path does, not which code path this firmware generation takes. A
  key-derivation routine can be real, reproduced bit-exactly, and still not be
  the key the device accepts.
- iOS apps and desktop apps are secondary sources; use them when the Android
  build lacks a feature.

Workflow and script templates in [references/decompilation.md](references/decompilation.md).

## Phase 6: get on the device itself when the network is not enough

Some behaviour is only visible from inside: which server hostnames are
hard-coded, whether there is a LAN command path at all, what the firmware
does with a property you set. Options, in order of invasiveness:

1. Any exposed shell (telnet/SSH, debug ports, vendor "developer mode").
2. Firmware images: pull from the vendor OTA URL seen in captures, unpack with
   `binwalk`, grep for hostnames, keys, and command tables.
3. UART on the board, U-Boot console, dump the flash before changing anything.
4. Community firmware (Thingino, OpenIPC, Tasmota...) when the SoC is
   supported. This replaces the vendor protocol problem with a standard one,
   at the cost of hardware risk. Only suggest it when the user has the skills
   and appetite; write the path up in `../hometruth_private/research/<device>/custom-firmware.md`
   even if it is not pursued.

See [references/device-access.md](references/device-access.md).

## Phase 7: emulate the cloud locally

For a device whose cloud protocol can be reproduced locally, investigate a
local service replacement. Certificate validation, provisioning and key access
may make this infeasible; do not assume DNS redirection is sufficient:

1. From captures, catalog every hostname the device resolves and the exact
   request/response it expects from each (discovery/root service, registration,
   heartbeat, config bootstrap, signaling, media relay).
2. Override those hostnames at the router (UniFi DNS policy, OpenWrt dnsmasq,
   Pi-hole) to point at the HomeTruth host. Keep a one-command toggle and know
   how to make the device re-resolve (Wi-Fi kick, reboot); devices hold their
   old TCP session for minutes otherwise.
3. Implement only what the device actually asks for, in the order it asks,
   with an allow-list of device addresses and constant-time auth checks.
4. Bootstrap per-device secrets once with the real cloud (or a capture of the
   device registering) and store them outside git with owner-only permissions.
5. Determine the actual enrollment and authentication flow. A rejected
   registration can provide structural evidence, but never accept unauthenticated
   commands or treat an arbitrary placeholder key as a valid credential.

Patterns in [references/cloud-emulation.md](references/cloud-emulation.md).

## Phase 8: verify each capability, then model it

Verification before modelling, one capability at a time:

- Non-physical settings first, starting with reads, then same-value writes only where the protocol
  documents them as harmless. Check changed values through readback.
- Physical actions individually, announced, bounded (one portion, one short
  movement with a guaranteed stop, one second of tone), with state restored in
  a `finally`.
- Record what "verified" means for each: transport ACK, state read-back,
  sensor confirmation, or human confirmation ("I heard it"). Never upgrade a
  transport ACK into a physical result; accepting audio frames does not prove audible output.
- Keep an audit script in `../hometruth_private/research/<device>/tools/` that re-checks every
  verified control so regressions show up before the human notices.

Then build the model, following the existing products as templates:

1. Read `src/models/device.ts`, `src/models/capability.ts`, and one existing
   product (`src/devices/switches/shelly-plus-1/index.ts` is the smallest).
2. Wire-level code goes in `src/protocols/<vendor>/` with no device knowledge.
   Shared vendor services (account, hub emulator, DNS toggling) go in
   `src/vendors/<vendor>/`. The product folder `src/devices/<kind>/<product>/`
   holds the `Device` subclass, the `DeviceModel` record with a config schema,
   one class per capability implementing the abstract capability from
   `src/models/`, and the control catalog.
3. If a needed capability kind is missing from `src/models/`, add the abstract
   class there first, mirroring `binary-switch.ts`: the schema document is the
   contract, `describe()` validates it, `invoke()` is the single write path,
   `controlIds` lists the JSON control names and `methods` the public
   TypeScript methods. In the `Device` subclass set
   `this.capabilities = this.expose({ … })` and add
   `export interface <Product> extends CapabilityMethods<{ … }> {}` so the
   capabilities' methods are forwarded onto the device (`gate.turnOn()`) and
   reachable by bare name from the CLI (`ht gate-relay on`).
4. Register the model, add a `devices.example.yml` entry, and write unit tests
   with synthetic fixtures reproducing protocol shapes and fresh test identities
   and keys. Raw captures and personal media must not enter the public repo.
5. Run `bun run typecheck` and focused tests with injected transports. Do not
   run fixtures or browser tests that start a server.

Model-writing details in [references/hometruth-model.md](references/hometruth-model.md).

## Investigation practices

- Journal continuously; supersede, never delete. When a finding turns out
  wrong, add a dated correction at the top of the old entry pointing to the new
  one. Agents that read stale "FIXED" notes without the correction lose days.
- Keep diagnostics structural. Log lengths, command IDs, offsets, and success
  or failure; never dump keys, tokens, captured payloads, or Wi-Fi
  credentials into logs, chat, or the journal. Device configs frequently
  contain plaintext Wi-Fi passwords.
- Distinguish "the code does X" from "this device accepts X". The wire is the
  ground truth; decompilation and community code are hypotheses about it.
- When stuck for more than a session on a deep problem, step back and ask what
  a cheap device would do: a shared constant, a well-known library default, a
  feature the app never actually uses. Then re-run Phase 1.
- Serialize actions against the device. Consumer firmware usually accepts one
  session at a time and fails oddly on overlap.
- Let the human do the physical and account steps, and tell them exactly what
  to do and when. Record their observations verbatim in the journal.
- Never factory reset, unpair, or update firmware to "see what happens".
  Ownership bindings can survive resets, and re-pairing may need the original
  account.

## Deliverables checklist

- `../hometruth_private/research/<device>/00-brief.md`, `JOURNAL.md`, `network.md`, `protocol.md`,
  `capabilities.md` (requested capabilities, possible routes, verification status and limits), `captures/`, `tools/`, `community/`.
- `src/protocols/<vendor>/` (wire code, fixture-tested).
- `src/devices/<kind>/<product>/` with `DeviceModel`, capabilities, config
  schema, tests; registered in the model registry; example config entry.
- New abstract capabilities in `src/models/` if the device needed them.
- A supported-device catalog entry and a focused generic setup guide. Keep the
  main README free of individual-device walkthroughs.
- Memory notes for the non-obvious operational facts (which capture point
  worked, which runtime was blocked from the LAN, and device-specific diagnostics).
