# Admit the next Wi-Fi device

Configuration and runtime paths in this guide are relative to your private
installation directory. Examples use fictional device names and addresses.
See [repository layout](REPOSITORIES.md) for command and storage conventions.

HomeTruth can temporarily disable an SSID's MAC allowlist, wait for one
new Wi-Fi client, add its MAC, and re-enable filtering. The Wi-Fi password is
still required. Use this when a device's MAC is unavailable until it joins.

In the web interface, open **Network → Network Commands → Accept next Wi-Fi
device**. Choose the Wi-Fi network and wait time, then select **Run command**.
The dedicated page shows live activity and the joined device's name, MAC and
IP address when reported. **Cancel and restore** closes the current window.
Refreshing or leaving the page does not stop the run; return to see its status.
The current run also survives server hot reloads. After a full server restart,
a retained snapshot exposes **Restore MAC restrictions** on the same page.

The JSON API uses `GET /api/network/commands/accept-next` for the current run,
`GET /api/network/commands/accept-next/options` for available SSIDs, and
`POST /api/network/commands/accept-next` with `{"ssid":"My IoT WiFi","timeoutSeconds":180}`
to start. Start returns HTTP 202 immediately; progress and the final result are
kept by the server. Cancel with `POST /api/network/commands/accept-next/<run-id>/cancel`.
Only one UI run is active at a time. Recovery uses the start route with
`{"ssid":"My IoT WiFi","recover":true}`.

```sh
bun run ht network accept-next 'My IoT WiFi' --dry-run
bun run ht network accept-next 'My IoT WiFi' --timeout 180
```

The SSID is required and case-sensitive. The default window is 180 seconds;
`--timeout` accepts 10–600 seconds. Start the device's Wi-Fi setup when the
command reports that the admission window is open. A device already on the
allowlist, or connected before the window opened, does not consume the slot.
Only wireless clients on the selected SSID qualify; detection does not need
to wait for DHCP. If several new MACs appear in one poll, the command closes
the window and reports them without choosing one.

The command prints the accepted MAC, name and IP when known, and confirms
the controller has re-enabled filtering. It closes on success, timeout,
Ctrl-C or an API error. Existing allowlist entries and concurrent additions
are preserved. The selected MAC and restored filter are saved together in one
update. Admission is observed through the router's client table,
which can lag association; AP provisioning also takes time. This is a bounded
enrollment window, not an atomic one-station admission mechanism. Other devices
with the password could associate during that interval, although they are not
added to the final allowlist.

`--json` returns the result on stdout; progress goes to stderr. Timeout and
cancellation return exit code 1 after restoration; accepted, dry-run and
recovery results return 0. The command does not create a HomeTruth device
model: use the admitted MAC/IP for vendor discovery and provisioning next.

## Runtime and recovery

This command runs a separate local worker using the same configured Network Tools
provider as the other network tools. It works without the HomeTruth web server and survives server hot
reloads. The worker also closes the window when the parent CLI dies.

Before changing the gateway, it exclusively saves the original MAC settings
to `.hometruth/wifi-admission/active.json` with owner-only permissions. The
snapshot contains no API key or Wi-Fi password. An existing snapshot blocks
another admission window in the same checkout. Use one HomeTruth checkout
for admission; this local lock cannot coordinate other machines or external
router administrators.

If the worker itself is killed, the machine loses power, or the gateway is
unreachable during all restoration retries, the snapshot remains. Once the
gateway is reachable, restore the restriction with:

```sh
bun run ht network accept-next 'My IoT WiFi' --recover
```

Recovery requires the same controller, site and SSID and refuses while the
recorded worker is running. It re-enables the MAC filter and preserves the
current and original allowlist entries. The snapshot is removed only after
the controller confirms restoration. No process can guarantee immediate
restoration through a host power failure or an unreachable gateway.

The UniFi provider uses the per-SSID
[MAC Address Filter](https://help.ui.com/hc/en-us/articles/18565355579799-MAC-Address-Restricting).

The agent-facing script is `bun run network accept-next <ssid>` with the
same flags. Admission uses the selected provider's `admission` capability;
UniFi and custom scripts both use the same bounded window and recovery logic.
Custom scripts must set a stable `HOMETRUTH_NETWORK_TARGET`, which is saved in
the recovery snapshot. See [Network Tools](NETWORK_TOOLS.md) for the provider
protocol. A provider without admission support reports an unsupported operation.
