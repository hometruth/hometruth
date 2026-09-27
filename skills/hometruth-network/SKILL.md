---
name: hometruth-network
description: Locate LAN clients, manage fixed DHCP addresses, reconnect Wi-Fi, change DNS or internet isolation, capture traffic, and admit a new wireless client using HomeTruth's router-independent Network Tools scripts.
---

# Network Tools

Run commands from the HomeTruth checkout. Use **`scripts/network.ts`** for
network operations. The script selects the site's provider; keep router API,
SSH, DHCP, and firewall implementation details out of this skill and device
workflows. Start with `bun run network capabilities` to see which
operations the configured router supports. Unsupported capabilities require a
provider implementation, not a guessed router command.

## Use the script for the operation

| Task | Script to use |
| --- | --- |
| List clients, MACs, addresses, networks, and reservations | `bun run network clients` |
| Find one device or bridge | `bun run network find <mac-or-ip>` |
| Reserve an IP for a client that is not provisioned in HomeTruth | `bun run network reserve <mac> <ip>` |
| Save a provisioned device's fixed IP in both the router and HomeTruth | `bun run network save <device-id> <mac> <ip>` |
| Reconnect a Wi-Fi device | `bun run network reconnect <mac-or-ip>` |
| Inspect a DNS override | `bun run network dns status <hostname> <server-ip>` |
| Enable or disable a DNS override | `bun run network dns on\|off <hostname> <server-ip>` |
| Inspect an internet block | `bun run network internet status <mac> <label>` |
| Change an individual router internet block | `bun run network internet on\|off <mac> <label>` |
| Capture a client's traffic to a private file | `bun run network capture <mac-or-ip> <seconds> <output.pcap>` |
| Inspect readiness for an admission window | `bun run network accept-next '<ssid>' --dry-run` |
| Admit the next new client and restore MAC filtering | `bun run network accept-next '<ssid>' --timeout 180` |
| Recover an interrupted admission window | `bun run network accept-next '<ssid>' --recover` |

For persistent isolation of a HomeTruth device, use the CLI script
`bun run ht isolate <device-id> on|off`; it keeps the server's desired
policy and shared DNS records in sync with the router. For model discovery and
device controls use `hometruth-cli` or `hometruth-add-device`.

## Fixed addresses

Use `find` to establish the MAC and current network, then `save` for an enrolled
device. `save` uses the Settings transaction: validate the inventory, reserve
and verify, save and reload the inventory, then request reconnection. It works
with compact and block YAML; do not ask the user to expand an entry. The
`reserve` command only changes DHCP on the router. It also works for known wired
or offline clients when their DHCP network is known. A DHCP reservation takes
effect after lease renewal; it cannot change a static address on the device.

## Site context and provider setup

Read `../hometruth_private/local/network.md` if present when site context is needed. This
private reference holds gateway names, VLANs, known devices, and dated
observations. Keep site facts and credentials out of tracked skills, fixtures,
and examples. Bridged devices share the bridge's LAN address; find the bridge
before treating a radio accessory as an independent IP client.

When configuring another router or implementing its scripts, read
[the provider contract](../../docs/NETWORK_TOOLS.md). Set the provider command
and implemented capabilities; keep these same agent-facing commands. UniFi's
existing implementation is one provider. To see argument details use
`bun run network help`.

Reads (`capabilities`, `clients`, `find`, and `status`) do not mutate the router.
Run writes, reconnects, captures, or admission within the user's requested
scope; preparing code does not authorize a live network change. Use existing
authorization without asking again. Admission accepts the next new MAC on an
SSID, not a verified vendor or model. Its script owns timeout and restoration;
see [admission recovery](../../docs/WIFI_ADMISSION.md) when a snapshot remains.
The user owns the HomeTruth server; use an existing server for `save`, and leave
startup or restart to the user.
