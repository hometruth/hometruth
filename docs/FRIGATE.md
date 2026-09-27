# Frigate camera labels

HomeTruth can consume Frigate detection and classification events through MQTT.
Configure Frigate and its camera inputs separately; this integration does not
assume a recorder, detector model, frame rate, camera count or retention policy.

Optional features have additional prerequisites:

- **Protect playback:** map Frigate names to UniFi Protect camera IDs to link an
  event to an existing recording. HomeTruth does not copy or proxy that video.
  Recordings must still be within the recorder's retention period. If Protect
  owns the archive, Frigate can perform detection with `record.enabled: false`;
  choose that policy explicitly in Frigate.
- **Frame previews:** configure authenticated SSH access to Frigate's snapshot
  API. Snapshot availability follows Frigate's configuration and retention.
- **REVEAL photo labels:** configure the separate [photo archive and labeling
  worker](REVEAL.md). A version-pinned importer can also populate Frigate's
  Explore gallery with still images and labels, without generating video.

These examples use fictional camera names and identifiers. Keep actual stream
URLs, account details and deployment configuration in your private installation.

## Configuration

Enable HomeTruth's bridge in the private `.hometruth/secrets.yml` vendor settings, using the existing embedded MQTT broker:

```yaml
vendors:
  frigateEvents:
    enabled: true
    topicPrefix: frigate
    cameras:
      front: front-camera
    recordings:
      baseUrl: https://unvr.example.test/protect
      preRollSeconds: 5
      cameras:
        front: "0123456789abcdef01234567"
```

The mapping associates a Frigate camera name with an existing HomeTruth device ID. Unmapped cameras still produce events under `frigate-<camera-name>`. Names must be simple letters, digits, dots, hyphens or underscores. Map only established identities. Enabling the HomeTruth bridge does not create or modify Frigate camera inputs: newly added cameras must also be configured in Frigate.

The optional `recordings` mapping associates those same Frigate names with Protect camera IDs. Set `baseUrl` to the local console's `/protect` URL or its `https://unifi.ui.com/consoles/<console-id>/protect` URL. Use a URL without credentials, query parameters or a fragment. `preRollSeconds` defaults to 5 and accepts 0–60 seconds. Cameras without a recording mapping still emit labels, but have no playback link. REVEAL photo labels link to still photos instead.

Point Frigate's `mqtt.host` and `mqtt.port` at the HomeTruth host and broker, and use the same `topic_prefix`. Configure `stats_interval: 60` so the service can report stale connections and cameras with no frames. Apply changes with Frigate's normal config validation/restart. The private site deployment files record the actual addresses, stream credentials, camera inventory and backups. Do not copy stream credentials into this document.

HomeTruth's current broker is a trusted-LAN service. No new broker port is introduced by this integration. Frigate reconnects if HomeTruth restarts. The bridge consumes data topics. The optional dog announcer independently sends one JPEG every five seconds over SSH to the Frigate host's frame detector; it does not consume video or MQTT state from Frigate. See [Dog announcements](DOG_ANNOUNCEMENTS.md).

Broker shutdown closes client connections before awaiting the TCP listener's close callback. This lets HomeTruth restart while Frigate maintains a persistent MQTT subscription; the reconnect behavior has a real-client regression test.

## Events

Open the Frigate camera labels page from **Services**; its combined video/photo history is available at `/api/services/frigate/events`. Select a configured REVEAL camera in the device filter for still photos, and use **Load older labels** to browse the entire labeled photo archive. **Detection type** checkboxes contain actual object/species labels from all saved history, rather than the application's event-type catalog. Selecting multiple labels matches any of them; leaving everything unchecked shows all labels. Human detections are normalized to **person**, blank classifications to **no detection**, and failed classifications to **unclassified**. Species predictions and generic detections are both searchable. The API returns 100 rows by default (maximum 200) and an optional `nextCursor`; pass it back as `before` with the same `subject` and repeated `label` filters (for example `label=person&label=bobcat`). The response also includes `labelCounts` for the selected camera across all saved history, independent of the checked labels and page cursor. Counts represent label events, not distinct tracked objects. The main checkboxes show types with matches; **No saved detections** lists the remaining known types with zero counts. Selecting a zero-count type keeps an explicit empty result, including when switching cameras. The SSE stream sends `detection-labels` metadata scoped to the camera even when an arriving event does not match the checked labels. The page selections form a reusable [Filter](FILTERS.md) over Event payloads. Give it a name and choose **Save as new filter**; reopen it from **Saved filters**, or update or delete it there. Saved page URLs use the filter’s friendly name, such as `?filter=night-visitors`. **Time of day** adds a daily range in an explicit timezone; 20:00–08:00 crosses midnight. The range uses event timestamps (processing time for photo-label events). Device choices come from the combined video and photo feed, including REVEAL cameras. The API accepts `filter=<id>` for a saved Filter or a JSON `where` condition. Keep that same condition when paging. Filtering happens before result limits, and the same predicate selects live SSE events. Pagination preserves equal timestamps and is not shifted by newer arrivals. The browser keeps loaded pages and lazily loads thumbnails.

