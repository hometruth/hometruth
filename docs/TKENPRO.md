# TKENPRO / Meari cameras and treat dispensers

HomeTruth includes a model for compatible TKENPRO 2K Pet Camera Treat Dispenser devices. Available media, movement and vendor controls depend on the model, firmware and connection. A catalog entry alone does not establish hardware support.

All configuration and runtime paths in this guide are relative to your private installation directory. Commands run from the public source checkout and use `../hometruth_private/`; use `bun run site <private-directory> <command>` for another location. Device names and addresses in examples are illustrative.

## Local control and cloud dependencies

Local media/control and a gateway internet block do not guarantee that all
vendor communication is eliminated. The isolation integration relays selected
vendor HTTPS requests through HomeTruth for supported firmware. Cloud login,
initial setup and recovery may also require vendor access. See
[network isolation](NETWORK_ISOLATION.md) before selecting that mode.

## Discovery and connection


Local discovery does not require an account and includes TKENPRO's native LAN
broadcast. Every compatible camera found (Meari/TKENPRO/CloudEdge family) is saved to
the git-ignored `.hometruth/discovered-cameras.json` (owner-only `0600`, no
secrets) so the web interface lists them again after a restart without a fresh
scan; running discovery again refreshes that catalog. If it finds the camera but shows **ONVIF supported; not connected**:

1. Open **Connect camera controls** in HomeTruth.
2. Enter the original owner's TKENPRO email/phone and app password. A shared
   account may not receive permission to change this camera setting.
3. Enter a local camera password of 1–16 printable characters; the camera
   username is `admin`.
4. Check **Enable ONVIF directly through TKENPRO**, then choose **Save and
   connect camera** and confirm the cloud-recording warning.

The mobile-app ONVIF menu is not required for this route. HomeTruth performs
the authenticated paired-property operation used by legacy `svc=3` firmware,
then waits and rescans for local video and controls.

Do not factory-reset a healthy camera just because ONVIF is hidden. First make
sure the app account is the original owner. If re-pairing is necessary, remove
the camera from the old owner before resetting; a physical reset clears Wi-Fi
but may leave its cloud ownership binding intact. With the camera powered, hold
the small round front **Feeding & Reset** button for five seconds, wait for a
slow red blink, then add **Pet Camera** in TKENPRO and show its QR code to the
lens from 5–8 inches away.

Alternatively, enter the mobile-app account details to discover the camera
through Meari and use its proprietary IoT controls. Some Meari accounts allow
only one active app session, so a dedicated shared camera account is safer than
using the owner account.

The web interface saves camera settings in the private, git-ignored
`.hometruth/camera-setup.json` file with owner-only (`0600`) permissions, so
HomeTruth reconnects after an app restart. HomeTruth **never writes**
`.env.local`; that file is yours (it also holds unrelated secrets such as the
UniFi API key) and is read only as a fallback, so the CLI can run unattended
with the same `TKENPRO_*` and `ONVIF_*` variables. Per-camera addresses live in
`devices.yml` and the discovered-camera inventory, not in a global
setting. Passwords are not returned by the API, rendered into the page, or
placed in browser storage. **Forget saved details** deletes the JSON file and
leaves `.env.local` untouched. The server binds to `127.0.0.1` by default.

CloudEdge's authenticated camera commands are also available locally through
HomeTruth. The bridge keeps the CloudEdge request shape but sends it over the
camera's local ICE/KCP/IVA/VVP connection, so callers do not need the remote
OpenAPI service:

```sh
curl -fsS http://127.0.0.1:3000/api/camera/devices/DEVICE_ID/local-command \
  -H 'content-type: application/json' \
  --data '{"action":"GET","deviceurl":"http://127.0.0.1/devices/settings"}'
```

The dashboard's device ID can be obtained from `/api/camera/state`. The bridge
accepts the extracted `/devices` and `/media` routes, including settings,
network, volume, music, LED, temperature, voicemail, and recording queries.
Commands that reboot, unpair, update firmware, or delete data require
`"confirmed":true`. SD-card commands remain hardware-unverified; a declared
route or accepted request does not establish successful storage behavior.

For a firmware property that is not yet named in the UI catalog, use the local
IoT write bridge. It accepts CloudEdge's numeric property IDs and preserves
the same local-only transport:

