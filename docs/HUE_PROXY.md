# Hue bridge proxy and light synchronization

Configuration and runtime paths in this guide are relative to your private
installation directory. Examples use fictional device names and addresses.
See [repository layout](REPOSITORIES.md) for command and storage conventions.

HomeTruth runs a discoverable Hue bridge endpoint as a built-in service. Hue clients
pair with it and their local API requests go to your real bridge. The real
bridge continues to own the lights, rooms, scenes, schedules, and Zigbee network.
The proxy publishes light changes to other HomeTruth lights, WLED, MQTT, and
HTTP webhooks. It also listens to the real bridge's CLIP v2 event stream, so
changes made directly in Hue or by a physical switch are observed.

Hue Entertainment is relayed through two authenticated DTLS sessions. Each
original application record reaches the real bridge unchanged, and its RGB
or xy color channels become routing events. This includes HueStream v1 and v2.
An OpenSSL C helper preserves packet boundaries; piping `openssl s_server`
stdout into a stream parser would lose those boundaries when channel counts vary.

## Built-in service

Open **Services → Hue bridge proxy**. HomeTruth registers this service on every
normal startup and connects automatically using `vendors.hue.host`,
`vendors.hue.applicationKey`, and `vendors.hue.clientKey` from the existing
secrets file. No environment flag or second process is required. Missing
credentials or startup failures appear as an offline service with the reason;
they do not stop HomeTruth or its other services.

The default listeners are HTTP **9080**, HTTPS **9443**, and Entertainment UDP
**2100**, using this machine's LAN address. Ports 80/443 remain available to
other optional listeners, including camera isolation. The service status shows the actual
address and observed light count. Discovery advertises the dedicated ports;
clients that hard-code 80/443 need a custom configuration on a separate address
or host. Startup observes the bridge and publishes service events; it does not
change lights until destination mappings are configured.

An existing `hue-proxy.yml` is automatically loaded for mappings and port
overrides. `HUE_PROXY_CONFIG` can select another file. Without a config file,
`HUE_PROXY_ADDRESS`, `HUE_PROXY_HTTP_PORT`, and `HUE_PROXY_HTTPS_PORT` override
the detected address and default ports. Set `HUE_PROXY_ENABLED=0` to disable
the built-in service when running the standalone executable elsewhere. Changes
take effect on the next HomeTruth restart.

The native Entertainment helper is built automatically if it is absent;
the compiler/OpenSSL prerequisites below still apply. Startup is asynchronous,
so compiling or a slow bridge does not delay the main HTTP interface.

## Standalone executable

Requires Bun 1.3.12+, OpenSSL 3, and a C compiler with OpenSSL development
headers. On macOS: `brew install openssl@3` and the Xcode command-line tools.
On Debian/Ubuntu: `apt install build-essential libssl-dev pkg-config openssl`.
`OPENSSL_PREFIX` can select another OpenSSL installation. No Python packages
or diyHue installation are needed.

```sh
bun install
bun run hue:proxy:build
cp hue-proxy.example.yml ../hometruth_private/hue-proxy.yml
```

Edit `hue-proxy.yml` with the proxy's **own LAN address**, the real Hue
bridge address, and the light mappings. Reserve the proxy address in DHCP.
The selected address must already belong to this machine. Standard Hue clients
expect TCP 80/443 and UDP 2100; discovery uses UDP 1900 and 5353 on the local LAN.
Use a separate machine/address if HomeTruth's camera isolation listeners or
another service already own 80/443. A process bound to `0.0.0.0` owns the port on
every address; adding an alias alone does not resolve that conflict. Nothing
in this service changes DNS, firewall rules, or the real bridge's IP address.

The example names environment variables for the real bridge's application key
and Entertainment client key. Supply them in your service environment. Or remove
`applicationKeyEnv` and `clientKeyEnv` to reuse matching `vendors.hue.host`,
`vendors.hue.applicationKey`, and `vendors.hue.clientKey` from
`.hometruth/secrets.yml`. `clientKeyEnv` is optional for normal lighting, but
an Entertainment client must have a known client key. No Entertainment area
setting is needed: clients select areas from the real bridge's inventory.

```sh
bun run hue:proxy --config hue-proxy.yml --check
bun run hue:proxy --config hue-proxy.yml
```

`--check` validates configuration and bridge credential availability without
opening network listeners or controlling lights. `Ctrl+C`/SIGTERM closes
listeners, cancels event streams, and releases the Entertainment session owned
by this proxy. The port is never silently changed when already occupied.

