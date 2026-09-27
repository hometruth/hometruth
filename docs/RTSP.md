# Local RTSP cameras

The `rtsp-camera` model accepts a local RTSP stream independently of the
camera's manufacturer. It provides browser video and JPEG snapshots through
HomeTruth's ffmpeg media bridge. Install `ffmpeg` on the HomeTruth host and
ensure it can reach the camera and decode its video codec.

Add an entry to your private installation's `devices.yml`. For example,
`rtsp://192.168.50.170:8554/live` becomes:

```yaml
  - id: yard-camera
    name: Yard camera
    model: rtsp-camera
    config:
      host: 192.168.50.170
      port: 8554
      path: /live
      timeoutMs: 3000
```

`host` and `path` are required. The port defaults to 554 and the reachability
timeout to 3000 ms. Hosts must be private LAN addresses or `.local` names.
The path starts with `/` and may include nonsecret query parameters. This
model supports plain RTSP over TCP; RTSPS is not supported.

For a stream requiring authentication, enter its credentials through the
secret prompts:

```sh
bun run site ../hometruth_private ht secrets set devices.yard-camera.rtsp.username
bun run site ../hometruth_private ht secrets set devices.yard-camera.rtsp.password
bun run site ../hometruth_private check
```

Keep passwords and signed stream URLs out of the inventory. Streams requiring
tokens in the path or query need a separate integration.

Status uses an unauthenticated RTSP `OPTIONS` request. A successful reply
enables media controls; a 401 challenge also enables them when credentials are
configured. Opening video or a snapshot verifies playback and authentication.
An unreachable endpoint is offline; other RTSP errors or a challenge without
credentials are degraded. An OPTIONS reply alone does not prove that the
configured media path exists or that the stored password works.

This model does not identify the hardware or provide pan/tilt, privacy, motion
events, audio, recording, reboot or firmware controls. Use a supported product
model when those capabilities are required. The user's running development
server loads configuration changes; otherwise restart it from your terminal.
