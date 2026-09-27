# Network Tools

HomeTruth's Settings page, network recovery, isolation, and Wi-Fi admission use
`src/network/adapter.ts`. Agents use **`bun run network`**. Router-specific
HTTP, SSH, DHCP, and firewall mechanics belong in a provider, not a skill or a
device model. Changing routers changes provider configuration and scripts; the
agent commands and device settings stay the same.

## Operations

Run from the public checkout. Short scripts use the private sibling
`../hometruth_private`; for another location use
`bun run site <private-directory> network …`. Commands return JSON; `help` prints usage. Reads never
change router state. No command starts or restarts the HomeTruth server.

| Script | Purpose |
| --- | --- |
| `bun run network capabilities` | Identify the provider and available capabilities. |
| `bun run network clients` | List wired, wireless, and remembered clients, their MACs, current/reserved/last IPs, and network metadata. |
| `bun run network find <mac-or-ip>` | Locate one client; use its MAC when IP history is ambiguous. |
| `bun run network reserve <mac> <ip>` | Save and verify a DHCP reservation for any known network client, including one without a HomeTruth model. |
| `bun run network save <device-id> <mac> <ip>` | Save a provisioned device's router reservation and HomeTruth address together, using the same HTTP transaction as Settings. Requires a running server; `HOMETRUTH_URL` chooses it. |
| `bun run network reconnect <mac-or-ip>` | Ask the provider to reconnect a wireless client. |
| `bun run network dns status\|on\|off <hostname> <server-ip>` | Inspect/change a DNS override. |
| `bun run network internet status\|on\|off <mac> <label>` | Inspect/change one client's internet block. |
| `bun run network capture <mac-or-ip> <seconds> <output.pcap>` | Capture traffic for 1–600 seconds; create a private file without overwriting one. Ctrl-C closes the capture. |
| `bun run network accept-next <ssid> [--timeout <seconds>] [--dry-run]` | Inspect or open a bounded admission window; preserve the allowlist and restore filtering. |
| `bun run network accept-next <ssid> --recover` | Restore a saved admission window for the same router/site. |

A reservation affects the next DHCP lease, not a static IP configured on the
device itself. `reserve` does not reconnect the device or edit the inventory.
For a provisioned device use `save`: validate the YAML edit first, reserve and
verify on the router, atomically replace the inventory, reload, then request a
reconnect. If file replacement fails, restore the prior reservation. A reconnect
failure is reported after a successful save; wired devices may need to renew
their lease or be power-cycled. Compact JSON/YAML entries and block entries both
work; comments and other devices remain intact.

`ht isolate <id> on|off` still owns persistent HomeTruth isolation policy.
Use it for enrolled devices so the running service's desired state agrees with
the router; the script's `internet` and `dns` operations are individual router
operations. See [WIFI_ADMISSION.md](WIFI_ADMISSION.md) for admission recovery.

### Device network API

`GET /api/devices/<id>/network` reports addressing and association plus fresh
observations of HomeTruth-managed isolation rules:

```json
{
  "isolated": true,
  "isolation": {
    "scope": "hometruth",
    "requested": true,
    "internetBlock": "on",
    "methods": ["internet-block", "dns-override"],
    "dns": [
      { "domain": "vendor.example", "overrideIp": "192.0.2.10", "state": "on" }
    ]
  }
}
```

`isolated` is `true` when the provider reports the internet block on, `false`
when it is off or missing, and `null` when inspection is unavailable or fails.
`isolation.requested` is the separate desired setting, present when the
isolation service is available. A mismatch exposes a rule that needs attention.
An offline device's block can still be inspected using its configured MAC.

`methods` lists active mechanisms: `internet-block` cuts the device's direct
internet path while retaining LAN access; `dns-override` redirects the listed
model-declared vendor names to HomeTruth. Each rule has state `on`, `off`,
`missing`, or `unavailable`, with `detail` when it cannot be inspected. DNS
records are shared and can remain active for a device whose block is off;
redirection alone does not set `isolated` to `true`.

The scope is HomeTruth-managed rules. This is not an audit of unrelated router
firewall policies, VLAN or Wi-Fi client isolation, or alternate network paths.
UniFi's block status checks HomeTruth's single-MAC policies. Reads do not change
rules, reconnect clients, or start captures. See
[network isolation](NETWORK_ISOLATION.md) for model-specific behavior and relays.

## Provider selection

`HOMETRUTH_NETWORK_ADAPTER=unifi|command|manual` selects a provider explicitly.
Otherwise a configured `HOMETRUTH_NETWORK_COMMAND` selects `command`, a stored
UniFi key selects `unifi`, and the absence of both selects `manual`. Manual has
no automated capabilities and reports unsupported operations explicitly.

### UniFi

Use `bun run ht secrets set network.unifi.apiKey` to store the API key.
The private `network.unifi` settings are `baseUrl`, `siteId`, `siteName`,
`skipTlsVerify`, `sshUser`, and `sshKeyPath`. `siteId` selects the integration API
site; `siteName` selects the classic API site. The environment overlay is in
`src/network/config.ts`; it is shared by the server and script.