```sh
curl -fsS http://127.0.0.1:3000/api/camera/devices/DEVICE_ID/local-iot \
  -H 'content-type: application/json' \
  --data '{"values":{"103":1}}'
```

## Use the TypeScript library

```ts
import {
  TkenProClient,
  getAvailableControls,
  type FeedPortions,
} from "@hometruth/tkenpro";

const client = new TkenProClient({
  profile: "tkenpro",
  email: process.env.TKENPRO_EMAIL!,
  password: process.env.TKENPRO_PASSWORD!,
  countryCode: "US",
  phoneCode: "1",
});

const { devices } = await client.login();
const camera = devices.find((device) => device.snNum);
if (!camera?.snNum) throw new Error("No camera found");

const values = await client.getAllIotValues(camera.snNum);
console.log(getAvailableControls(camera, values));

await client.setMotionDetection(camera.snNum, true);
await client.setHumanTracking(camera.snNum, true);
await client.feed(camera.snNum, 1 satisfies FeedPortions);

await client.ptzStart(camera.snNum, "left");
try {
  await Bun.sleep(400);
} finally {
  await client.ptzStop(camera.snNum);
}
```

Programmatic callers can use typed convenience methods or
`setControl(serialNumber, controlId, value)`. Destructive storage/reset actions
require their exact confirmation literal; raw writes cannot bypass those
guards.

Local discovery and ONVIF are exported from the same package:

```ts
import { discoverCameras, OnvifClient } from "@hometruth/tkenpro";

const report = await discoverCameras({ cidrs: ["192.168.50.0/24"] });
const endpoint = report.cameras[0]?.onvifEndpoints[0];
if (endpoint) {
  const onvif = new OnvifClient({
    deviceServiceUrl: endpoint,
    username: "admin",
    password: process.env.ONVIF_PASSWORD!,
  });
  console.log(await onvif.getDeviceInformation());
}
```

## Use the command-line client

The Bun/TypeScript CLI exposes local discovery, ONVIF information, camera
media addresses, snapshots, leased PTZ movement, cloud status, and every named
control in the PET3T catalog.

Discover cameras without credentials:

```sh
bun run camera discover --cidr 192.168.50.0/24
```

For direct local access, place the camera password in the environment rather
than a command-line flag. The CLI never prints it or adds it to returned media
URLs.

```sh
export TKENPRO_CAMERA_HOST=192.168.50.147
export ONVIF_USERNAME=admin
read -s ONVIF_PASSWORD
export ONVIF_PASSWORD

bun run camera info
bun run camera media --json
bun run camera snapshot --output pet-camera.jpg
bun run camera ptz left --duration-ms 300
```

Cloud controls use the same environment-only credential pattern. Set
`TKENPRO_PROFILE=cloudedge` when the owner account belongs to CloudEdge.

### Toggle the UniFi camera DNS override

Pet 3T cameras share a CloudEdge hostname. UniFi DNS records are network-wide,
so cameras use one A record pointing at your HomeTruth server's LAN address.
Create a UniFi Network API key, store it with
`ht secrets set network.unifi.apiKey`, then:

```sh
bun run ht network on
bun run ht network off
```

With the isolation service running, `on` isolates every pet camera and `off`
releases every configured compatible camera; the shared records follow. See
[isolation behavior and limits](NETWORK_ISOLATION.md). Without it
(no isolation service, e.g. a manual-DNS site), `on` creates or enables the
shared record and `off` disables it without deleting it.

### Make a camera follow the record immediately

A Pet 3T keeps its existing cloud TCP session after the DNS record changes and
only reconnects once that session drops, so on its own it takes several
minutes (its heartbeat timeout) or a power-cycle to appear on the other side.
The vendor cloud never has this problem because it already owns the session.
HomeTruth's equivalent is a brief Wi-Fi kick through the UniFi gateway: the
firmware re-resolves `usce.mearicloud.com` and re-registers as soon as the
link is back, about 15 s later, with no reboot.

- The dashboard's **switch to local / switch to cloud** link now kicks the
  cameras right after changing the record and waits for the local emulator to
  see them register (or leave). Send `{"action":"on","reconnect":false}` to
  `POST /api/camera/network/dns-override` to change only the record.
