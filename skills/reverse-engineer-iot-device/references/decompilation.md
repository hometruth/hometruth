# Decompiling the vendor app and native libraries

Use the app's code to answer questions the wire cannot: how a signature is
computed, what a command number means, what a property catalog contains,
which code path a device type takes. Keep the app and its outputs under
`../hometruth_private/research/<device>/apps/` (git-ignored) and the Ghidra project under
`../hometruth_private/research/<device>/ghidra/` (git-ignored).

## Getting the app

- Android APK or XAPK from the user's phone (`adb pull`) or a reputable
  mirror; record the exact version, since protocol details change between
  releases and your captures came from the user's installed version.
- Split APKs: extract the base plus the `arm64_v8a` config split; native
  libraries live in `lib/arm64-v8a/`.
- iOS: decrypted IPAs require a jailbroken device; treat as secondary.
- Desktop or web apps: JavaScript bundles are the easiest source of all;
  pretty-print and grep.

## Java/Kotlin with jadx

```bash
jadx --deobf -d apps/<app>-<version>/jadx apps/<app>-<version>/base.apk
```

Then grep for what the captures showed: hostnames, ports, magic numbers as
decimal and hex, JSON keys, error strings. Targets worth extracting into JSON
under `../hometruth_private/research/<device>/catalog/`:

- The property/IoT catalog: enums or constant classes mapping names to
  numeric IDs, with read/write hints from the setters that reference them.
- The direct command catalog: URL paths and JSON bodies the app builds for
  device-side HTTP-like APIs.
- Request signing: HMAC inputs, expiry rules, header names. Reproduce the
  signature for one captured request before trusting your reading.
- Login and device-list flows: they yield per-device secrets (host keys,
  licence IDs, capability flags) you may need to bootstrap local control.
- JNI boundaries: which Java methods call into which native library with
  what JSON or struct; this is your map into the `.so`.

Write extractors as scripts (`tools/extract-<thing>.ts`) rather than manual
notes so re-running on a new app version is one command.

## Native libraries with Ghidra headless

Import once, analyze once, then run read-only scripts:

```bash
analyzeHeadless ghidra <project> -import apps/<app>/lib/arm64-v8a/lib<x>.so
analyzeHeadless ghidra <project> -process lib<x>.so -noanalysis \
  -scriptPath tools/ghidra -postScript DecompileAt.java 002e39f0 002e3fa8
```

Keep a small kit of reusable Ghidra Java scripts in `tools/ghidra/`:
decompile-at-address, decompile every function referencing a string,
list references to an address, find call context around a function, search
decompiled text in an address range, dump bytes and instructions at an
address. Each prints to stdout so the results can be saved beside the journal.
Ghidra needs its user cache directory writable; sandboxed runs fail until
that path is allowed.

Reading strategy:

1. Start from strings: log messages, format strings, hostnames, realm
   strings, JSON keys. Cross-reference to functions; name them as you go.
2. Follow the send path from the JNI entry to the socket write and record
   every header the library builds, with offsets and byte order.
3. Follow the receive path in reverse; the parser tells you the exact
   validation the device's peer applies, which is what you must satisfy.
4. Identify library-provided crypto by its tables: DES SP-boxes, AES S-box,
   MD5/SHA constants. Byte-compare against the reference implementation
   rather than re-deriving; if the tables match OpenSSL, the standard
   cipher in Node is already an exact model.
5. Watch for dispatch on device type, protocol version, or "factory" fields.
   The library may contain several transports; the one your device uses is
   selected at runtime from data you must recover (device table, capability
   flags, login JSON).

## The verification rule

A decompiler finding is a hypothesis until a captured byte confirms it.
Specifically:

- Reproduce the finding bit-exactly (a key derivation, a header layout) and
  test it against the capture's known-plaintext block or header before
  writing product code.
- Static constants in the library can be overwritten at runtime, selected
  per protocol version, or unused by the firmware generation you have.
  A real, reproducible derivation that does not match the wire is a real
  derivation for some other device.
- When decompilation and community code disagree, the capture decides.

## Firmware images

If captures or the app expose an OTA URL, download the firmware image and
run `binwalk -e`; grep the extracted filesystem for hostnames, ports, key
material, and command tables. Firmware shows the device's side of the
protocol, which the app never does, and reveals whether a LAN-only command
path exists at all (it often does not: every write goes through the cloud
session, so the cloud must be emulated).
