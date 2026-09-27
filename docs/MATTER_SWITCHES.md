# Matter switches

Configuration and runtime paths in this guide are relative to your private
installation directory. Examples use fictional device names and addresses.
See [repository layout](REPOSITORIES.md) for command and storage conventions.

HomeTruth exports every configured device with the `binarySwitch` capability through a managed local Matter bridge. This includes synthetic switches and optimistic switches composed from an on Button plus an off Button. Stateless Buttons themselves are not exported as on/off endpoints because a press has no readable state. Lights, camera settings, and other boolean controls are outside this first implementation.

The bridge uses `@matter/main` 0.17.9 in a Node.js child process owned by HomeTruth. It starts with the web UI and other services, and communicates with the same HTTP API. The physical switch remains under HomeTruth's existing control and validation.

## Run on a supported server host

Requirements: Node.js 22.18+ or Node.js 24+ with built-in TypeScript stripping, the installed project dependencies, and the HomeTruth server running normally. Matter itself supports the Node versions declared by `@matter/nodejs`; these scripts additionally require native TypeScript support.

```sh
bun install
bun run dev
# In another terminal, if needed:
bun run matter:status
```

`bun run dev` and `bun run start` both own the bridge's lifecycle. It starts
without delaying HTTP readiness, restarts with backoff if it exits, and stops with
HomeTruth. Development reloads release the old child before a new one takes the
pairing store. The Services page shows **Apple Home bridge**, including startup
errors. A missing Node executable or bridge failure cannot stop other services.
Set `HOMETRUTH_NODE_BINARY` to choose Node and `HOMETRUTH_MATTER_ENABLED=0` to disable
export. The pairing directory is preserved across all restarts.

## Rooms

HomeTruth provides a Room dropdown and **Add room…** on device pages and switch
cards. Each assignment is saved in the device inventory; saved empty rooms remain
available. The device list/detail APIs include the full room name, and
`GET /api/rooms` returns the shared room list and whether it can be edited.
`POST /api/devices/:id/room` accepts `{ "room": "Living Room" }` to assign/create
or `{ "room": null }` to clear a device's assignment.