The executable is independent of the main HomeTruth process. HomeTruth needs to
be running only when it is a configured destination. Disable the built-in
service with `HUE_PROXY_ENABLED=0` before using the standalone executable on
the same machine. Built-in service events join HomeTruth's normal event bus.

## Pair clients

Select the **HomeTruth Hue** bridge in a client that supports local bridge
discovery, or enter the proxy address manually. Press the **real Hue bridge's
link button** when asked. Registration is forwarded to the real bridge; there
is no permanently open pairing window on the proxy.

A client using Entertainment registers with `generateclientkey: true`, as
usual. The proxy returns the real bridge's username/client key unchanged and
stores that pairing privately, so it can terminate and re-establish DTLS for
that client. An already-paired client's key can be reused only if it is the
configured application/client key; otherwise pair it again through the proxy.
An unknown Entertainment key yields an explicit error before claiming the bridge.

Keep `.hometruth/hue-proxy/` between runs. It contains the stable emulated bridge
identity, HTTPS certificate/private key, and paired client keys. Private files
are written with owner-only permissions. Never commit or publish that directory.
Deleting it creates a new bridge identity and requires clients to pair again.

The proxy has its own self-signed HTTPS certificate. Clients that require a
certificate signed by Philips' private CA or use only cloud discovery cannot
be transparently impersonated. Manual local bridge selection and acceptance
of the emulator's certificate depend on the client. This implementation has
automated protocol coverage; specific Hue app, Hue Sync, and Sync Box versions
still need testing on your LAN. It does not implement Hue cloud accounts or
Zigbee radio hardware.

## Choose sources and destinations

Read the resolved source inventory, using the configured monitor application's
key (the example assumes it is in `HUE_APPLICATION_KEY`):

```sh
curl --header "hue-application-key: $HUE_APPLICATION_KEY" \
  http://192.168.50.80/hometruth/sources
```

| Source | Meaning |
| --- | --- |
| `light/<light UUID>` | Actual state of one Hue light, including scene/group recalls |
| `light-v1/<numeric ID>` | Alias for that same light, when `id_v1` is available |
| `entertainment/<area UUID>/<channel>` | One HueStream v2 Entertainment channel |
| `entertainment/v1-<group ID>/<light ID>` | One HueStream v1 light address |
| `resource/<type>/<UUID>` | Raw v2 light, button, sensor, scene, or other resource event |
| `request/<redacted API path>` | Proxy write outcome: method, path, HTTP status, accepted |
| `*`, `light/*`, `entertainment/<area UUID>/*` | All events or a source prefix |

Entertainment channels are distinct sources because a gradient light can have
multiple independently controlled segments. The source inventory includes their
members. Map the desired channel explicitly; a wildcard route feeding one lamp
means the latest matching channel wins. To mirror both ordinary light settings
and Entertainment onto the same destination, include both source IDs in a route.

The `targets` list supports:

| Kind | Configuration and behavior |
| --- | --- |
| `ht` | `url`, `deviceId`; invokes the device's `light` or `stringLight` controls, skips unsupported color/temperature, clamps brightness/Kelvin to its advertised bounds |
| `wled` | Controller origin in `url`, optional `segment`; one `/json/state` write with solid RGB, brightness, power, and transition |
| `mqtt` | `mqtt://`/`mqtts://` URL and `topic`; full JSON events, no retain; optional `usernameEnv`/`passwordEnv` |
| `webhook` | Full URL receiving JSON event POSTs; optional bearer `tokenEnv` |

HomeTruth targets must be concrete non-Hue lights. Hue and composed groups are
refused to prevent a synchronization feedback loop into the observed bridge.
For external automation consumers, ensure they do not write their output back
to a configured source. All configured URLs are administrator-selected; HTTP
redirects are refused. Credentials are referenced by environment variable name.

With an explicit WLED `segment`, brightness/off apply to that segment so other
mapped segments remain independent; power-on also wakes the controller. The
controller's master dimmer remains in effect. Without `segment`, power/brightness
apply to the controller and color to segment 0. Color writes select the solid
effect, so an existing rainbow or palette effect cannot override synchronization.

`fields` selects which state changes to copy. For example, `[color]` lets the
destination retain its own dimmer and power setting. `brightnessScale` adjusts
the separate dimmer, `saturationGain` and `gamma` transform RGB, and `color`
overrides the source hue with a fixed accent color. Defaults are unchanged color
and brightness. Kelvin is sent as Kelvin to supported HomeTruth lights and
converted to approximate RGB for WLED.

