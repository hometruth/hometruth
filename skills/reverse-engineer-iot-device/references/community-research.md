# Community research

Run this phase first and repeat it every time you are stuck. The reasoning:
consumer IoT devices are built from a small number of SoC SDKs, P2P libraries,
and cloud platforms that are white-labelled across hundreds of brands. Somebody
has usually already done the hard part for a sibling device.

## What to search for

Search each of these separately, with and without the word "protocol",
"local", "home assistant", "reverse", "firmware":

1. The product name and model number as printed on the label.
2. The brand, and the OEM behind the brand: the app's publisher on the app
   store, the company on the FCC grant, the `Server:` header or certificate
   organisation in captures, strings in the app.
3. The cloud/P2P platform: names that appear in the app's package list or
   native library names (`libppcs`, `libtuya`, `libmrplayer`, `libxmsdk`...).
4. The SoC once you know it (FCC internal photos, teardown videos, boot logs).
5. The mobile app name plus "APK" for the decompilation phase, and plus
   "API" for anyone who has documented its cloud endpoints.

## Where to look

- GitHub and GitLab code search for the vendor's distinctive strings: magic
  bytes, hostnames, constants, error messages, property names from captures.
  Searching for an exact 24-character constant found in a native library is
  often more productive than searching for the brand.
- Home Assistant custom components (HACS), `home-assistant/core` integrations,
  OpenHAB bindings, ioBroker adapters, Homebridge and Scrypted plugins,
  Node-RED nodes, Domoticz plugins.
- Alternative firmware projects and their brand/board tables: Thingino and
  OpenIPC for IP cameras, Tasmota/ESPHome/OpenBeken for ESP and Beken
  plugs/bulbs, OpenWrt for anything router-like, Valetudo for vacuums.
- Security research: CVE databases, vendor advisories, conference talks,
  runZero/Bitdefender/Nozomi style disclosures. These frequently publish the
  exact key derivation, default credentials, or unauthenticated endpoints.
- FCC ID database for internal photos, block diagrams, and test setup
  descriptions. The grantee name identifies the OEM.
- iFixit, EEVblog forums, Hackaday, and hobbyist blogs for UART pinouts and
  flash chip identification.
- Wireshark dissectors and pcap repositories for the protocol family.
- App store reviews and vendor forums for hints about hidden features (RTSP
  toggles, ONVIF menus, "developer mode").

## What to do with what you find

- Clone into `../hometruth_private/research/<device>/community/<project>/` and write a
  `README.md` beside it: what the project proves, which files matter, what it
  gets wrong for this device. Note the commit hash.
- Extract constants and compare with your captures immediately. A candidate
  encryption key is confirmed or rejected in seconds against a known-plaintext
  block; do that before reading any more code.
- Prefer projects that talk to the device locally over ones that wrap the
  vendor cloud API, but read both: cloud wrappers document the property
  catalog and the signing scheme.
- Credit the source in `protocol.md` and in code comments. Check licences
  before copying code rather than facts.

## A caution about confidence

Community code is a hypothesis about the wire, like decompilation. It may be
for a different firmware generation, region, or protocol version. Verify
against your own capture before building on it, and record the verification.