- **reconnect now** in the status line (or `POST /api/camera/network/reconnect`
  with an optional `deviceId`) kicks the selected camera without touching the
  record, which is the fix for "Not registered with the local emulator yet".
- From a shell:

```sh
bun run ht network kick
```

The kick uses the gateway's classic Network API (`cmd/stamgr kick-sta`) with
the configured UniFi API key; a camera the gateway does not currently list is
reported and skipped rather than treated as a failure. A camera that is
already on the wanted side is never kicked: on this firmware a kick while it
is registered locally makes it fall back to the vendor's own domain from its
last session, so it would leave the emulator for minutes. The dashboard only
offers **reconnect now** when the selected camera is on the wrong side.

### Reboot a camera that vanished from the LAN

Symptom: the camera's status light is steady blue and the CloudEdge app can
still reach it, but HomeTruth shows **Status unknown** and nothing at its
address answers ping, ONVIF, or the LAN discovery broadcast. If a backup Wi-Fi network has been configured in CloudEdge, after a Wi-Fi
kick or a dropped link a camera can fail over to it and come up on another
subnet, where it stays until it is rebooted. The vendor cloud still lists it,
which is why the app works. Fix it with one command; it finds the camera and
reboots it, after which the firmware rejoins its primary network:

- **reboot camera** in the dashboard status line (always offered for a camera
  with a known address), or `POST /api/camera/reboot` with `{"deviceId":…}` or
  `{"host":"192.168.50.147"}` and an optional `timeoutSeconds` (10–600, default
  120).
- From a shell, through the running server, or on its own with `--direct`
  (which also takes an IP address); `--locate` only reports where the camera is:

```sh
bun run ht reboot example-camera
bun run ht reboot example-camera --direct
bun run ht reboot example-camera --locate
```

Restarting the HomeTruth server many times in a row (for example `bun --watch`
during a long edit session) drops the cameras' emulator sessions each time,
and after enough failures the firmware switches to the backup network on its
own. Diagnose the network and identity before requesting recovery; do not
repeatedly restart HomeTruth as a device-connectivity test.

The flow (`src/models/recovery.ts`): try ONVIF at the configured address; if
it is silent, log in to the vendor cloud with the saved app account and read
the address and gateway the camera last reported (IoT codes 126 and 59); check
the serial of whatever answers there so the wrong camera is never rebooted;
send ONVIF `SystemReboot` (`admin`/`admin` unless changed); then poll the
configured address for up to two minutes and, in local mode, wait for the
camera to re-register with the local emulator. A camera reachable at its
configured address is simply rebooted in place. Nothing is written to the
cloud or to the camera's settings.

If a camera keeps failing over, inspect the configured backup network and LAN
routing. Decide whether to retain that backup with the user; do not silently
remove it during diagnosis. Cross-subnet access depends on routing and policy.

```sh
export TKENPRO_EMAIL=owner@example.com
read -s TKENPRO_PASSWORD
export TKENPRO_PASSWORD

bun run camera status
bun run camera get statusLed
bun run camera set statusLed off
bun run camera set onvif true --confirm onvif
bun run camera controls --json
```

If an account contains more than one camera, set `TKENPRO_SERIAL` or pass
`--serial`. Caution controls require `--confirm` followed by the control ID,
such as `set feed 1 --confirm feed`. Destructive controls require the exact,
uppercase confirmation literal displayed by `camera controls`; this is checked
before the CLI logs in or sends anything to the camera. Existing snapshot
files are not overwritten unless `--force` is supplied. The `onvif` control
uses `ONVIF_PASSWORD` for the paired enable/password operation required by
legacy firmware.

## Safety behavior

- PTZ requests have a maximum three-second lease and always receive a stop.
- Treat dispensing releases exactly one treat per command; the firmware's
  multi-portion action is not reliable on this hardware, so no path accepts a
  count above 1. The web button dispenses one treat per click with no second
  confirmation.
- Formatting storage, deleting recordings, resets, and factory restoration are
  cataloged as destructive and require explicit confirmation.
- Network probing accepts only private/link-local targets, six camera ports,
  and at most 256 hosts.
- RTSP and snapshot bridging rejects public hosts and never invokes a shell.
