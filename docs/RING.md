# Ring Smart Lighting

Configuration and runtime paths in this guide are relative to your private
installation directory. Examples use fictional device names and addresses.
See [repository layout](REPOSITORIES.md) for command and storage conventions.

HomeTruth drives a Ring Smart Lighting Bridge and the fixtures paired to it —
Spotlight, Pathlight, Steplight, Floodlight — through Ring's cloud.

This adapter uses Ring's cloud API and requires an account with access to the
bridge and lights. It does not provide local-only control. Internet or vendor
outages can make devices unavailable, and isolating the bridge from its vendor
prevents this adapter from controlling it.

The integration is unofficial and follows endpoints used by the Ring app and
`ring-client-api`; cloud changes can affect compatibility. Inspect the fixture's
reported capabilities rather than assuming every related product supports the
same controls.

## What it exposes

| Model | Capability | Controls |
| --- | --- | --- |
| `ring-bridge` | `hub` | `getState` — the Bridge's reachability and the fixtures behind it |
| `ring-smart-light` | `light` | `turnOn`, `turnOff`, `toggle`, `setBrightness`, `getState` |

The `ring-smart-light` model maps supported fixture types reported by Ring. Ring reports a fixture as either a `switch.beams`
(on and off) or a `switch.multilevel.beams` (also a brightness), and the
model follows what the account says rather than what the entry claims. On a
non-dimmable fixture, `setBrightness(0)` turns it off and anything above
turns it on.

There is no colour temperature: Ring's lighting is fixed white, so the model
does not advertise a control it has not got.

Motion sensors paired to the Bridge appear in the Bridge's accessory list but
are not yet exposed as `motionSensor` devices.

## Setup

### 1. Mint a refresh token

Ring authenticates with an account password and a two-factor code, which
HomeTruth never handles. Run the community `ring-client-api` CLI and paste the result in:

```bash
npx -p ring-client-api ring-auth-cli
```

It asks for the Ring email, password, and the 2FA code Ring texts or emails,
then prints a refresh token. Store it:

```bash
ht secrets set vendors.ring.refreshToken
```

The value is read from a prompt or stdin, never from the command line, and
lands in `.hometruth/secrets.yml`. It is never written to `devices.yml`,
which the API serves.

**Ring rotates this token on every use.** HomeTruth writes the replacement
back to the secrets file automatically. If that write fails the server logs
`ring_token_store_failed`, and the session keeps working but the next restart
will need a fresh token.

### 2. Find the ids

Ring's ids are not printed on the hardware and the app does not show them:

```bash
bun run ring:discover
```

This prints every location, the Bridges on it, and each fixture's `zid`,
followed by ready-to-paste `devices.yml` entries. It is read-only — it
opens each location's socket to read the device list and closes it again.

### 3. Write the entries

```yaml
  - id: ring-bridge
    name: Ring Bridge
    model: ring-bridge
    config: { locationId: "<locationId from discover>" }
  - id: garden-spotlight
    name: Garden Spotlight
    room: Backyard
    model: ring-smart-light
    config: { bridge: ring-bridge, zid: "<zid from discover>" }
```

The fixture references its Bridge by entry id, the same way an
`aqara-door-window-sensor` references its hub. A Ring entry has no `host`:
offering one is rejected, because it would imply a LAN path that does not
exist.

The running server reloads `devices.yml` on save. Then:

```bash
ht devices
ht garden-spotlight
ht garden-spotlight on
```

## How it works

Two Ring APIs, both cloud:

- **REST** (`api.ring.com`) authenticates the refresh token at
  `oauth.ring.com/oauth/token`, lists Bridges from
  `clients_api/ring_devices`, and fetches a short-lived websocket ticket from
  `app.ring.com/api/v1/clap/tickets`. REST can *name* a Bridge but cannot see
  the lights paired to it and cannot switch one.
- **A websocket** to the host the ticket names carries the devices behind the
  Bridge and every command to them. Despite the name Ring's own client uses,
  the wire format is plain JSON frames, not socket.io framing.

The socket pushes a frame whenever a fixture changes, so nothing here polls:
HomeTruth subscribes and the page updates from the push. One connection is
opened per Ring location and shared by every device on it — Ring drops an
existing connection when a second opens for the same location.

When the socket drops, the connection reports offline, clears what it knew,
and retries. It does not serve last-known values in the meantime.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Ring rejected the refresh token` | The token was rotated elsewhere, revoked, or expired. Mint a new one with `ring-auth-cli` and store it again. |
| Bridge shows `degraded` with a token message | The site has no Ring account. `ht secrets set vendors.ring.refreshToken`. |
| `This Ring location has no Bridge or base station` | The `locationId` is a location without a Bridge. Check `discover.ts` output. |
| `Ring has no device <zid> behind this Bridge` | The `zid` is wrong, or the fixture was removed in the Ring app. Re-run `discover.ts`. |
| `Ring device <zid> is a motion-sensor.beams, not a light` | The `zid` belongs to a motion sensor rather than a fixture. |
| `Ring is rate limiting this account` | Too many requests. It resolves on its own; the connection retries. |

## Status

Built and unit-tested against recorded Ring protocol shapes. Not yet verified
against real hardware — that needs a Ring account token and a Bridge on the
account. Verify with `ht <id> on` once both exist.
