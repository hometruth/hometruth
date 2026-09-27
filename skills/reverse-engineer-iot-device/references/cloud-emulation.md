# Emulating the vendor cloud locally

Many devices have no LAN command path: every write travels device-initiated
over a persistent session to the vendor's servers, and the app's commands are
routed back down that session. A local replacement may be possible if its authentication and service
requirements can be reproduced. Investigate standards-based and existing LAN
paths first. Firmware strings alone do not prove that no such path exists.

## 1. Map what the device expects

From DNS watching and captures, list every hostname the device resolves and
what it does with each. Typical roles:

- Root/discovery: the device asks one well-known name for the addresses of
  everything else (often a tiny UDP protocol). Answering this lets you point
  every other role at yourself without more DNS entries.
- Registration/platform: persistent TCP; the device authenticates with a
  device password or key, then heartbeats. Commands from the app are routed
  down this socket.
- Data/config: a second persistent session or an HTTP service the device
  polls at bootstrap for server-owned settings.
- Signaling and media relay: STUN/TURN-like servers and relays used to set
  up P2P sessions with the app.
- Firmware, time, telemetry, media upload.

For each, record the exact request and response bytes the real cloud used
(from captures) and the minimum the device needs to proceed.

## 2. Redirect the device

Override only the names the device uses, at the resolver the device uses:

- UniFi: DNS policy A records via the integration API; write a toggle
  script (`on`, `off`, `status`) and note the device keeps its old TCP
  session for minutes after a flip unless kicked or rebooted.
- OpenWrt/dnsmasq: `address=/<hostname>/<hometruth-ip>`.
- Pi-hole/AdGuard: local DNS records.

Verify the override from the device's point of view, not just the operator host's: resolve
the name through the LAN gateway's resolver, since the operator host may use a
different upstream. Keep the override reversible in one command and make
sure the official app still works with the override off, because the human
needs it for future ground-truth captures.

## 3. Implement the minimum, in the device's order

- Answer discovery with your own addresses for every role.
- Accept registration only from an allow-list of device addresses and
  identities, comparing the device's proof in constant time; the emulator is
  a server on the LAN and will be poked.
- Implement heartbeats exactly (interval, payload), then the command
  routing the app used, then config bootstrap, then signaling and media.
  Stop as soon as the capabilities the user wants are covered.
- Distinguish properties written over the command channel from properties
  the device fetches from the config server at bootstrap; the latter require
  persisting the value locally and recycling the device's connection so it
  re-fetches.
- Fragmentation, encryption, and checksum variants observed between the real
  peers must all be accepted; the device may emit variants the app never did.

Keep the emulator in `src/vendors/<vendor>/` as a service the product's
`Device` consumes, with the wire codecs in `src/protocols/<vendor>/`.

## 4. Bootstrap per-device secrets once

The device authenticates to the cloud with material you do not have (a
device password, a host key, a licence ID, capability flags). Sources:

- The real cloud, through the user's account, using the signed API you
  recovered from the app. One-time, with consent, then never again at
  runtime.
- A capture of the device registering: the registration frame carries the
  proof you need to whitelist it.

Enrollment is protocol-specific. A registration capture may contain a proof
or identifier without revealing a reusable secret. Do not assume a dummy key
can bootstrap trust or disable authentication to accept a device. Keep any
bootstrap scoped to the authorized device and verify the actual proof.

Store credentials outside Git with owner-only permissions. Use the relevant
service's reload contract after saving; agents may restart HomeTruth when
necessary. Public support must not depend on private bootstrap scripts.

## 5. Operate it

- Make the "which side is the device on" state visible: resolve the vendor
  name through the gateway, check the emulator's registration table, and
  show cloud vs local in the UI.
- Provide "reconnect now": a Wi-Fi kick or reboot that makes the device
  re-resolve, with a guard against kicking a device already on the wanted
  side (firmware may fall back to the other side).
- Expect devices with backup networks to wander off to another subnet after
  a kick; provide a locate-and-reboot recovery that finds the device via
  whatever path still answers (cloud config, ONVIF at the stray address).
- Log structurally. Registration frames and config payloads contain
  secrets, including Wi-Fi passwords in plaintext.
