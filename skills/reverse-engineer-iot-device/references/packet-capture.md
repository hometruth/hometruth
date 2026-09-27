# Packet capture

Ground truth for every capability is a capture of the official app performing
it. Plan where to capture, how to defeat hardware offload, and how to align
the human's actions with the packets.

## Where the traffic actually flows

Before choosing a capture point, establish the path for each traffic class:

- App to device on the same Wi-Fi: may be direct P2P (UDP hole punching or
  LAN discovery), may be relayed through the cloud even when both are local,
  and may switch between the two mid-session. Mobile apps frequently prefer
  relay when the phone is on cellular or when the LAN path fails.
- Device to cloud: persistent TCP (often on unusual ports like 18665 or
  8883) plus periodic HTTPS. This carries registration, heartbeat, config,
  and command routing.
- Media: UDP, sometimes over a reliable-UDP layer (KCP), sometimes TCP.

Devices with two network identities (a second SSID, an upstream router's
network, a wired plus wireless interface) can send cloud traffic on a path
your gateway never sees. Check the device's real default gateway and the
router's client list before assuming the capture point is right.

## Capture points, best to worst

1. The Wi-Fi access point the device is associated to, on the device's
   association interface. Sees everything the device sends and receives,
   including LAN-direct traffic to a phone on a different AP.
2. The gateway/router, on the device's VLAN interface. Sees device-to-cloud
   and cross-VLAN traffic, misses same-VLAN switched traffic.
3. Port mirroring on a managed switch to a laptop running Wireshark.
4. The operator host, only for traffic that host is party to (your own emulator,
   your own probes).
5. ARP spoofing or a rogue AP. Avoid unless the user asks; it destabilises
   the network and gets noticed by controllers.

## Hardware offload will hide traffic

Modern UniFi gateways and APs (Qualcomm ECM/SFE/PPE, Wi-Fi FSE, fast-xmit)
and many OpenWrt targets with flow offloading push established flows past the
kernel, so `tcpdump` sees a handful of packets from a flow that is clearly
running. Symptoms: a 45-second capture with 3 packets from a live video
stream; a known RTSP flow to an NVR that shows one packet.

Fix for the duration of the capture, then restore:

- UniFi (root shell over SSH): stop the flow accelerator and flush its
  database, and on APs also disable the Wi-Fi FSE and fast-xmit sysctls.
  Knobs live under `/sys/kernel/debug/ecm/` and `/proc/sys/net/ecm/`.
  Verify with a canary flow you know is running (a camera's RTSP to an NVR):
  packet counts should jump by orders of magnitude when offload is off.
- OpenWrt: disable `flow_offloading` and `flow_offloading_hw` in the firewall
  config, or `ethtool -K <if> ...` for NIC offloads.

Write the exact knob sequence you used into `tools/capture-<point>.sh` with
restoration in the same script.

## Streaming captures off the network gear

Do not write pcaps onto routers or APs; stream them back:

```bash
ssh -i <key> root@<ap> 'timeout 45 tcpdump -i <iface> -s0 -U -w - <filter>' > captures/<date>-<who>-<action>.pcap
```

Run two in parallel when the phone and the device are on different APs
(device side unfiltered on its association interface, phone side filtered
by the phone's MAC). Keep filters narrow on busy interfaces; `-s0` always.

UniFi gear needs SSH enabled in the controller and either the device
password or an authorised key. UniFi OS gateways may require
keyboard-interactive auth; store nothing but the key path in scripts.

## Procedure per action

1. Take an idle baseline of the device for a minute with the app closed.
2. Start the capture, confirm both "listening on" lines appear.
3. Cue the human: "now press Feed once, then say done". Log wall-clock time
   of each cue and each "done" in the journal.
4. Stop, restore offload, verify the pcap opens and contains the device.
5. Immediately run your decoders and write the first structural notes while
   the human is still available to repeat.

Capture each action at least twice (once for discovery, once to confirm the
constant parts are constant). Include app start, app stop, and the
onboarding flow itself.

## TLS

Device-to-cloud HTTPS is opaque without keys. Options: the app may pin
certificates (then it needs patching or Frida), the device rarely pins (a
local CA via DNS redirection works if you can get the device to trust it,
which is uncommon), or skip TLS interception and get the same information
from the decompiled app's request builders and the cloud's responses to your
own authenticated calls. For the app side, an Android emulator or rooted
device with a user CA and Frida SSL-unpinning scripts is the standard route;
`mitmproxy` records the session. Get the user's consent before intercepting
their account traffic and never store the captured credentials in the repo.

## Naming and sidecars

`captures/<yyyy-mm-dd>-<source>-<action>.pcap` where source is `app`,
`router`, `ap`, `mac`. When a decoder produces structured output, save it as
`<pcap>.<layer>.json` beside the pcap. Compress large ones; delete none.