HueStream RGB already includes brightness; the proxy separates chromatic color
from brightness to avoid dimming it twice. Zero becomes off. Ordinary CLIP
patches are merged with known state: an absent power field never means off.
Color and white-temperature modes replace one another, and repeated normalized
states do not generate duplicate light writes. Raw resource events remain available.

Each destination has independent ordering and timeouts. Light targets retain the
latest pending state while busy; their default minimum intervals are 200 ms for
HomeTruth and 40 ms for WLED. Set `minIntervalMs` to suit the target hardware.
Slow lights cannot block the real bridge's relay. Raw event targets have a
256-event queue and drop the oldest event on overflow. Failed deliveries retry
up to three times with backoff, then are dropped; retries can duplicate webhook
events, so consumers should deduplicate on `id`. MQTT uses QoS 0 and does not
buffer offline. These are live synchronization queues, not a durable event archive.

## Observe and operate

- `GET /healthz`: listener/bridge/Entertainment status and delivery/failure/drop
  counters per destination; no credential values.
- `GET /hometruth/sources`: source IDs and channel membership.
- `GET /hometruth/events`: up to 500 recent normalized/raw events, oldest first.
- `GET /hometruth/stream`: live normalized events as SSE, with heartbeat comments.
- `/api/...`, `/clip/v2/...`, `/auth/v1/...`, `/eventstream/clip/v2`: proxied Hue
  API endpoints, retaining the calling client's bridge credentials.

The `/hometruth/` endpoints require the configured monitor application's
`hue-application-key`. They expose events, never pairing responses or keys.
Write telemetry omits request bodies, query strings, and v1 usernames.

CLIP monitoring reconnects with bounded backoff and deduplicates event IDs.
Periodic full inventories reconcile changes missed during disconnects and
provide a polling fallback. Polling cannot recover intermediate events that
happened while disconnected. Entertainment streams sent directly to the real
bridge bypass the proxy and cannot be observed; point the streaming client at
this service. Only one Entertainment stream may own the bridge at a time,
including HomeTruth's existing camera light-sync feature. The proxy rejects
competing starts and cleans up owned sessions on stop, transport failure, or
15 seconds without an incoming frame (configurable).

## Keep it running

The example systemd unit is
[`hometruth-hue-proxy.service`](../src/integrations/hue-proxy/hometruth-hue-proxy.service).
Adjust the username, repository/Bun paths, config and environment paths; build
the helper as that user first. Its only additional capability permits binding
the standard HTTP/HTTPS ports. Install/enable the unit using your normal service
management workflow. Configuration changes take effect on restart.

A Dockerfile is also included. On Linux, use host networking for multicast
discovery and UDP Entertainment:

```sh
docker build -f src/integrations/hue-proxy/Dockerfile -t hometruth-hue-proxy .
docker run --name hometruth-hue-proxy --restart unless-stopped --network host \
  --env-file /etc/hometruth/hue-proxy.env \
  -v /etc/hometruth/hue-proxy.yml:/config/hue-proxy.yml:ro \
  -v /var/lib/hometruth-hue-proxy:/state \
  hometruth-hue-proxy
```

For Docker, set `stateDirectory: /state` and
`entertainment.helperPath: /usr/local/bin/hometruth-hue-dtls` in the mounted
config. The advertised/bind address must belong to the Linux host. Docker
Desktop's VM networking does not behave like a LAN host; run natively on macOS
for discovery and Entertainment. The Docker image and systemd installation
are provided for deployment and are not installed or started by the build command.

## Validation and references

`bun run hue:proxy:test` covers state/color conversion, API forwarding/errors,
pairing persistence, SSE reconnect/cancellation, routing/backpressure and real
local OpenSSL DTLS handshakes. The complete relay test sends variable-length
encrypted HueStream records through the proxy into a fake real bridge and
verifies unchanged payloads, normalized colors, and session release. Tests bind
loopback ephemeral ports and do not operate household lights.

The design was informed by reading [diyHue](https://github.com/diyhue/diyHue),
particularly its [Entertainment service](https://github.com/diyhue/diyHue/blob/master/BridgeEmulator/services/entertainment.py),
[SSDP](https://github.com/diyhue/diyHue/blob/master/BridgeEmulator/services/ssdp.py),
and [mDNS](https://github.com/diyhue/diyHue/blob/master/BridgeEmulator/services/mdns.py).
This is an independent implementation using HomeTruth's existing Hue color
conversions, [OpenSSL's DTLS API](https://docs.openssl.org/3.0/man3/DTLSv1_listen/),
and [WLED's JSON API](https://kno.wled.ge/interfaces/json-api/).
