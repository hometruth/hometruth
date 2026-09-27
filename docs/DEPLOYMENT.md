# A dedicated macOS production host

Develop on one installation and run production from an explicit, verified source
release on another host. Both can control real devices; their files, databases,
tokens, dependencies and server processes must be independent. Physical devices
and router rules are still shared resources. A development command can change a
real light or camera even though its software cannot change production source.

## Release layout

Keep this entire deployment outside the development checkout:

```text
hometruth-production/
  releases/<release-id>/source/    exported code and its own node_modules
  releases/<release-id>/manifest.json
  releases/<release-id>/validated.json
  current -> releases/<release-id>
  installation/                   production config and ignored runtime state
  runtime/bun-<version>/bun        pinned runtime
  ops/                            launchd configuration and release launcher
  logs/                           owner-only, rotated application logs
```

A release archive contains source only. It never contains the development Git
history, inventory, environment files, secrets, pairing state or runtime data.
The packaging command checks a clean staged snapshot and its single-commit
history, scans for secrets, and compares it to known local secrets and identities.
No Git remote is changed. Review the candidate before transferring it.

```sh
python3 scripts/deployment.py pack \
  --installation ../my-home \
  --output ../my-home/.hometruth/releases/release-001
```

Transfer `release.tar.gz` over SSH. On the production host, use `unpack` with a
new destination. Then use its pinned Bun executable to install the frozen
lockfile, typecheck the actual candidate and validate the production installation:

```sh
python3 deployment.py unpack release.tar.gz /path/to/deployment/releases/release-001
python3 deployment.py validate /path/to/deployment/releases/release-001 \
  --installation /path/to/deployment/installation --bun /path/to/pinned/bun
python3 deployment.py select --root /path/to/deployment release-001
```

Keep `deployment.py` and `release.py` together in `ops/` for host operations.
A selected release must pass checksum verification and have a matching validation
record. `select` atomically changes one symlink; it never overwrites installation
data. Selection does not start a service by itself.

## Service supervision

Use a system LaunchDaemon with `UserName` set to the installation owner,
`KeepAlive` and `RunAtLoad`. Its command is `/usr/bin/caffeinate -s`, followed by
`/usr/bin/python3 ops/deployment.py run --root ... --bun ...`. Use absolute paths,
an explicit PATH containing Node, ffmpeg and OpenSSL, and an owner-only working
directory. Application code runs without root privileges. Installing the system
job requires an administrator; selecting later releases does not.

The stable launcher runs `bun run site <installation> start` without development
file watching. It watches only the `current` release selection, shuts down the old
server, and starts the selected release. HomeTruth's own supervisor recovers
worker crashes and hung event loops; launchd recovers the outer process. The
launcher rotates application logs at 10 MiB with five backups.

A release switch has a short interruption. Check `/api/health`, authentication,
and required service states afterward. Retain the previous release for explicit
rollback. Before changing a schema, take a consistent backup and define the
restore procedure: choosing older code does not reverse database changes.
Do not promise zero downtime or 100% availability from a single laptop. Reboots,
network outages and hardware failures need operational recovery. Keep the lid
open, AC sleep disabled, and provide backup power for network equipment.

## HTTPS and local names

Use a reverse proxy such as Caddy with a local CA for a `.local` hostname. Each
browser/device must trust that CA. Publish the name using Bonjour (mDNS), and
provide a router DNS record where necessary for other subnets. Reserve the host
address. Never expose the home control interface with router port forwarding.

Production `site.json` should contain:

```json
{
  "environment": {
    "HOST": "127.0.0.1",
    "PORT": "3000",
    "NODE_ENV": "production",
    "DEV_HUB": "off",
    "HOMETRUTH_TRUST_LAN": "off",
    "HOMETRUTH_PUBLIC_ORIGIN": "https://control.local"
  }
}
```

`HOST` binds exactly the configured address. `HOMETRUTH_PUBLIC_ORIGIN` defines the
origin reconstructed behind the proxy, including secure cookies and same-origin
write checks. Client-supplied forwarding headers never grant access. Always turn
LAN trust off behind a proxy: its loopback address otherwise grants every caller
administrator access. Keep the backend on loopback and restrict the proxy to the
intended LAN interface/address. Bootstrap a token into a protected file before
first startup so no bootstrap credential appears in service logs.

Camera/Hue emulation also uses ports 80/443 and its own certificates. Give the web
proxy a separate, unused static LAN address outside the DHCP pool and bind the
emulation listeners to the server's primary LAN address using
`HOMETRUTH_ISOLATION_LISTEN_HOST`. Keep the alias persistent across boot. Do not
silently displace those listeners with the web proxy. Verify that the selected
alias is not assigned to another device before configuring it.

Bind the separate MQTT broker with `MQTT_HOST` and `MQTT_PORT`. Set both
`MQTT_USERNAME` and `MQTT_PASSWORD` in private secret environment storage to
require authentication, and configure the same credentials in publishing
devices. A partial credential setting fails startup instead of opening the
broker. MQTT on port 1883 is plaintext; restrict it to trusted device networks.
API tokens protect the web interface, not vendor emulation protocols.

## Development and device state

Set `HOMETRUTH_ISOLATION_RECONCILE_ON_START=off` in development's `site.json`.
Startup and hot reload then leave shared router rules alone. Explicit network
controls retain their full functionality and can still affect the shared home;
use them deliberately. Production owns the canonical DNS redirects and broker
address. Point devices that push events at production, not the development host.

Configuration and credentials are copied once during installation, using an
explicit inventory. Later source releases do not copy development configuration
over production. Use SQLite's online backup API for live databases; copying only
a `.sqlite` file can omit transactions in its WAL. Pairing identities are not
ordinary config: do not run cloned Matter bridges or advertise two Hue bridges
with the same identity. Commission independent identities where required.
Bluetooth peripheral identifiers can differ between Macs and need rediscovery.

Local backups containing credentials stay owner-only and out of Git. For disaster
recovery, keep an encrypted backup on a different machine/storage device and test
a restore. A second directory on the production disk is only a rollback aid.
