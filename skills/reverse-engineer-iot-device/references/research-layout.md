# ../hometruth_private/research/<device>/ layout

One directory per device, named after the product (`../hometruth_private/research/acme-pet-feeder/`).
It is a lab notebook plus the throwaway tools used to fill it. Nothing in it is
compiled into the app; the durable result of the research is the code under
`src/protocols/`, `src/vendors/`, and `src/devices/`.

```
../hometruth_private/research/<device>/
  00-brief.md          what it is, what we want, safety envelope, autonomy granted
  JOURNAL.md           dated log of every finding, dead end, correction
  network.md           identity: IP/MAC/hostname, ports, DNS names it resolves, discovery replies
  protocol.md          framing, envelopes, command/property catalog, crypto, verified vs inferred
  capabilities.md      capability coverage (see below)
  custom-firmware.md   only if Phase 6 option 4 was investigated
  captures/            pcaps named <date>-<who>-<action>.pcap plus decoded sidecars (*.json)
  tools/               standalone decoders, probes, audits, bootstrap helpers, Ghidra scripts
  community/           cloned or vendored community projects with a README summarising each
  apps/                extracted APK/XAPK, jadx output, native libs (git-ignored, large)
  ghidra/              Ghidra project files (git-ignored)
```

Keep all `apps/`, `ghidra/` and `captures/` directories ignored in the private
repo. Never commit raw captures, even if a scanner reports no credentials. Captures of the device's own registration or
config traffic almost always contain secrets; keep those under a `0700`
directory outside the repo (for example the app's private state directory)
and refer to them from the journal by name only.

## JOURNAL.md conventions

- One `##` heading per session or per finding, prefixed with the date.
- When a later finding contradicts an earlier one, do not edit the old text.
  Add a bold `SUPERSEDED — see <date/heading>` line at the top of the old
  entry and write the new one. Readers arriving at the old entry must see the
  correction before the stale claim.
- Record what was tried and failed with the same care as what worked.
  "Tried X, Y, Z against the known-plaintext oracle; zero matches" is what
  stops the next session from trying X again.
- Record human observations verbatim with a timestamp ("user: heard a beep at
  14:02, quiet but clear").
- End each session with a "state of the device" line: what is enabled,
  what was changed and restored, whether anything is mid-flight.

## capabilities.md: capability coverage

A table of requested capabilities and any additional ones discovered. Mark
unknown or out-of-scope entries explicitly. The following is a hypothetical
example, not a protocol recipe. Columns:

| Capability | App location | Local route | Verification | Notes |
| --- | --- | --- | --- | --- |
| Live video | Home tile | RTSP 8554 (after enabling ONVIF in app) | human saw frames | H.264 main stream only |
| Dispense one portion | Feed button | documented vendor command | transport ACK + human saw treat | one at a time; firmware serializes |
| Factory reset | Settings > Device | deliberately excluded | n/a | destructive |

Verification levels, weakest to strongest: `inferred`, `transport ACK`,
`state read-back`, `sensor confirmed`, `human confirmed`. Write the level, not
"works". The model's control descriptors later mark anything below
`state read-back` as unconfirmed.

## tools/ conventions

- Standalone: each script runs with the repo's runtime (`bun tools/x.ts`) or
  `/usr/bin/python3`, takes paths and addresses as arguments, and prints
  structural output. No imports from `src/` that would break when the product
  code is refactored.
- Read-only by default. Anything that sends to the device says so in its
  header comment and requires an explicit flag for physical or destructive
  actions.
- Never print secrets. Print lengths, offsets, hashes of secrets if you must
  compare them.
- Keep the successful ones. A probe that found the answer becomes the audit
  that proves it still holds.
