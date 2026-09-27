# Network reconnaissance

Goal: know the device's identity, every port it listens on, every hostname it
resolves, and every standards-based surface it exposes, before touching any
vendor protocol.

## Your own sandbox first

When every probe fails instantly with `EHOSTUNREACH` or "No route to host"
while internet hosts work, the device is probably fine and your runtime is
blocked. On macOS Sequoia and later, Local Network privacy blocks per binary:
one runtime (bun, Homebrew python) can be blocked while `curl`, `nc`, `ping`,
and Apple's `/usr/bin/python3` work from the same shell. Test with `curl` or
`nc` before blaming the device, and tell the user which binary to allow under
System Settings > Privacy & Security > Local Network. The block can be
intermittent, so try the preferred runtime first and fall back.

Also check: VPNs and split tunnels, Docker or VM network isolation, a host on a
different VLAN from the IoT network, and firewall rules on the router between
VLANs.

## Identify the device

1. Router client list or DHCP leases: IP, MAC, hostname, which SSID/AP/port,
   last seen. On UniFi the classic API `stat/sta` lists clients by IP with
   the same API key used for DNS policies; OpenWrt has `/tmp/dhcp.leases`.
2. MAC OUI lookup for the Wi-Fi module vendor (often not the brand).
3. Multicast/broadcast discovery, each with a short listener:
   - mDNS (`dns-sd -B _services._dns-sd._udp` on macOS, `avahi-browse -a`)
   - SSDP (`M-SEARCH` to 239.255.255.250:1900)
   - WS-Discovery for ONVIF (`Probe` to 239.255.255.250:3702)
   - Vendor UDP broadcasts: watch for anything the device sends on boot, and
     try the app's discovery packet once you have captured it. Vendors often
     answer on a different port than they were asked on.
4. Port scan TCP and UDP, then banner-grab. Note that some firmware exposes
   no ports until a feature (ONVIF, RTSP, local API) is enabled in the app,
   and closes them again when it is disabled. Re-scan after every app toggle.
5. Devices provisioned with a backup Wi-Fi network or dual identity can
   appear on a different subnet than expected (an upstream router's network,
   a guest VLAN). If the cloud says "online" and the LAN says nothing, read
   the device's own view of its IP/gateway through whatever path is available
   before assuming it is off.

Record everything in `network.md` and save a JSON copy of raw discovery
replies in `captures/`.

## Watch its DNS

The hostnames a device resolves are the map of its cloud dependencies and the
list of names you may later have to redirect. Options:

- Router DNS query logs (UniFi has none by default; OpenWrt dnsmasq with
  `log-queries`; Pi-hole and AdGuard Home log everything).
- A short capture on the gateway filtered to `udp port 53 and host <device>`.
- Point the device's DHCP DNS at a logging resolver you run.

Trigger each app action while watching, and note which names are resolved
at boot, on a schedule, and per action. Resolve them yourself and note the
IPs, ports, and TLS certificate subjects.

## Standards-based surfaces

Check each, because every one you find is a capability with zero protocol
work:

- ONVIF (device, media, PTZ, imaging services, usually TCP 80/8000/8080) and
  RTSP (554/8554). Credentials are often `admin` plus a password set in the
  app. WS-Security digest auth is the norm.
- HTTP/JSON local APIs (Shelly, Elgato, Tasmota-style `/rpc`, `/cm`,
  `/elgato/lights`). Try `GET /`, `/api`, `/rpc`, `/status`, `/cgi-bin/`.
- MQTT (1883/8883), CoAP (5683), Matter/Thread, Zigbee bridges, Bluetooth LE
  advertisements (use a supported host Bluetooth tool or a phone app to enumerate
  services).
- Telnet/SSH (23/22), FTP, SMB, UPnP control URLs.

If a standards surface exists only after an app toggle, capture the toggle:
the app sometimes performs it through a property write you can reproduce
without the app later.

## What "found it" means

You are done with this phase when `network.md` has: stable identity (IP,
MAC, serial if visible), a port table with what answers on each, the DNS
hostnames grouped by when they are resolved, and a list of standards-based
capabilities already verified by hand.
