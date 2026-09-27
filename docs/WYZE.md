# Wyze Cam v3

All configuration and runtime paths in this guide are relative to your private installation directory. Commands run from the public source checkout and use `../hometruth_private/`; use `bun run site <private-directory> <command>` for another location. Device names and addresses in examples are illustrative.

A fixed 1080p camera modelled as `wyze-cam-v3`. Its stock firmware only
speaks TUTK P2P with per-session keys from the Wyze cloud, so HomeTruth does
not drive stock firmware at all. The `firmware` config field names the local
route on the camera, and the model turns it into stream, snapshot, and ONVIF
addresses:

| `firmware` | Stream | Snapshot | Identity / reboot | Notes |
| --- | --- | --- | --- | --- |
| `thingino` | `rtsp://host:554/ch0` (`sub`: `/ch1`) | `http://host/x/dl0.jpg` with the web API key (`devices.<id>.web.apiKey`), else a frame from RTSP | ONVIF on port 80 | Replacement firmware; no Wyze account, installed from an SD card before the camera ever joins a network. Use the firmware project's installation documentation. |
| `wyze-rtsp` | `rtsp://host:554/stream0/` (`secure: true`: `rtsps://host:322/stream0/`) | RTSP frame grab | RTSP `Server` header | Wyze's beta RTSP firmware `4.36.16.x` plus the WyzeBeta app; the camera stays cloud-connected. |
| `wz-mini-hacks` | `rtsp://host:8554/video1_unicast` (`sub`: `/video2_unicast`) | RTSP frame grab | RTSP `Server` header | SD-card overlay on stock firmware up to 4.36.9.139; unmaintained. `rtspPort` overrides the port. |

The RTSP login lives in the secrets file as `devices.<id>.rtsp`
(`username`, `password`); when absent the firmware's factory login is used
(Thingino: `thingino` / `thingino`, and the username cannot be changed).
Thingino's web API key (Settings → Web UI → "API key for automation") goes
in `devices.<id>.web.apiKey`; it unlocks the HTTP snapshot and the JSON
controls, and without it snapshots are grabbed from the RTSP stream. The
device page at `/cameras/<name>` shows the live view (RTSP transcoded to MJPEG
by `ffmpeg`) and a still; `GET /api/cameras/<id>/stream.mjpeg` and
`/snapshot` are the routes behind it. Availability is one RTSP `OPTIONS`
round trip, so an unreachable camera reports `offline` rather than an error.

```yaml
  - id: porch-camera
    model: wyze-cam-v3
    config: { host: 192.168.50.160, firmware: thingino }
```

```sh
bun run ht secrets set devices.porch-camera.rtsp.username
bun run ht secrets set devices.porch-camera.rtsp.password
bun run ht secrets set devices.porch-camera.web.apiKey
bun run ht porch-camera
# Use the camera page to verify its local connection after configuration.
```

With the web API key on Thingino the camera also offers `setPrivacy` and
these product controls, with readback from its heartbeat API. Availability
depends on the installed firmware and API version:

| Control | Value | What it does |
| --- | --- | --- |
| `readSettings` | – | every control's current value |
| `nightVision.mode` | `auto` / `day` / `night` | automatic by sensor gain, or force a mode |
| `nightVision.irCut` | true/false | IR cut filter |
| `nightVision.irNear`, `nightVision.irFar` | true/false | the 850 nm (visible glow) and 940 nm IR LEDs |
| `video.monochrome` | true/false | black-and-white sensor mode |
| `audio.microphone`, `audio.speaker` | true/false | prudynt audio switches |
| `detection.motion` | true/false | prudynt Motion Guard |

```sh
bun run ht porch-camera read-settings
bun run ht porch-camera night-vision.mode auto
bun run ht porch-camera night-vision.ir-far false
bun run ht porch-camera privacy true
```

### Motion, over HomeTruth's own MQTT broker

This adapter consumes Thingino's "send to MQTT" motion notifications. It does
not depend on ONVIF motion events. HomeTruth provides an embedded broker (see
[Services](API.md#services)) for this path. The server
starts it automatically (`MQTT_PORT`, default `1883`) and every Wyze Cam v3
gets a `motionSensor` capability that goes `online` the moment a message
arrives on its topic and reports `motion: true` for about 15 seconds after
each pulse (Motion Guard is edge-triggered, not level-triggered, so there is
no "motion cleared" message to wait for). `GET /services/mqtt-broker` also
shows every client connect and message published alongside the unified event
bus, useful when a camera's MQTT config is wrong and nothing seems to arrive.

Point the camera at the broker under **Tools → Send to MQTT** in its web UI
(or `POST /x/json-send2.cgi` with the web API key): host is the HomeTruth server's reachable LAN address, port `1883`, topic `thingino/<device id>` (e.g.
`thingino/porch-camera`). Three separate switches all have to be on for a
motion event to actually arrive — it is easy to configure the connection
and still see nothing:

1. `motion.enabled` — Motion Guard itself (HomeTruth's `detection.motion` control).
2. `motion.send2mqtt` — MQTT as a notification target for motion.
3. `mqtt.enabled` plus `mqtt.host`/`port`/`topic` — the connection itself.

```sh
bun run ht porch-camera detection.motion true
```

Excluded on purpose: stock TUTK (cloud keys), two-way talk, and the siren;
the map with routes and verification status is
the model's controls and firmware documentation.
