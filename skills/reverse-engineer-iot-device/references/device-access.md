# Getting onto the device

When the network does not answer a question (does the firmware have a LAN
command path? what does it do with property X? which hostnames are
hard-coded?), look inside the device. Escalate only as far as needed and only
with the user's explicit consent for anything physical.

## 1. Existing shells and debug surfaces

- Telnet/SSH with default or app-derived credentials (check community
  disclosures; many SoC SDKs ship a fixed root password).
- Vendor "developer mode" or hidden menus in the app (tap-the-version-number
  style), which sometimes enable RTSP, ONVIF, telnet, or log export.
- Log export or diagnostic upload features in the app: the produced files
  reveal the firmware's view of its network and config.
- Serial-over-USB: some devices enumerate a console on their USB port.

## 2. Firmware images

Source: OTA URL from captures or the decompiled app's update client, the
vendor's support site, or community mirrors. Verify checksums against what
the app requests. Unpack with `binwalk`, `unsquashfs`, `jefferson`, or the
SoC vendor's tools, and look for:

- The main daemon: strings, hostnames, ports, command tables, property
  handlers, default credentials.
- Init scripts and config: which services start, whether telnet/SSH exists
  and is disabled by a flag you could set.
- Certificates and keys.
- Update mechanism and signature checks (tells you whether custom firmware
  via OTA is possible or whether flash access is required).

Document findings in `protocol.md` and `network.md`; they are the device's
half of the conversation.

## 3. UART and flash

Requires the user to open the device. Standard sequence:

1. FCC internal photos and teardown videos to locate the SoC, flash chip,
   and any labelled TX/RX/GND pads.
2. Establish the board's voltage, pinout and serial settings from verified
   hardware documentation before connecting a compatible adapter. Do not
   assume 3.3 V or a particular baud rate. Observe the boot log first.
3. Interrupt U-Boot if allowed; `printenv` reveals boot args and sometimes
   credentials. Enable a root shell by editing boot args if the firmware
   permits.
4. Dump the whole flash before changing anything: via U-Boot/`mtd` from a
   root shell, or with a CH341A and SOIC clip directly on the chip. Read
   twice, diff, keep both copies outside the repo.

## 4. Community or custom firmware

When the SoC is supported by a community firmware (Thingino/OpenIPC for
Ingenic and Hisilicon cameras, Tasmota/ESPHome/OpenBeken for ESP and Beken
modules, Valetudo for vacuums), replacing the vendor firmware turns the
whole protocol problem into standard RTSP/ONVIF/MQTT/HTTP. Before suggesting
it:

- Confirm the SoC, flash size, sensor, and Wi-Fi chip against the project's
  supported-board list. A missing board means a port, not an install.
- Confirm a recovery path exists (U-Boot TFTP or serial recovery) and that
  the user has the full flash dump.
- Confirm the user understands the device leaves the vendor ecosystem and
  the app stops working.
- Write the assessment in `../hometruth_private/research/<device>/custom-firmware.md` even if the
  answer is "not now": hardware identification, closest supported board,
  steps, risks. It is valuable even unpursued.

Never flash via the vendor OTA path with an unsigned image, and never test a
build on the only unit the user owns without a serial console attached.

## 5. The network control plane

The router and access points are part of the device's environment and
usually the most productive thing to have a shell on:

- UniFi: enable SSH in the controller, use key auth, root shell on gateway
  and APs. DNS overrides via the integration API, client kicks via the
  classic API, both with one API key. Kicking a Wi-Fi client is the fastest
  way to make a device re-resolve DNS and reconnect (seconds instead of the
  heartbeat timeout), but firmware may fall back to another saved network or server after a kick.
  Avoid disrupting a device that is already connected as intended.
- OpenWrt: `uci` for dnsmasq overrides, `ubus`/`hostapd_cli` for client
  management, `tcpdump` available via opkg.
- Consumer ISP routers: usually only DHCP reservations and, sometimes,
  custom DNS. If the device must be redirected and the router cannot, run a
  resolver on the HomeTruth host and hand it out via DHCP.

Record the exact API calls and shell commands in `tools/` with the
credentials read from the environment, never embedded.