`src/network/unifi.ts` supplies DHCP reservations, client inventory, DNS,
reconnects and internet blocking. `unifi-admission.ts` supplies admission.
SSH credentials enable access-point packet capture. Capture restores temporary
hardware-offload changes when stopped. DHCP edits validate the managed subnet,
exclude gateway/network/broadcast addresses, reject occupied or reserved IPs,
and verify the saved reservation. Wired clients and remembered clients with a
known DHCP network can be reserved without an active Wi-Fi association.

### Another router

Write a script in the language appropriate for the router's API or CLI, then
configure the server and the Network Tools script with the same
settings. For example, in the private installation's ignored `.env.local`:

```dotenv
HOMETRUTH_NETWORK_ADAPTER=command
HOMETRUTH_NETWORK_COMMAND='["python3","/absolute/path/to/my-router.py"]'
HOMETRUTH_NETWORK_CAPABILITIES=addresses,wifi,dns,internet,admission,capture
HOMETRUTH_NETWORK_TARGET=my-router/site-a
HOMETRUTH_NETWORK_COMMAND_TIMEOUT_MS=30000
```

Declare **only** capabilities the script implements. An addresses-only script
needs no DNS, Wi-Fi, or capture support. `HOMETRUTH_NETWORK_TARGET` is a stable,
non-secret router/site identifier, required for admission so a recovery journal
cannot be applied to another network. Keep credentials in the private secrets
file (`network.<provider>.*`) or the script's credential store; never in argv,
stdout, skills, or tracked configuration.

The command is a JSON array of executable and arguments. HomeTruth executes it
directly, without shell expansion, and writes one JSON request to stdin:

```json
{"operation":"addresses.reserve","input":{"mac":"02:00:00:00:00:01","address":"192.0.2.20"}}
```

Emit exactly one JSON result on stdout, exit zero on success, and put diagnostics
without credentials on stderr. Exit nonzero on failure. Void operations return
`null`. Values below are result values themselves, without a wrapping envelope.

| Capability | Operation | Input | Result |
| --- | --- | --- | --- |
| addresses or wifi | `clients.list` | `{}` | Array of normalized clients below. |
| addresses | `addresses.reserve` | `{mac,address}` | `{"undo": <opaque JSON token>}` after validation, save, and verification. |
| addresses | `addresses.restore` | `{mac,undo}` | `null` after restoring and verifying the token's previous state. |
| wifi | `wifi.kick` | `{client}` | `null` after requesting reconnection. Reject unsupported/wired clients. |
| dns | `dns.status` | `{domain,overrideIp}` | `"on"`, `"off"`, or `"missing"`. |
| dns | `dns.set` | `{domain,overrideIp,action}` | JSON string describing the change; action is `on` or `off`. |
| internet | `internet.status` | `{mac,label}` | `"on"`, `"off"`, or `"missing"`. |
| internet | `internet.set` | `{mac,label,action}` | JSON string describing the change. |
| admission | `admission.wlans` | `{}` | Array of `{id,ssid,enabled,filterEnabled,policy,macs}`; policy must be `allow` for admission. |
| admission | `admission.clients` | `{}` | Array of `{mac,ssid,wlanId?,address?,name?}`, including arrivals before DHCP; wireless clients only. |
| admission | `admission.set-filter` | `{id,enabled,macs?}` | `null`; change only MAC filtering, preserving the list when `macs` is omitted. |
| capture | `capture.start` | `{client}` | Raw libpcap bytes on stdout, starting with the file header, until stopped. This operation is the exception to JSON output. |

Clients have a lowercase `mac` and an `address` string. Optional fields are
`fixedAddress`, `lastAddress`, `hostname`, `name`, `apMac`, `radio`, `ssid`,
`vlan` (integer), `network`, `subnet` (IPv4 CIDR), and `connected` (boolean).
Remembered clients use `connected:false` and `address:""`; the last known IP
belongs in `lastAddress`. Rescans must not move devices based on stale leases.
A missing subnet does not disable the UI; the provider validates DHCP policy.

The reservation provider must reject conflicting MAC/IP assignments and invalid
subnet addresses before mutation, retain an undo token for the exact previous
state, and restore it on a failed or uncertain write before exiting. HomeTruth
also reads `clients.list` after success and invokes `addresses.restore` if
readback or the local inventory write fails. Do not log undo tokens. A timeout
or killed script can leave an uncertain result: inspect the router before retrying.

Capture scripts must handle SIGTERM, stop remote capture, restore temporary
settings, and exit within five seconds. HomeTruth reports cleanup timeouts.
No provider should restart the HomeTruth server or launch a persistent service.

Run the provider tests with injected responses or a test router before enabling
writes on a real network. The shared contract/transport tests are
`src/network/command.test.ts`; they cover reservations and undo, subprocess JSON,
malformed output, timeout, DNS, firewall, admission, and binary capture.