The bridge discovers room changes every 30 seconds and updates the existing
endpoint's Fixed Label cluster with a `room` label. Endpoint identity and pairing
are preserved. Matter limits each Fixed Label value to 16 UTF-8 bytes, so longer
names are shortened only in that label; the inventory retains the full name.
This follows the [Matter reference bridge's room metadata](https://github.com/project-chip/connectedhomeip/blob/master/examples/bridge-app/linux/README.md).

This does **not** automatically assign accessories to rooms in Apple Home.
Apple's room database is managed through an authorized HomeKit app using
[`HMHome.assignAccessory`](https://developer.apple.com/documentation/homekit/hmhome/assignaccessory(_:to:completionhandler:)); this project currently has no such
Apple app. Set the corresponding room in Apple Home. Fixed Label metadata is not
presented as successful Apple Home room synchronization.

## Add to Apple Home

Open any exported switch in HomeTruth and choose its **Settings** tab. Before commissioning, the Apple Home card shows the shared Matter bridge QR code; scanning it once adds every exported HomeTruth switch. After commissioning, the page identifies the switch as part of the existing bridge and moves the original QR behind a disclosure so it is not mistaken for a device-specific pairing code. The local `.hometruth/matter/pairing.html` page also shows the QR code and manual Matter code while unpaired, plus current switch inventory and state. It updates every five seconds. `bun run matter:status` also prints the manual code while unpaired.

On an iPhone or iPad on the same LAN:

1. Open Home, choose the home where you want these accessories, then **+ → Add Accessory**.
2. Scan the local pairing page's QR code, or use **More Options** and enter the manual code.
3. If Apple displays an uncertified accessory notice, this is the local development bridge; continue to add it.
4. Assign rooms and names. The accessories become available to devices using that Apple Home/account.

Apple requires an iPhone or iPad for adding an accessory; the Mac Home app cannot perform initial pairing. [Apple requirements](https://support.apple.com/en-ie/126198)

The bridge uses Matter's development vendor/product credentials, not commercial certification. Switch endpoints use Matter's Mounted On/Off Control device type (`0x010f`), the stateful actuator model for a fixed switch controlling a connected load. They also list its On/Off Plug-in Unit subset (`0x010a`), as recommended by the Matter device specification for clients that do not support the newer Matter 1.4 type. Matter's similarly named On/Off Light Switch is a controller that sends commands to another device, so it is not the right model for a HomeTruth switch. A client using the compatibility type may present the control as an outlet rather than a switch.

If pairing has timed out before the first pairing succeeds, run `bun run matter:pair` to reopen commissioning. Once commissioned, this command does not open an additional fabric or reset anything; use the ecosystem's sharing controls for additional administrators.

## Operation

- Commands invoke exactly one explicit HomeTruth on/off request. A failed request is reported as failure; physical commands are not automatically retried.
- Matter reports the actual state returned by HomeTruth, including a relay that has already reset itself. State polling never issues control commands.
- Switch state refreshes about every two seconds; inventory refreshes every 30 seconds. A slow or unavailable HomeTruth server lengthens this interval through bounded request timeouts.
- Unknown or offline switches are marked unreachable. Their last known Matter value is retained, not presented as a newly observed Off value. A failed command's reachability is reconciled by the next state poll.
- A successful inventory refresh adds and removes configured switches. A failed inventory read preserves existing accessories. A cached inventory permits bridge startup while HomeTruth is temporarily unavailable.
- Stable device IDs retain endpoint identity across restart, rename, and configuration reordering. Changing a configured device ID creates a different accessory.
- Pairing/fabric state, inventory, status and QR page live under private, git-ignored `.hometruth/matter/`. Preserve this directory to retain pairings. Only the local pairing page/status includes setup codes; no remote QR service is used.
- Matter listens on UDP 5540 and announces over LAN mDNS (UDP 5353). Home's controller/hub must reach the server host over the LAN. That host must remain awake and HomeTruth must keep running for controls to work.

Other accessories in Apple Home are not altered or removed. A switch already exposed through a different bridge may appear twice after this Matter bridge is added.

## Configuration and troubleshooting

Set these variables in the environment or `.env.local` used by HomeTruth. The bridge always uses the actual HomeTruth HTTP port, including `PORT=0`.

| Variable | Default |
| --- | --- |
| `HOMETRUTH_MATTER_ENABLED` | `1` (set to `0` to disable) |
| `HOMETRUTH_NODE_BINARY` | `node` |
| `HOMETRUTH_MATTER_PORT` | `5540` |
| `HOMETRUTH_MATTER_STORAGE` | Project `.hometruth/matter` directory |
| `HOMETRUTH_MATTER_POLL_MS` | `2000` |

Check **Apple Home bridge** on the Services page, `bun run matter:status`, and
the HomeTruth terminal. Multicast errors on inactive VPN/virtual interfaces do not
by themselves mean advertisement on the active LAN failed. A duplicate process
using the pairing store is reported rather than taking over or changing pairing.

## Validation

```sh
bun run typecheck
bun test src/integrations/matter/client.test.ts src/integrations/matter/settings.test.ts src/integrations/matter/site-service.test.ts src/runtime/watchdog.test.ts
```

Tests that do not start servers cover managed child ownership, startup failures, retries, bounded shutdown, status accuracy, the startup watchdog, and the HTTP contract. Additional bridge tests cover filtering all binary switches, command routing and failure, state/readback behavior, offline handling, avoiding duplicate writes, discarding stale poll results, persistent identities and commissioning credentials, and live inventory changes. The separately opt-in `HOMETRUTH_MATTER_NETWORK_TEST=1` bridge test starts servers and commissions a temporary bridge with an independent Matter controller over UDP, exercises commands and subscriptions, and cleans up its test fabric. Test commands target fake switches; no real relay needs to be toggled to run them.