Every saved Filter also runs on new video detections and photo-label Events,
even with no browser open. Each match emits a `filter_matched` Event containing
the Filter's identity, revision, and complete source Event. View these under
**Services → Filter matches** or subscribe through the normal event APIs and
MQTT bus. Editing a Filter affects the next event; history reads do not emit
matches. See [live match events](FILTERS.md#live-match-events).

## Detection frame previews

Every video detection and classification row requests Frigate's boxed object snapshot through `/api/services/frigate/frames/:camera/:objectId`. The camera/track pair must occur in HomeTruth's event history. Active tracks use the snapshot API directly: a snapshot can exist before Frigate creates a saved-event database row. The private `vendors.frigateSnapshots` configuration contains `enabled: true`, an absolute `sshConfigPath`, `sshHost`, and the Frigate `container` name. Requests use the existing SSH access to read Frigate's internal API; no public API port or new service is needed.

Snapshots are Frigate's best frame for an object, shared by updates of the same track. The Protect link continues to open video at the individual event time. Keep Frigate snapshots enabled with `bounding_box: true` and `crop: false`; completed events use the image already saved by Frigate, while active events request those options. HomeTruth only caches JPEGs briefly in bounded memory (16 MiB, up to 128 entries); it creates no additional video or image archive. Retention stays with Frigate. If a snapshot is not saved yet, has expired, or cannot be fetched, the result shows an unavailable message and an image retry button.

REVEAL uses its original archived JPEG with thin, unfilled SVG outlines from the saved normalized detection boxes. Images keep their original proportions, including portrait and 4:3 photos; no crop shifts the boxes. Empty detections have no outlines. Clicking a preview opens its source image at full size.

Video results also support an on-demand hover preview: ten 480-pixel-wide recording snapshots requested one second apart, starting two seconds before that row's observed frame time, played at 5× (ten seconds in two seconds). Protect chooses the nearest available frame, so the timestamps are approximate. A recent event can show fewer frames until its recording is available. Missing seconds hold the preceding frame; missing recordings remain explicitly unavailable. REVEAL photos remain stills.

Hover after a short dwell or focus the snapshot link to play; moving away restores the boxed object snapshot. **Play preview** also supports touch and reduced-motion users; **Stop preview** or Escape stops it. Reduced-motion preferences disable automatic playback. Only one preview animates at a time, and leaving it cancels outstanding reads. Historical frames have no boxes because Protect does not provide matching object coordinates; the original snapshot retains its box and the Protect video link remains available.

Historical snapshots require a local Protect account with recording-view permission. Set `UNIFI_PROTECT_USERNAME` and `UNIFI_PROTECT_PASSWORD` in `.env.local`; the existing integration API key cannot authorize `/proxy/protect/api/cameras/:id/recording-snapshot`. Private `vendors.unifiProtect.baseUrl` is the local HTTPS console origin; `skipTlsVerify: true` is only needed for that console's self-signed certificate. Camera IDs reuse `vendors.frigateEvents.recordings.cameras`. Login cookies remain in memory. The internal HomeTruth endpoint `/api/services/frigate/previews/:camera/:objectId?at=<frameTime>` checks the exact camera, track and frame time against saved or live detection metadata before reading the recorder. It accepts no upstream URL or credentials from the browser.

No video is downloaded or recorded by this feature. Frames are fetched on demand and cached briefly in bounded memory: at most two preview requests in flight, 24 MiB/32 previews on the server, and 16 MiB/eight previews per page. Complete previews expire after five minutes; incomplete ones after five seconds. No thumbnail files are written. No Frigate recording or retention settings change. HomeTruth must load the code and environment changes; agents may start or restart the service as needed.

### Missing images or previews

The still image and animated preview use separate sources. A working Protect video link does not establish access to either source: the link opens in the browser's Protect session, while HomeTruth needs its own local Protect login for previews.

| Request | Result | What to check |
| --- | --- | --- |
| `/api/services/frigate/frames/:camera/:objectId` | `404` | The camera/track must be in HomeTruth history and Frigate must still have its snapshot. Frigate can publish a track without saving a snapshot; in 0.17.2, objects that never change position are not saved. Ended tracks without saved images cannot be recovered with **Retry image**. Retention can also remove older images. |
| `/api/services/frigate/frames/:camera/:objectId` | `502` | Check the private snapshot configuration and SSH access to Frigate. |
| `/api/services/frigate/previews/:camera/:objectId?at=<frameTime>` | `503` | Configure the local Protect username/password described above, then load them in the user-run HomeTruth process. If already configured, check the account's recording permission and login. An integration API key alone is insufficient. |
| `/api/services/frigate/previews/:camera/:objectId?at=<frameTime>` | `404` | Check the exact saved camera/track/frame time and the camera's recording mapping and retained footage. |

A missing Frigate snapshot does not prevent **Play preview** from displaying available Protect frames. Preview playback restores the snapshot or its unavailable message when stopped.

## Native Frigate photo gallery

The public Frigate create-event API uses the current camera frame and current time; it cannot upload historical JPEGs. HomeTruth therefore uses a narrow importer tied to **Frigate 0.17.2-3d4dd3a**, installed from `src/vendors/frigate/import_photos.py` to `/config/hometruth/import_photos.py` in Frigate's persistent config volume. It checks the running version, camera configuration, event schema, image hash and event ownership before importing. Upgrading Frigate pauses this queue until the importer is checked against the new version. Inference and HomeTruth events continue independently.

Private HomeTruth configuration:

```yaml
vendors:
  frigatePhotoImport:
    enabled: true
    sshConfigPath: /absolute/path/to/private/ssh_config
    sshHost: frigate
    container: frigate
    cameras:
      trail-camera: trail_photos
```

Configure the mapped photo-only camera (here, `trail_photos`) as disabled for capture and recording. Its required FFmpeg input is a dormant file placeholder; no FFmpeg process runs for it. Reserved label-map IDs 1000–1003 provide the external labels `animal`, `vehicle`, `no detection` and `unclassified` for Explore's filters; the existing detector IDs are preserved. Species appear as native sublabels, with full inference provenance and uncertainty retained in the event data/description. This camera is excluded from HomeTruth's video-feed health count.

Each snapshot has a stable `htp-` event ID derived from its camera and full photo ID, `has_clip=false`, `has_snapshot=true`, and indefinite retention. It creates no synthetic motion MQTT messages or review video segments. Frigate's timeline uses REVEAL's upload timestamp; raw capture text is preserved without assuming its missing timezone. If upload time is absent, the event explicitly identifies its fallback as label-processing time. JPEGs and thumbnails are atomically saved before the event transaction commits. A consistent SQLite backup is created at `/config/hometruth/before-photo-import-0.17.2-3d4dd3a.sqlite` before the first import. This backup covers the database, not media files.

The local archive acknowledges each unchanged result only after remote success. Interrupted batches retry with the same IDs, and newer inference results cannot be acknowledged by an older response. SSH requests are bounded, serial and have timeouts. Progress and retry state appear in the Photo labels service and combined Frigate page. A deliberate native photo deletion is respected until its label result or target changes; to repopulate a restored Frigate database, clear only `nativeResult`/`nativeTarget` acknowledgements in the local `photo_labels` table. Never replace a live Frigate database with the pre-import backup without separately preserving subsequent video-camera events.

Mapped cameras also show labels in their device event view. Object and classification events with a recording mapping show **Watch video in Protect**, which opens in a new tab. The link uses the event's frame time, rather than the start of a possibly long-running track or its MQTT arrival time. Photo labels are also available separately at `/services/photo-labels` and on the corresponding REVEAL device. The combined page subscribes to both sources without duplicating device events or MQTT publications.

| HomeTruth type | Upstream source | Meaning |
| --- | --- | --- |
| `camera_object` | `frigate/events` | A track began, changed, or ended; contains `phase`, `objectId`, camera, label, confidence, times, zones and an optional accepted sublabel. |
| `camera_classified` | `frigate/tracked_object_update` with type `classification` | An enabled Frigate custom classifier added a sublabel or attribute to a track. |
| `photo_labeled` | Saved REVEAL labels | A historical or newly imported photo received labels; includes detections, wildlife classification when available, uncertainty and source times. |

The normalized MQTT topic is `hometruth/events/<subject>/<type>`. Each payload is a `ServiceEvent` JSON object:

```json
{
  "at": "2026-09-11T20:00:03.000Z",
  "level": "info",
  "type": "camera_object",
  "subject": "front-camera",
  "message": "front: person (97%) · new · 1789156801-example",
  "data": {
    "source": "frigate",
    "objectId": "1789156801-example",
    "camera": "front",
    "phase": "new",
    "label": "person",
    "confidence": 0.97,
    "frameTime": 1789156803,
    "startTime": 1789156801,
    "recordingUrl": "https://unvr.example.test/protect/timelapse/0123456789abcdef01234567?start=1789156798000",
    "recordingStartTime": 1789156798000,
    "currentZones": [],
    "enteredZones": []
  }
}
```

For live video events, `at` is publication time; photo label history uses the result's `processedAt` so its position remains stable across restarts. Frigate `startTime`, `frameTime` and optional `endTime` are Unix **seconds**. Optional `recordingStartTime` is Unix **milliseconds**, including the configured pre-roll. `recordingUrl` is generated from the private camera mapping and also travels with the normalized MQTT event; arbitrary links in Frigate's upstream payload are ignored. Photo `uploadedAt` and `processedAt` are Unix **milliseconds**; optional `capturedAt` preserves the camera's unzoned local text. A historical `photo_labeled` event is not live motion. Consumers should use the type and source times accordingly.

An `objectId` identifies a Frigate track, not a recognized individual or a persistent identity across cameras. Available labels depend on the configured detector and classifiers. The bridge does not enable face recognition, license-plate recognition, custom classifiers or a different video detector. It relays custom classification consensus if those classifiers are configured separately. Raw face-attempt messages are not treated as accepted identities.

Only declared metadata fields cross the bridge. Raw thumbnails, image bytes and arbitrary upstream payload fields do not. Malformed and false-positive object messages are ignored. Identical stream events are deduplicated against the recent cache and saved history, including across restarts; useful updates retain the same track ID.

## Delivery and history

Stream events use HomeTruth's existing service fan-out and non-retained MQTT QoS 0 messages. They are live delivery, not a durable subscriber queue. HomeTruth saves the most recent 10,000 normalized label events in `.hometruth/frigate/events.sqlite` (override with `HOMETRUTH_FRIGATE_HISTORY`). Only metadata is saved. The service reads its recent backlog from this database, so labels and recording links survive server restarts. Camera filters include all configured cameras and filter the saved history before limiting results. No events is different from no video: the service status reports cameras with zero frames; a quiet camera need not produce object labels.

The live bridge does not automatically fetch detections missed while HomeTruth was unavailable. To recover Frigate's retained history, obtain its `/api/events` JSON response and run:

```sh
# From the private installation directory; adjust the source path if needed:
bun ../hometruth/src/vendors/frigate/import-history.ts /path/to/frigate-events.json
```

The importer validates object metadata, skips tracks already saved, and writes only the local history. It never republishes past detections as live MQTT events. Imported rows say **Previously detected**, have `data.historical: true`, and retain the track's original start time in `at` and `frameTime`. Their playback links start at that time minus pre-roll because REST history does not include the original MQTT frame timestamp. A page refresh shows an import immediately, with no server restart required.

Photo results and their publication acknowledgements persist in the REVEAL SQLite archive. Results already present when this feature is enabled are also published. A failed broker publication stays queued; a restart resumes pending work. Publication is acknowledged only for the exact result sent, so a newer inference cannot be accidentally acknowledged. A crash between sending and acknowledging can cause a repeat: consumers deduplicate by `data.eventId`. Reclassification produces a different event ID.

The broker callback acknowledges local publication, not receipt by every MQTT subscriber. Subscribers offline during publication can use the photo archive or combined history API. Photo history is read directly from the original REVEAL SQLite archive and has no 10,000-event cap; the combined view does not copy photos or results into the video-event database. Previously acknowledged photo results and saved video history are never replayed onto MQTT merely because HomeTruth restarts.

References: [Frigate MQTT](https://docs.frigate.video/integrations/mqtt/), [recording configuration](https://docs.frigate.video/configuration/record/), [snapshots](https://docs.frigate.video/configuration/snapshots/), [SpeciesNet](https://github.com/google/cameratrapai), [REVEAL archive and labeling](REVEAL.md).
