# Dog announcements

Configuration and runtime paths in this guide are relative to your private
installation directory. Examples use fictional device names and addresses.
See [repository layout](REPOSITORIES.md) for command and storage conventions.

Open `/automations/dog-announcer` and select your camera and speaker.
The automation starts disabled with no devices selected. When enabled and a
frame contains any dog, the selected speaker says the configured text (default **OUT**).
Coat color, breed and identity do not filter the result. Cats and other objects
do not trigger speech.

This integration requires a configured UniFi Protect restream, a speech-capable
standalone speaker, and the frame worker described below. HomeTruth checks a
fresh JPEG every five seconds and sends it over configured SSH transport to an
inference subprocess inside a Frigate container. The current worker uses a
YOLOv9-s detector at 640×640 through an OpenVINO NPU; it is not a generic
detector for every host or camera source.
It returns only `dog: true` or `dog: false`, bound to the submitted JPEG's SHA-256
hash. It checks the full frame, then overlapping crops if needed, stopping as
soon as a dog scores at least 0.7. It does not count dogs or return boxes, breed,
identity or unrelated object labels. Images are neither stored nor sent to a
cloud provider. The subprocess keeps the
model loaded between requests, avoiding SSH and model startup on every frame.

The rule does not require a Frigate video camera, MQTT state, or tracked events.
Optional Frigate video labels and REVEAL wildlife labels operate independently.
A REVEAL camera is not a prerequisite for this automation.

## Timing and failures

Capture emits one JPEG per second. Only the newest complete frame is retained;
checks consume a frame once and never queue historical frames. Checks start on a
fixed five-second cadence. Slow checks skip ticks without overlap or catch-up
bursts. A frame older than 1.5 seconds at submission, or 3 seconds when inference
finishes, cannot trigger speech. Capture startup can take several seconds.
Each remote inference is limited to five seconds. The pipe accepts one request
at a time: a four-byte big-endian JPEG length, followed by those bytes, returning
one bounded JSON line containing `dog` and `imageHash`. The process exits when its input closes or after 15 seconds
without a frame.

The first positive check speaks immediately. One five-second cooldown covers
all dogs, failed speech attempts and settings changes. The cooldown runs from
completion of the previous speech request, so varying speaker latency cannot
compress spoken phrases. A dog remaining in view can trigger another announcement
after five seconds. Speaker requests run independently of detection.
Pausing, saving settings or stopping cancels pending detection and releases capture.

Unavailable frames and failed, late or mismatched detector replies stay silent.
Retries continue, but each outage produces one error and one recovery event.
Speaker failures are tracked separately. The latest result shows frame time,
image hash, processing duration and a binary dog/no-dog result. Detection is probabilistic:
very dark or obscured animals can be missed.

## Preview and speaker

The page shows a live camera preview from the same Protect restream
(`vendors.unifiProtect.streams.<cameraId>` in the private secrets store).
It starts automatically, follows the selected camera, and supports pause,
resume, refresh and **Open camera**. It stops when the page is hidden or closed.
The preview is independent of detection and the announcement cooldown.
Source URLs and credentials stay on the server.

The selected speaker must support speech and be standalone so an announcement
does not propagate to other members of a speaker group. Speech uses its current volume and replaces playback. The volume slider
applies changes immediately; silent checks never speak or affect the cooldown.

## Deployment

The main Frigate container needs these files in its persistent `/config` mount:

- `/config/hometruth/frame_label.py`: copy `src/vendors/frigate/stills/frame_label.py`.
- `/config/hometruth/yolov9-s-640.onnx`: YOLOv9 small, converted weights, static
  640×640 input, ONNX opset 12. Export using the [Frigate model instructions](https://docs.frigate.video/configuration/object_detectors/#openvino-detector)
  with `MODEL_SIZE=s` and `IMG_SIZE=640`.

The reference model export uses WongKinYiu/yolov9 commit
`5b1ea9a8b3f0ffe4fe0e203ec6232d788bb3fcff`, release `v0.1` converted small weights.
The combined model and COCO label-map SHA-256 is
`b0761c5d47327658b32738e89305b3ca9adffc4ea17e6aca79f93429cb69c9e9`.
The Frigate image supplies OpenVINO, OpenCV, NumPy and
`/labelmap/coco-80.txt`. NPU compilation is cached under
`/config/model_cache/hometruth-frames`. Warm the model once after deployment;
initial compilation may exceed the live request deadline. No additional network listener or separately managed service is started.

Configure `vendors.frigateFrames` in the private secret store:

```yaml
enabled: true
sshConfigPath: /absolute/path/to/ssh_config
sshHost: frigate
container: frigate
```

The configured SSH identity must permit noninteractive `sudo docker exec`.
`vendors.frigateStills` remains REVEAL's independent worker configuration.

## Settings and API

The private launcher uses `dog-announcer.json` when present; otherwise settings
are saved in `.hometruth/dog-announcer.json`. Fields: `enabled`, `cameraId`,
`speakerId`, `text`, `intervalMs: 5000`, and `cooldownMs: 5000`.

- `GET /api/automations/dog-announcer`: settings, status, latest result and device choices.
- `PUT /api/automations/dog-announcer`: save settings.
- `PUT /api/automations/dog-announcer/enabled`: persist `{ "enabled": true }` or `false`.
- `POST /api/automations/dog-announcer/preview`: silently analyze a fresh frame using supplied settings.
- `GET /api/automations/dog-announcer/stream.mjpeg?cameraId=<camera-id>`: live preview.

`dog_detected` and `dog_announced` events include source `frigate`, the camera
device ID. Announcements add the speaker ID and text. They appear
in the service and device logs and on the existing MQTT event bus.
